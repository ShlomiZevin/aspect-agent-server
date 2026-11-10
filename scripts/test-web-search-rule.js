#!/usr/bin/env node
/**
 * OFFLINE test for #967 (Noa's review): the web search permission rule.
 * Runs the REAL runner (runAddon) → REAL Talker / Thinker plugin → REAL
 * llm.js router → REAL llm.claude.js / llm.openai.js request building, with
 * fake provider clients that only capture the request. No DB (db.pg is a
 * stub that throws on use, DB_HOST is dead), no network, no keys.
 *
 *   DB_HOST=127.0.0.255 DATABASE_URL=postgres://x:x@127.0.0.255:1/x node scripts/test-web-search-rule.js
 */
const path = require('path');
const SERVER = path.join(__dirname, '..');
process.env.DB_HOST = '127.0.0.255';
process.env.DATABASE_URL = 'postgres://dead:dead@127.0.0.255:1/dead';
process.env.ANTHROPIC_API_KEY = 'sk-ant-offline-test';
process.env.OPENAI_API_KEY = 'sk-offline-test';
process.env.GEMINI_API_KEY = 'offline-test';

// ── stub modules that would touch a database ──
const dbTouches = [];
function stub(rel, exportsObj) {
  const file = require.resolve(path.join(SERVER, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
const dbStub = new Proxy({}, {
  get(_, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    return (...a) => { dbTouches.push(String(prop)); throw new Error(`DB stub: ${String(prop)} called`); };
  },
});
stub('services/db.pg.js', dbStub);
let fakeHistory = []; // a case may set prior turns
stub('builder/runtime/historyService.js', {
  loadHistory: async () => ({ messages: fakeHistory, resolution: { requested: 'none', effective: 'none' } }),
});
stub('builder/runtime/addonRunsStore.js', { insertRun: async () => {} });
stub('services/usageLogger.js', { logUsage: () => {}, logWebSearches: () => {} });

// ── fake provider clients ──
const captured = [];
function anthropicEvents(text) {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}
const fakeAnthropic = {
  messages: {
    stream(params) {
      captured.push({ provider: 'anthropic', params });
      const text = params.tools && params.tools.some(t => t.name === 'web_search') ? '{"ok":"search-on"}' : '{"ok":"search-off"}';
      const evs = anthropicEvents(text);
      return {
        async *[Symbol.asyncIterator]() { for (const e of evs) yield e; },
        async finalMessage() {
          return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
        },
      };
    },
    async create(params) {
      captured.push({ provider: 'anthropic', params });
      return { content: [{ type: 'text', text: '{"ok":"create"}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  },
};
fakeAnthropic.beta = { messages: fakeAnthropic.messages };
const openaiResponse = text => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
});
const fakeOpenAI = {
  responses: {
    async create(params) {
      captured.push({ provider: 'openai', params });
      const text = '{"ok":"openai"}';
      if (!params.stream) return openaiResponse(text);
      const evs = [
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.completed', response: openaiResponse(text) },
      ];
      return { async *[Symbol.asyncIterator]() { for (const e of evs) yield e; } };
    },
  },
};

const claude = require(path.join(SERVER, 'services/llm.claude.js'));
const openai = require(path.join(SERVER, 'services/llm.openai.js'));
claude._clientFor = () => fakeAnthropic;
openai._clientFor = () => fakeOpenAI;
const llm = require(path.join(SERVER, 'services/llm.js'));
require(path.join(SERVER, 'builder/plugins/talker/addon.talker.js'));
require(path.join(SERVER, 'builder/plugins/thinker/addon.thinker.js'));
const { runAddon } = require(path.join(SERVER, 'builder/runtime/addonRunner.js'));
const { WEB_SEARCH_RULE, withWebSearchRule, webSearchFor, OPENAI_REPEAT_NOTE, promptAsShown } = require(path.join(SERVER, 'services/webSearch.js'));
const NOTE_TAIL = `\n\n${OPENAI_REPEAT_NOTE}\n${WEB_SEARCH_RULE}`;
const QUESTION = 'What is the USD/ILS exchange rate today?';

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
};

const BUILDER_PROMPT = 'You are a helpful assistant for a small bank. Answer briefly.';

function ctxFor(events) {
  return {
    runnable: { agent: { body: {} }, crew: { body: {} } },
    agentSlug: 'offline-test', ownerUserId: 1, userId: 1,
    conversationId: 123, assistantMessageId: 456,
    userMessage: QUESTION,
    crewLabel: 'Main', agentNameForLogs: 'offline-test',
    agentPersonas: [], agentParameters: [], agentEnums: [],
    memory: {}, memoryValuesByDomain: {}, memoryDomainList: [],
    thinkingValuesByDomain: {}, thinkingDomainList: [],
    retrievalValueOf: () => '', fieldValueOf: () => '',
    drizzle: null, convRow: { id: 123, metadata: {} },
    emit: (type, payload) => events.push({ type, payload }),
    llm, logUsage: () => {},
    resolveModelLabel: () => 'model',
    historyExcludeFromMessageId: 456,
    historyCache: new Map(),
  };
}

async function runCase({ name, pluginId, modelId, providerId, webSearch, outputType, history }) {
  fakeHistory = history || [];
  const events = [];
  const before = captured.length;
  const instance = {
    instanceId: `inst-${pluginId}`,
    pluginId,
    lane: 'main',
    outputType: outputType || (pluginId === 'talker' ? 'text-to-user' : 'json-to-memory'),
    promptTemplate: BUILDER_PROMPT,
    context: { history: { mode: 'none' } },
    config: {
      name,
      model: { providerId, modelId },
      prompt: BUILDER_PROMPT,
      ...(pluginId === 'thinker' ? { domain: 'strategy' } : {}),
      ...(webSearch !== undefined ? { webSearch } : {}),
    },
  };
  await runAddon({ ctx: ctxFor(events), instance });
  const calls = captured.slice(before);
  const errs = events.filter(e => e.type === 'addon.error');
  if (errs.length) console.log('   addon.error:', JSON.stringify(errs.map(e => e.payload.error)));
  const promptEv = events.find(e => e.type === 'addon.prompt');
  const outEv = events.find(e => e.type === 'addon.output');
  return { calls, promptEv, outEv, errs };
}

const sysOf = c => (c.provider === 'anthropic'
  ? (typeof c.params.system === 'string' ? c.params.system : JSON.stringify(c.params.system))
  : c.params.instructions || '');
const hasSearchTool = c => (c.params.tools || []).some(t => t.type === 'web_search' || t.name === 'web_search');
const endsWithRule = s => String(s).trimEnd().endsWith(WEB_SEARCH_RULE);

(async () => {
  console.log('── unit ──');
  check('rule appended after the prompt, separated by a blank line',
    withWebSearchRule('P', { allowedDomains: [], maxSearches: 3 }) === `P\n\n${WEB_SEARCH_RULE}`);
  check('no settings → prompt unchanged', withWebSearchRule('P', null) === 'P');
  check('empty prompt + on → just the rule', withWebSearchRule('', { allowedDomains: [], maxSearches: 3 }) === WEB_SEARCH_RULE);
  const inst = ws => ({ config: { webSearch: ws } });
  check('webSearchFor: Claude + on → settings', !!webSearchFor(inst({ enabled: true }), 'claude-sonnet-5-5'));
  check('webSearchFor: GPT + on → settings', !!webSearchFor(inst({ enabled: true }), 'gpt-5.6-terra'));
  check('webSearchFor: Gemini + on → null', webSearchFor(inst({ enabled: true }), 'gemini-2.5-pro') === null);
  check('webSearchFor: Claude + off → null', webSearchFor(inst({ enabled: false }), 'claude-sonnet-5-5') === null);
  check('webSearchFor: no config → null', webSearchFor({ config: {} }, 'claude-sonnet-5-5') === null);
  check('rule has the sharper sentence',
    WEB_SEARCH_RULE.includes('Before calling web_search, find the sentence in your instructions that permits it; if there is none, do not call it.'));
  check('rule says "your instructions", never "above" (it is also sent after the history)', !/above/.test(WEB_SEARCH_RULE));
  const S = { allowedDomains: [], maxSearches: 3 };
  check('promptAsShown: OpenAI + on → marked copy appended', promptAsShown('P', 'gpt-5.6-terra', S) === `P${NOTE_TAIL}`);
  check('promptAsShown: Claude + on → unchanged', promptAsShown('P', 'claude-sonnet-5-5', S) === 'P');
  check('promptAsShown: OpenAI + off → unchanged', promptAsShown('P', 'gpt-5.6-terra', null) === 'P');

  const cases = [
    { name: 'Talker Claude ON', pluginId: 'talker', modelId: 'claude-sonnet-5-5', providerId: 'anthropic', webSearch: { enabled: true, maxSearches: 2 }, on: true },
    { name: 'Talker Claude OFF (switch off)', pluginId: 'talker', modelId: 'claude-sonnet-5-5', providerId: 'anthropic', webSearch: { enabled: false }, on: false },
    { name: 'Talker Claude no config', pluginId: 'talker', modelId: 'claude-sonnet-5-5', providerId: 'anthropic', on: false },
    { name: 'Talker OpenAI ON', pluginId: 'talker', modelId: 'gpt-5.6-terra', providerId: 'openai', webSearch: { enabled: true, allowedDomains: ['boi.org.il'] }, on: true },
    { name: 'Talker OpenAI OFF', pluginId: 'talker', modelId: 'gpt-5.6-terra', providerId: 'openai', webSearch: { enabled: false }, on: false },
    { name: 'Thinker Claude ON', pluginId: 'thinker', modelId: 'claude-sonnet-5-5', providerId: 'anthropic', webSearch: { enabled: true }, on: true },
    { name: 'Thinker Claude OFF', pluginId: 'thinker', modelId: 'claude-sonnet-5-5', providerId: 'anthropic', webSearch: { enabled: false }, on: false },
    { name: 'Thinker OpenAI ON', pluginId: 'thinker', modelId: 'gpt-5.6-terra', providerId: 'openai', webSearch: { enabled: true }, on: true },
    { name: 'Thinker OpenAI no config', pluginId: 'thinker', modelId: 'gpt-5.6-terra', providerId: 'openai', on: false },
    { name: 'Talker OpenAI ON with history', pluginId: 'talker', modelId: 'gpt-5.6-terra', providerId: 'openai', webSearch: { enabled: true }, on: true, history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }] },
    { name: 'Thinker OpenAI ON with history', pluginId: 'thinker', modelId: 'gpt-5.6-terra', providerId: 'openai', webSearch: { enabled: true }, on: true, history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '{"a":1}' }] },
    { name: 'Talker Claude ON with history', pluginId: 'talker', modelId: 'claude-sonnet-5-5', providerId: 'anthropic', webSearch: { enabled: true }, on: true, history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }] },
  ];
  // The OpenAI input: [...history, rule item, user message, (JSON prod)].
  const isRuleItem = it => it && it.role === 'developer' && Array.isArray(it.content) && it.content[0] && it.content[0].text === WEB_SEARCH_RULE;
  const isQuestion = it => it && it.role === 'user' && Array.isArray(it.content) && it.content[0] && it.content[0].text === QUESTION;
  for (const c of cases) {
    console.log(`\n── ${c.name} ──`);
    const r = await runCase(c);
    check('no add-on error', r.errs.length === 0);
    check('exactly one model call', r.calls.length === 1, `${r.calls.length} calls`);
    const call = r.calls[0];
    if (!call) continue;
    const sys = sysOf(call);
    if (process.env.SHOW) console.log('   SENT SYSTEM:', JSON.stringify(sys));
    check('sent prompt starts with the builder prompt', sys.startsWith(BUILDER_PROMPT));
    if (c.on) {
      check('rule sits right after the builder prompt', sys.startsWith(`${BUILDER_PROMPT}

${WEB_SEARCH_RULE}`));
      check('search tool attached', hasSearchTool(call), JSON.stringify(call.params.tools));
      check('rule appears once', sys.split('## Web search').length === 2);
    } else {
      check('NO permission rule in the sent prompt', !sys.includes('## Web search'));
      check('NO search tool', !hasSearchTool(call), JSON.stringify(call.params.tools || null));
      check('sent prompt is the builder prompt (+ provider JSON line only)', sys.trimEnd() === BUILDER_PROMPT || /^\n\n(IMPORTANT: Respond with valid JSON only|Respond in JSON)/.test(sys.slice(BUILDER_PROMPT.length)));
    }
    // Run card: the instructions/system as sent (the provider may add its
    // own JSON line after it) + on OpenAI-with-search the marked copy of
    // the rule that stands for the extra input item.
    const expectNote = c.on && call.provider === 'openai';
    const shown = r.promptEv ? r.promptEv.payload.prompt : '';
    const shownBase = expectNote ? (shown.endsWith(NOTE_TAIL) ? shown.slice(0, -NOTE_TAIL.length) : null) : shown;
    check('run card prompt (addon.prompt) is what the model got (incl. the rule)',
      shownBase !== null && sys.startsWith(shownBase.trimEnd()) && (c.on ? shownBase.includes(WEB_SEARCH_RULE) : true));
    check(expectNote ? 'run card shows the extra OpenAI rule item (marked)' : 'run card has no OpenAI repeat note',
      expectNote ? shown.endsWith(NOTE_TAIL) : !shown.includes(OPENAI_REPEAT_NOTE));
    check('persisted run prompt (addon.output) == addon.prompt', r.outEv && r.outEv.payload.prompt === r.promptEv.payload.prompt);
    if (call.provider === 'openai') {
      const input = call.params.input || [];
      const qi = input.findIndex(isQuestion);
      const ruleItems = input.filter(isRuleItem).length;
      if (c.on) {
        check('OpenAI input: rule item right before the user message', qi > 0 && isRuleItem(input[qi - 1]), JSON.stringify(input.map(i => i.role)));
        check('OpenAI input: exactly one rule item', ruleItems === 1);
        if (c.history) check('OpenAI input: history comes before the rule item', input.slice(0, qi - 1).length === c.history.length);
      } else {
        check('OpenAI input: NO rule item', ruleItems === 0 && !input.some(i => i.role === 'developer'));
      }
    } else {
      const msgs = JSON.stringify(call.params.messages || []);
      check('Anthropic: rule only in system, not in messages', !msgs.includes('## Web search'));
      if (c.history) check('Anthropic: history passed through', (call.params.messages || []).length === c.history.length + 1);
    }
    if (c.on && call.provider === 'anthropic') {
      const t = call.params.tools.find(x => x.name === 'web_search');
      check('Anthropic tool type web_search_20250305 + max_uses', t.type === 'web_search_20250305' && t.max_uses >= 1, JSON.stringify(t));
    }
    if (c.on && call.provider === 'openai') {
      check('OpenAI max_tool_calls set', typeof call.params.max_tool_calls === 'number');
      if (c.pluginId === 'thinker') check('OpenAI JSON mode NOT used with search', !call.params.text);
      if (c.webSearch.allowedDomains) {
        const t = call.params.tools.find(x => x.type === 'web_search');
        check('OpenAI allowed_domains passed', JSON.stringify(t.filters) === JSON.stringify({ allowed_domains: ['boi.org.il'] }));
      }
    }
  }

  // Gemini: the runner must not add the rule (no tool there). Fake llm — no Google call.
  console.log('\n── Talker Gemini ON (ignored) ──');
  {
    const events = [];
    let sentPrompt = null;
    const ctx = ctxFor(events);
    ctx.llm = {
      async *sendMessageStreamWithPrompt(msg, id, cfg) { sentPrompt = cfg.prompt; check('no webSearch passed to the provider', !cfg.webSearch); yield 'hi'; yield { type: 'usage', inputTokens: 1, outputTokens: 1 }; },
      async sendOneShot() { return 'x'; },
    };
    await runAddon({ ctx, instance: { instanceId: 'g', pluginId: 'talker', lane: 'main', outputType: 'text-to-user', promptTemplate: BUILDER_PROMPT, context: { history: { mode: 'none' } }, config: { model: { providerId: 'google', modelId: 'gemini-2.5-pro' }, prompt: BUILDER_PROMPT, webSearch: { enabled: true } } } });
    check('Gemini: no rule in the prompt', sentPrompt && !sentPrompt.includes('## Web search'), JSON.stringify(sentPrompt));
  }

  console.log(`\nDB stub touched: ${dbTouches.length ? dbTouches.join(', ') : 'never'}`);
  console.log(`\n${fails ? `${fails} FAILED` : 'ALL PASS'}`);
  console.log('\nRule text:\n' + WEB_SEARCH_RULE);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
