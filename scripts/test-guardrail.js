#!/usr/bin/env node
/**
 * Battery for the Guardrail add-on (task #963) — fully OFFLINE: no database,
 * no network, no model. Runs the REAL chain (BuilderRunner.runChainSteps) →
 * REAL runner (addonRunner) → REAL Talker / Guardrail plugins, with a fake
 * `llm` that streams a scripted reply and returns scripted verdicts. The DB
 * module, history, run store and usage logger are stubs in `require.cache`.
 *
 *   node scripts/test-guardrail.js
 *
 *   A. the plugin's reading of its config + the "Your verdict" section
 *   B. {{reply}} in the prompt assembler
 *   C. the chain: hold OFF (flag only, the reply streams) / hold ON (held,
 *      approve / replace / block + escalation) / fail closed / fail open /
 *      an action it may not take / before the Talker / a disabled Guardrail
 *   D. the offline lane — always a flag
 *   E. a Guardrail with no valid verdict is a failed run (no_verdict)
 *
 * Exits 1 on any failure.
 */

const path = require('path');
const SERVER = path.join(__dirname, '..');
process.env.DB_HOST = '127.0.0.255';
process.env.DATABASE_URL = 'postgres://dead:dead@127.0.0.255:1/dead';

let fails = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) passes++; else fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? ` — ${extra}` : ''}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

// ── stubs ──
function stub(rel, exportsObj) {
  const file = require.resolve(path.join(SERVER, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
const metaWrites = [];
function chain() {
  const op = {};
  const c = {
    update() { op.kind = 'update'; return c; },
    set(v) { op.set = v; return c; },
    where() { return c; },
    returning() { return c; },
    insert() { op.kind = 'insert'; return c; },
    values() { return c; },
    select() { return c; },
    from() { return c; },
    limit() { return c; },
    then(resolve) { if (op.kind === 'update') metaWrites.push(op.set); return resolve([]); },
  };
  return c;
}
stub('services/db.pg.js', { getDrizzle: () => chain(), query: async () => ({ rows: [] }), initialize: async () => {} });
stub('builder/runtime/historyService.js', {
  loadHistory: async () => ({ messages: [], resolution: { requested: 'none', effective: 'none' } }),
});
stub('builder/runtime/addonRunsStore.js', { insertRun: async () => {}, attachRunsToMessage: async () => {} });
stub('services/usageLogger.js', { logUsage: () => {}, logWebSearches: () => {} });

const { runChainSteps } = require(path.join(SERVER, 'builder/runtime/BuilderRunner.js'));
const { runAddon, outputFailureOf } = require(path.join(SERVER, 'builder/runtime/addonRunner.js'));
const { assemblePrompt } = require(path.join(SERVER, 'builder/runtime/promptAssembler.js'));
const g = require(path.join(SERVER, 'builder/plugins/guardrail/addon.guardrail.js'));

// ── the fake model ──
const TALKER_REPLY = 'Your mortgage is approved at 2.1%.';
let verdictScript = [];   // what each Guardrail call returns, in order
const prompts = [];       // system prompts the Guardrail got
let streamCalls = 0;
const fakeLlm = {
  sendMessageStreamWithPrompt(_message, _conv, _config) {
    streamCalls++;
    return (async function* gen() {
      yield 'Your mortgage ';
      yield 'is approved at 2.1%.';
      yield { type: 'usage', inputTokens: 5, outputTokens: 7, durationMs: 3 };
    })();
  },
  async sendOneShot(system) {
    prompts.push(system);
    const next = verdictScript.length ? verdictScript.shift() : '{"verdict":"approve","reason":"ok"}';
    return { text: next, stopReason: 'end_turn', usage: {} };
  },
};

function makeCtx(events, crew = 'crew_main') {
  return {
    runnable: { agent: { body: {} }, crew: { id: crew, body: { fields: [] } } },
    agentSlug: 'zz-guardrail', ownerUserId: 1, userId: 1,
    conversationId: 77, assistantMessageId: 88,
    userMessage: 'Am I approved?',
    crewLabel: 'Main', agentNameForLogs: 'zz-guardrail',
    agentPersonas: [], agentParameters: [], agentEnums: [],
    memory: {},
    memoryValuesByDomain: () => ({}), memoryDomainList: () => [],
    thinkingValuesByDomain: () => ({}), thinkingDomainList: () => [],
    retrievalValueOf: () => undefined, fieldValueOf: () => undefined,
    drizzle: chain(), convRow: { id: 77, metadata: {} },
    isStopped: () => false,
    emit: (type, payload) => events.push({ type, payload }),
    llm: fakeLlm, logUsage: () => {},
    resolveModelLabel: () => ({ providerName: 'OpenAI', modelName: 'GPT' }),
    historyExcludeFromMessageId: 1,
    historyCache: new Map(),
  };
}

const MODEL = { providerId: 'openai', modelId: 'gpt-5.6-terra' };
const talker = () => ({
  instanceId: 'talk', pluginId: 'talker', lane: 'main', enabled: true, outputType: 'text-to-user',
  promptTemplate: '{{prompt}}', context: { history: { mode: 'none' } },
  config: { prompt: 'Answer.', model: MODEL },
});
const guard = (cfg = {}, extra = {}) => ({
  instanceId: extra.instanceId || 'guard', pluginId: 'guardrail', lane: extra.lane || 'main', enabled: extra.enabled !== false,
  outputType: 'guardrail-verdict', promptTemplate: '{{prompt}}', context: { history: { mode: 'none' } },
  config: { prompt: 'Check the reply:\n{{reply}}\nNo rates or approvals.', model: MODEL, ...cfg },
});

async function run(chainList, verdicts) {
  verdictScript = [...verdicts];
  prompts.length = 0;
  streamCalls = 0;
  metaWrites.length = 0;
  const events = [];
  const ctx = makeCtx(events);
  const out = await runChainSteps(ctx, chainList);
  const outputs = events.filter(e => e.type === 'addon.output').map(e => e.payload);
  return {
    ...out,
    events,
    tokens: events.filter(e => e.type === 'addon.token').length,
    verdict: (outputs.find(o => o.instanceId.startsWith('guard')) || {}).guardrail,
    warnings: events.filter(e => e.type === 'warning').map(e => e.payload.code),
    errors: events.filter(e => e.type === 'addon.error').map(e => e.payload.error && e.payload.error.code),
    ctx,
  };
}

(async () => {
  // ═══ A. plugin ═══
  section('A. the plugin');
  let s = g.settingsOf(guard());
  check('defaults: hold off, replace + block allowed, fail closed, built-in message', !s.holdReply && s.replace && s.block && s.onError === 'block' && s.blockMessage === g.DEFAULT_BLOCK_MESSAGE && s.escalateTo === null);
  check('acts only with hold on in the main lane', !g.acts(guard()) && g.acts(guard({ holdReply: true })) && !g.acts(guard({ holdReply: true }, { lane: 'offline' })));
  let sfx = g.promptSuffix({ instance: guard(), reply: 'hi' });
  check('hold off → the verdict section offers approve | flag only', /"approve" \| "flag"/.test(sfx) && !/replace/.test(sfx));
  sfx = g.promptSuffix({ instance: guard({ holdReply: true }), reply: 'hi' });
  check('hold on → approve | replace | block + replacement key', /"approve" \| "replace" \| "block"/.test(sfx) && /replacement/.test(sfx));
  sfx = g.promptSuffix({ instance: guard({ holdReply: true, actions: { replace: false, block: true } }), reply: 'hi' });
  check('a switched-off action is not offered', /"approve" \| "block"/.test(sfx) && !/"replace"/.test(sfx));
  sfx = g.promptSuffix({ instance: guard({ prompt: 'No rates.' }), reply: 'THE REPLY' });
  check('a prompt without {{reply}} gets the reply added', /## The reply to check\nTHE REPLY/.test(sfx));
  sfx = g.promptSuffix({ instance: guard(), reply: 'THE REPLY' });
  check('a prompt with {{reply}} does not get it twice', !/The reply to check\nTHE REPLY/.test(sfx));
  const bo = g.blockOutcome(guard({ holdReply: true, blockMessage: 'נעביר אותך לנציג.', escalateTo: 'crew_human' }));
  check('block = the message, stop the chain, move next turn', bo.assistantText === 'נעביר אותך לנציג.' && bo.breakChain && bo.transition.to === 'crew_human' && bo.transition.fireImmediately === false);

  // ═══ B. {{reply}} ═══
  section('B. {{reply}}');
  const asm = reply => assemblePrompt({ instance: { pluginId: 'thinker', promptTemplate: 'R=[{{reply}}]', config: {} }, personas: [], reply });
  check('{{reply}} resolves to the reply so far', asm('hello there') === 'R=[hello there]');
  check('{{reply}} is empty before a Talker', !asm('').includes('{{reply}}') && asm('').replace(/\s/g, '') === 'R=[]');

  // ═══ C. the chain ═══
  section('C. the chain');
  let r = await run([talker(), guard()], ['{"verdict":"flag","reason":"promises a rate"}']);
  check('hold OFF: the reply streams (addon.token)', r.tokens > 0);
  check('hold OFF: the reply is unchanged', r.chainText === TALKER_REPLY);
  check('hold OFF: the verdict is a FLAG on the run', r.verdict && r.verdict.applied === 'flag' && r.verdict.verdict === 'flag' && r.verdict.held === false, JSON.stringify(r.verdict));
  check('the Guardrail got the reply through {{reply}}', prompts[0] && prompts[0].includes(TALKER_REPLY));

  r = await run([talker(), guard({ holdReply: true })], ['{"verdict":"approve","reason":"fine"}']);
  check('hold ON: nothing streams (no addon.token)', r.tokens === 0);
  check('hold ON + approve: the reply goes out as it is', r.chainText === TALKER_REPLY && r.verdict.applied === 'approve' && r.verdict.held === true);
  check('hold is cleared after the chain', r.ctx.holdReply === false);

  r = await run([talker(), guard({ holdReply: true })], ['{"verdict":"replace","reason":"rate promised","replacement":"An advisor will confirm your rate."}']);
  check('hold ON + replace: the corrected reply goes out', r.chainText === 'An advisor will confirm your rate.' && r.verdict.applied === 'replace');
  check('{{reply}} after the chain = the replaced reply', r.ctx.replySoFar === 'An advisor will confirm your rate.');

  r = await run([talker(), guard({ holdReply: true, blockMessage: 'נעביר אותך לנציג.', escalateTo: 'crew_human' }), talker()],
    ['{"verdict":"block","reason":"approval promised"}']);
  check('hold ON + block: the block message goes out', r.chainText === 'נעביר אותך לנציג.' && r.verdict.applied === 'block');
  check('block stops the rest of the chain (the 2nd Talker never ran)', streamCalls === 1);
  check('block moves the conversation from the NEXT turn (no cascade)', r.chainTransition === true && r.cascadeTo === null
    && metaWrites.some(w => w && w.metadata));

  r = await run([talker(), guard({ holdReply: true, actions: { replace: true, block: false } })], ['{"verdict":"block","reason":"x"}']);
  check('an action it may not take → the reply goes out, with a note', r.chainText === TALKER_REPLY && r.verdict.applied === 'approve' && /not allowed/.test(r.verdict.note || ''));

  r = await run([talker(), guard({ holdReply: true, blockMessage: 'BLOCKED' })], ['this is not json']);
  check('no valid verdict → a failed run', r.errors.includes('no_verdict') || r.errors.includes('bad_json'), JSON.stringify(r.errors));
  check('…fails CLOSED by default: the block message goes out', r.chainText === 'BLOCKED' && r.warnings.includes('guardrail_failed_closed'));
  r = await run([talker(), guard({ holdReply: true, onError: 'approve' })], ['{"verdict":"maybe"}']);
  check('…with "Let the reply through": the reply goes out', r.chainText === TALKER_REPLY && !r.warnings.includes('guardrail_failed_closed'));
  r = await run([talker(), guard({ holdReply: true, escalateTo: 'crew_human' })], ['']);
  check('…an empty answer fails closed and escalates too', r.chainText === g.DEFAULT_BLOCK_MESSAGE && r.chainTransition === true);

  r = await run([guard({ holdReply: true, blockMessage: 'Off topic.' }), talker()], ['{"verdict":"block","reason":"off topic"}']);
  check('BEFORE the Talker: block = the Talker never answers', streamCalls === 0 && r.chainText === 'Off topic.');
  r = await run([guard({ holdReply: true }), talker()], ['{"verdict":"replace","reason":"x","replacement":"Y"}']);
  check('BEFORE the Talker: replace does nothing (no reply yet)', r.chainText === TALKER_REPLY && /nothing to replace/.test(r.verdict.note || ''));

  r = await run([talker(), guard({ holdReply: true }, { enabled: false })], []);
  check('a DISABLED Guardrail never holds the reply', r.tokens > 0);

  // ═══ D. offline ═══
  section('D. offline lane');
  {
    verdictScript = ['{"verdict":"flag","reason":"made-up fact"}'];
    const events = [];
    const ctx = makeCtx(events);
    ctx.replySoFar = TALKER_REPLY;
    ctx.historyExcludeFromMessageId = undefined;
    await runAddon({ ctx, instance: guard({ holdReply: true }, { lane: 'offline', instanceId: 'guard-off' }) });
    const out = events.find(e => e.type === 'addon.output');
    check('offline: always a flag, even with hold on', out && out.payload.guardrail.applied === 'flag' && out.payload.guardrail.held === false);
    check('offline: no reply text is produced', !('assistantText' in (out ? out.payload : {})));
  }

  // ═══ E. failure rule ═══
  section('E. failure rule');
  const f = outputFailureOf({
    instance: { outputType: 'guardrail-verdict' },
    result: { rawOutput: 'oops', parsedOutput: null, parseError: 'not JSON' },
    modelCalls: { count: 1, cutOff: 0 },
    outputLimit: 16000,
  });
  check('no valid verdict = code no_verdict', f && f.code === 'no_verdict');

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(err => { console.error('BATTERY CRASHED:', err); process.exit(1); });
