#!/usr/bin/env node
/**
 * OFFLINE battery for task #947 — multi-value fields ("Several values" on a
 * Choice / Targeted KB field) and their {{dc:…}} injection.
 *
 *   node scripts/test-multi-value-fields.js
 *
 * No database, no network, no keys: db.pg / history / run store / usage
 * logger are stubs (db.pg throws on use, DB_HOST is dead), and the model
 * client is a fake that returns the JSON a case sets. Runs the REAL
 * assembler, condition matcher, formula evaluator, Rules plugin and
 * addonRunner (enum guard, memory writes, the run's `targetedKb` record).
 *
 * Exits 1 on any failure.
 */
const path = require('path');
const SERVER = path.join(__dirname, '..');
process.env.DB_HOST = '127.0.0.255';
process.env.DATABASE_URL = 'postgres://dead:dead@127.0.0.255:1/dead';
process.env.ANTHROPIC_API_KEY = 'sk-ant-offline-test';
process.env.OPENAI_API_KEY = 'sk-offline-test';
process.env.GEMINI_API_KEY = 'offline-test';

// ── stubs for everything that would touch a database ──
function stub(rel, exportsObj) {
  const file = require.resolve(path.join(SERVER, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
const dbTouches = [];
stub('services/db.pg.js', new Proxy({}, {
  get(_, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    return () => { dbTouches.push(String(prop)); throw new Error(`DB stub: ${String(prop)} called`); };
  },
}));
stub('builder/runtime/historyService.js', {
  loadHistory: async () => ({ messages: [], resolution: { requested: 'none', effective: 'none' } }),
});
const persistedRuns = [];
stub('builder/runtime/addonRunsStore.js', { insertRun: async (r) => { persistedRuns.push(r); } });
stub('services/usageLogger.js', { logUsage: () => {}, logWebSearches: () => {} });

// ── fake Anthropic client: answers with whatever `nextModelText` holds ──
let nextModelText = '{}';
const captured = [];
function anthropicReply(text) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } };
      yield { type: 'message_stop' };
    },
    async finalMessage() {
      return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}
const fakeAnthropic = {
  messages: {
    stream(params) { captured.push(params); return anthropicReply(nextModelText); },
    async create(params) {
      captured.push(params);
      return { content: [{ type: 'text', text: nextModelText }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  },
};
fakeAnthropic.beta = { messages: fakeAnthropic.messages };
const claude = require(path.join(SERVER, 'services/llm.claude.js'));
claude._clientFor = () => fakeAnthropic;
const llm = require(path.join(SERVER, 'services/llm.js'));
require(path.join(SERVER, 'builder/plugins/thinker/addon.thinker.js'));
require(path.join(SERVER, 'builder/plugins/rules/addon.rules.js'));
const { runAddon } = require(path.join(SERVER, 'builder/runtime/addonRunner.js'));
const { assemblePrompt } = require(path.join(SERVER, 'builder/runtime/promptAssembler.js'));
const { evaluateCondition } = require(path.join(SERVER, 'builder/runtime/conditionMatcher.js'));
const formulaEval = require(path.join(SERVER, 'builder/runtime/formulaEval.js'));
const builderMemory = require(path.join(SERVER, 'builder/runtime/builderMemory.js'));
const mv = require(path.join(SERVER, 'builder/runtime/multiValue.js'));
// The runner persists the brain blob after a run — no database here.
builderMemory.saveMemory = async () => {};

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};
const section = t => console.log(`\n── ${t} ──`);

// ── A small agent: a Targeted KB of motives, one multi field, one single ──
const MOTIVES = {
  id: 'enum_motives',
  name: 'motives_kb',
  sections: [{ name: 'path' }, { name: 'knowledge' }],
  values: [
    { id: 'v1', value: 'business', umbrellaText: 'U-business', sectionTexts: { path: 'P-business', knowledge: 'K-business' } },
    { id: 'v2', value: 'savings', umbrellaText: 'U-savings', sectionTexts: { path: 'P-savings', knowledge: 'K-savings' } },
    { id: 'v3', value: 'kids', umbrellaText: 'U-kids', sectionTexts: { path: 'P-kids' } },
    { id: 'v4', value: 'retired', umbrellaText: 'U-retired', sectionTexts: { path: 'P-retired' }, enabled: false },
  ],
};
const F_MULTI = { id: 'f_multi', name: 'motives', type: 'enum', enumType: 'enum_motives', source: 'explicit', howToExtract: 'every motive', multiple: true };
const F_SINGLE = { id: 'f_single', name: 'primary_motive', type: 'enum', enumType: 'enum_motives', source: 'explicit', howToExtract: 'the main motive' };
const F_PINNED = { id: 'f_pin', name: 'pinned_motive', type: 'enum', enumType: 'enum_motives', source: 'pinned', howToExtract: '', multiple: true };
const FIELDS = [F_MULTI, F_SINGLE, F_PINNED];

function assemble(template, mem, extra = {}) {
  const resolved = [];
  const text = assemblePrompt({
    instance: { pluginId: 'thinker', promptTemplate: template, config: {} },
    personas: [],
    memoryValuesByDomain: () => ({}),
    memoryDomainList: () => [],
    thinkingValuesByDomain: () => ({}),
    thinkingDomainList: () => [],
    fieldValueOf: name => mem[name],
    extractorFields: extra.extractorFields || [],
    parameters: [],
    enums: [MOTIVES],
    fieldsForDc: FIELDS,
    onEnumResolved: () => {},
    onDcResolved: r => resolved.push(r),
    summaries: {},
    snippets: [],
    brain: { memory: {} },
  });
  return { text, resolved };
}

(async () => {
  section('multiValue helpers');
  check('isMultiField: enum + multiple', mv.isMultiField(F_MULTI));
  check('isMultiField: single enum → false', !mv.isMultiField(F_SINGLE));
  check('isMultiField: pinned ignores the flag', !mv.isMultiField(F_PINNED));
  check('isMultiField: string field with multiple → false', !mv.isMultiField({ type: 'string', multiple: true, source: 'explicit' }));
  check('valuesOf: string → list of one', JSON.stringify(mv.valuesOf('a')) === '["a"]');
  check('valuesOf: empty / null → []', mv.valuesOf('').length === 0 && mv.valuesOf(null).length === 0);
  check('orderByEnum: enum order + de-dup', JSON.stringify(mv.orderByEnum(['kids', 'business', 'kids'], MOTIVES)) === '["business","kids"]');

  section('{{dc:…}} on a multi-value field');
  {
    const { text, resolved } = assemble('X\n{{dc:motives:path}}\nY', { motives: ['savings', 'business'] });
    check('section form: one headed block per selected value, enum order',
      text === 'X\n### business — path\nP-business\n\n### savings — path\nP-savings\nY', JSON.stringify(text));
    check('section form: unselected values are not injected', !text.includes('P-kids'));
    check('dc.resolved carries the selection + rendered values',
      resolved.length === 1 && resolved[0].multiple === true
      && JSON.stringify(resolved[0].values) === '["business","savings"]'
      && JSON.stringify(resolved[0].matched) === '["business","savings"]');
  }
  {
    const { text } = assemble('{{dc:motives}}', { motives: ['kids'] });
    check('umbrella form: headed even with one value', text === '### kids\nU-kids', JSON.stringify(text));
  }
  {
    const { text } = assemble('{{dc:motives:*}}', { motives: ['business', 'kids'] });
    check('* form: values with #### section blocks',
      text === '### business\n#### path\nP-business\n\n#### knowledge\nK-business\n\n### kids\n#### path\nP-kids', JSON.stringify(text));
  }
  {
    const { text, resolved } = assemble('{{dc:motives:knowledge}}', { motives: ['business', 'kids'] });
    check('a selected value with no body for the slot is left out', text === '### business — knowledge\nK-business', JSON.stringify(text));
    check('…and is listed as selected but not injected',
      JSON.stringify(resolved[0].values) === '["business","kids"]' && JSON.stringify(resolved[0].matched) === '["business"]');
  }
  {
    const { text } = assemble('{{dc:motives:path}}', { motives: ['retired', 'savings'] });
    check('a disabled value is never injected', text === '### savings — path\nP-savings', JSON.stringify(text));
  }
  {
    const { text, resolved } = assemble('A{{dc:motives:path}}B', {});
    // Same as an empty single-value lookup (dc is a block token).
    const { text: emptySingle } = assemble('A{{dc:primary_motive:path}}B', {});
    check('nothing selected → empty, exactly like an empty single field', text === emptySingle && !/[PU]-/.test(text), JSON.stringify(text));
    check('nothing selected → matched null', resolved[0].matched === null);
  }
  {
    const { text } = assemble('{{dc:motives:path}}', { motives: 'savings' });
    check('a stored single value reads as a list of one (switching needs no migration)', text === '### savings — path\nP-savings', JSON.stringify(text));
  }
  {
    const { text } = assemble('{{field:motives}} | {{field:primary_motive}}', { motives: ['business', 'savings'], primary_motive: 'kids' });
    check('{{field:}} on a multi field reads "a, b"; single unchanged', text === 'business, savings | kids', JSON.stringify(text));
  }

  section('single-value fields are unchanged');
  {
    const { text, resolved } = assemble('{{dc:primary_motive:path}}', { primary_motive: 'savings' });
    check('single field: bare body, no heading', text === 'P-savings', JSON.stringify(text));
    check('single field: dc.resolved has no multiple/values', resolved[0].multiple === undefined && resolved[0].values === undefined && resolved[0].matched === 'savings');
    const { text: t2 } = assemble('{{dc:primary_motive:*}}', { primary_motive: 'kids' });
    check('single field * form unchanged', t2 === '### path\nP-kids', JSON.stringify(t2));
    const { text: t3 } = assemble('{{dc:pinned_motive}}', { pinned_motive: 'business' });
    check('pinned field with the flag behaves as single', t3 === 'U-business', JSON.stringify(t3));
  }

  section('{{fields_schema}} line');
  {
    const { text } = assemble('{{fields_schema}}', {}, { extractorFields: [F_MULTI, F_SINGLE] });
    const lines = text.split('\n');
    check('multi field says multiple=true', lines[0] === '- motives (type=enum, values=[business, savings, kids], multiple=true, source=explicit): every motive', lines[0]);
    check('…and how to write it (full list, [] clears)', /JSON array of EVERY value.*\[\] clears it/.test(lines[1] || ''));
    check('single field line unchanged', lines[2] === '- primary_motive (type=enum, values=[business, savings, kids], source=explicit): the main motive', lines[2]);
  }

  section('conditions on a multi-value field (contains)');
  const blob = { memory: { _general: { motives: ['business', 'savings'], primary_motive: 'kids' } } };
  const cond = (op, extra) => evaluateCondition(blob, { type: 'field', field: 'motives', op, ...extra }, {});
  check('equals X = X is selected', cond('equals', { value: 'savings' }).ok);
  check('equals Y (not selected) → false', !cond('equals', { value: 'kids' }).ok);
  check('not-equals Y (not selected) → true', cond('not-equals', { value: 'kids' }).ok);
  check('not-equals X (selected) → false', !cond('not-equals', { value: 'business' }).ok);
  check('in = includes any of', cond('in', { values: ['kids', 'business'] }).ok);
  check('in, none of them → false', !cond('in', { values: ['kids', 'retired'] }).ok);
  check('not-in = includes none of', cond('not-in', { values: ['kids', 'retired'] }).ok);
  check('not-in with one selected → false', !cond('not-in', { values: ['kids', 'savings'] }).ok);
  check('is-not-null with a selection', cond('is-not-null').ok);
  check('is-null on an empty list', evaluateCondition({ memory: { _general: { motives: [] } } }, { type: 'field', field: 'motives', op: 'is-null' }, {}).ok);
  // The run card's "why" line uses the editor's words on a list.
  const DOESNT = "doesn't include";
  check('why: equals on a list says "includes"', cond('equals', { value: 'savings' }).why === 'motives=["business","savings"] includes "savings"', cond('equals', { value: 'savings' }).why);
  check('why: a failed equals says "doesn\'t include"', cond('equals', { value: 'kids' }).why === `motives=["business","savings"] ${DOESNT} "kids"`, cond('equals', { value: 'kids' }).why);
  check('why: not-equals reads the same facts, never "equals"', cond('not-equals', { value: 'kids' }).why.endsWith(`${DOESNT} "kids"`) && !/equals/.test(cond('not-equals', { value: 'kids' }).why));
  check('why: in / not-in say "includes any of" / "includes none of"',
    cond('in', { values: ['kids'] }).why.includes('includes any of') && cond('not-in', { values: ['kids'] }).why.includes('includes none of'));
  check('why: single field keeps "equals"', /equals/.test(evaluateCondition(blob, { type: 'field', field: 'primary_motive', op: 'equals', value: 'kids' }, {}).why));
  check('single field equals unchanged', evaluateCondition(blob, { type: 'field', field: 'primary_motive', op: 'equals', value: 'kids' }, {}).ok);
  check('fields-collected: empty list counts as missing',
    !evaluateCondition({ memory: { _general: { motives: [] } } }, { type: 'fields-collected', fields: ['motives'] }, {}).ok);
  const f1 = formulaEval.evaluate('{{motives}}.includes("savings") && {{motives}}.length == 2', n => builderMemory.findFieldValue(blob, n, 'memory'));
  check('formula: the field is a real array', f1.ok && f1.value === true, JSON.stringify(f1));
  const f2 = formulaEval.evaluate('{{primary_motive}} == "kids" ? ["business", "kids"] : []', n => builderMemory.findFieldValue(blob, n, 'memory'));
  check('formula may produce a list (sets a multi field)', f2.ok && JSON.stringify(f2.value) === '["business","kids"]', JSON.stringify(f2));

  section('writes through the real runner (enum guard + memory + run record)');
  function ctxWith(memory, events) {
    return {
      runnable: { agent: { body: { fields: FIELDS, enums: [MOTIVES] } }, crew: { body: { fields: [] } } },
      agentSlug: 'offline-test', ownerUserId: 1, userId: 1,
      conversationId: 123, assistantMessageId: 456,
      userMessage: 'hi', crewLabel: 'Main', agentNameForLogs: 'offline-test',
      agentPersonas: [], agentParameters: [], agentEnums: [MOTIVES],
      memory,
      memoryValuesByDomain: () => ({}), memoryDomainList: () => [],
      thinkingValuesByDomain: () => ({}), thinkingDomainList: () => [],
      retrievalValueOf: () => '',
      fieldValueOf: name => builderMemory.findFieldValue(memory, name, 'memory'),
      drizzle: null, convRow: { id: 123, metadata: {} },
      emit: (type, payload) => events.push({ type, payload }),
      llm, logUsage: () => {}, resolveModelLabel: () => 'model',
      historyExcludeFromMessageId: 456, historyCache: new Map(),
    };
  }
  async function runThinker(memory, modelJson, template = 'Brief: {{dc:motives:path}}') {
    nextModelText = JSON.stringify(modelJson);
    const events = [];
    persistedRuns.length = 0;
    await runAddon({
      ctx: ctxWith(memory, events),
      instance: {
        instanceId: 'inst-thinker', pluginId: 'thinker', lane: 'main', outputType: 'json-to-memory',
        promptTemplate: template, context: { history: { mode: 'none' } },
        config: { name: 'T', model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' }, prompt: template, domain: 'strategy' },
      },
    });
    const errs = events.filter(e => e.type === 'addon.error');
    if (errs.length) console.log('   addon.error:', JSON.stringify(errs.map(e => e.payload.error)));
    return { out: events.find(e => e.type === 'addon.output')?.payload, events };
  }
  async function runRules(memory, rules) {
    const events = [];
    await runAddon({
      ctx: ctxWith(memory, events),
      instance: {
        instanceId: 'inst-rules', pluginId: 'rules', lane: 'main', outputType: 'json-to-memory',
        promptTemplate: '', context: { history: { mode: 'none' } },
        config: { name: 'R', rules, extractsFields: ['f_multi'] },
      },
    });
    return events.find(e => e.type === 'addon.output')?.payload;
  }
  const memOf = m => builderMemory.findFieldValue(m, 'motives', 'memory');

  {
    const memory = builderMemory.normalizeBlob({});
    const { out } = await runThinker(memory, { motives: ['Savings', 'business', 'nonsense'] });
    check('write: members coerced to the canonical spelling, stored in enum order',
      JSON.stringify(memOf(memory)) === '["business","savings"]', JSON.stringify(memOf(memory)));
    check('write: a wrong member is dropped and shown under rejectedWrites',
      out && Array.isArray(out.rejectedWrites) && JSON.stringify(out.rejectedWrites[0].value) === '["nonsense"]', JSON.stringify(out && out.rejectedWrites));
    check('write: the run card shows the list written',
      out && out.memoryWrites.some(w => w.field === 'motives' && JSON.stringify(w.value) === '["business","savings"]'));

    // Next run: the prompt injects BOTH selected values; the run records it.
    const second = await runThinker(memory, {});
    const sentSystem = JSON.stringify(captured[captured.length - 1].system);
    check('next run: both selected values are injected, headed by value',
      sentSystem.includes('### business — path\\nP-business') && sentSystem.includes('### savings — path\\nP-savings') && !sentSystem.includes('P-kids'));
    const tkb = second.out && second.out.targetedKb;
    check('run records targetedKb: field, section, values, injected, text',
      Array.isArray(tkb) && tkb.length === 1 && tkb[0].fieldName === 'motives' && tkb[0].section === 'path'
      && JSON.stringify(tkb[0].values) === '["business","savings"]' && JSON.stringify(tkb[0].injected) === '["business","savings"]'
      && tkb[0].text.includes('P-savings') && tkb[0].multiple === true, JSON.stringify(tkb));
    check('targetedKb is persisted with the run (survives a reload)',
      persistedRuns.length === 1 && Array.isArray(persistedRuns[0].runData.targetedKb));

    // Remove a value: the whole new list replaces the old one.
    await runThinker(memory, { motives: ['savings'] });
    check('remove: writing the list without a value drops it', JSON.stringify(memOf(memory)) === '["savings"]', JSON.stringify(memOf(memory)));
    await runThinker(memory, {});
    const sys2 = JSON.stringify(captured[captured.length - 1].system);
    check('remove: its context is gone on the next run', !sys2.includes('P-business') && sys2.includes('P-savings'));

    // Leaving the key out changes nothing.
    await runThinker(memory, { other: 1 });
    check('key left out → selection unchanged', JSON.stringify(memOf(memory)) === '["savings"]');

    // All-wrong write: rejected, the old selection stays (like a single field).
    await runThinker(memory, { motives: ['nonsense'] });
    check('only wrong members → nothing written, old selection stays', JSON.stringify(memOf(memory)) === '["savings"]');

    // [] clears.
    const cleared = await runThinker(memory, { motives: [] });
    check('[] clears the field', memOf(memory) === undefined, JSON.stringify(memOf(memory)));
    check('…recorded as a clear write', cleared.out.memoryWrites.some(w => w.field === 'motives' && w.clear === true));
    await runThinker(memory, {});
    const sys3 = JSON.stringify(captured[captured.length - 1].system);
    check('cleared: no stale context on the next run', !sys3.includes('P-savings') && !sys3.includes('P-business'));

    // A plain string to a multi field = a list of one.
    await runThinker(memory, { motives: 'kids' });
    check('a single string becomes a list of one', JSON.stringify(memOf(memory)) === '["kids"]');
  }
  {
    // Single-value field: the guard behaves exactly as before.
    const memory = builderMemory.normalizeBlob({});
    const { out } = await runThinker(memory, { primary_motive: 'SAVINGS' }, 'Plain prompt');
    check('single field: case-coerced string, as before',
      builderMemory.findFieldValue(memory, 'primary_motive', 'memory') === 'savings');
    const { out: out2 } = await runThinker(memory, { primary_motive: 'nope' });
    check('single field: a wrong value is rejected, old value stays',
      builderMemory.findFieldValue(memory, 'primary_motive', 'memory') === 'savings'
      && out2.rejectedWrites && out2.rejectedWrites[0].value === 'nope');
    check('single field: no targetedKb when the prompt has no dc token', out && out.targetedKb === undefined);
  }
  {
    // Rules: Set to a list (whole selection) and Clear.
    const memory = builderMemory.normalizeBlob({ memory: { _general: { motives: ['business'] } } });
    await runRules(memory, [{ id: 'r1', conditions: [{ type: 'field', field: 'motives', op: 'equals', value: 'business' }],
      actions: [{ type: 'set', field: 'motives', value: ['kids', 'savings'] }] }]);
    check('Rules Set with a list replaces the selection (enum order)', JSON.stringify(memOf(memory)) === '["savings","kids"]', JSON.stringify(memOf(memory)));
    await runRules(memory, [{ id: 'r2', conditions: [{ type: 'field', field: 'motives', op: 'in', values: ['kids'] }],
      actions: [{ type: 'clear', field: 'motives' }] }]);
    check('Rules Clear empties it', memOf(memory) === undefined);
  }

  check('no database was touched', dbTouches.length === 0, dbTouches.join(', '));

  console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
