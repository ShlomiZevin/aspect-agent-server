#!/usr/bin/env node
/**
 * OFFLINE battery for #984 — the per-agent "Model route: Direct / Vertex"
 * switch. Runs the REAL runner (runAddon) → REAL plugins → REAL llm.js
 * router → REAL llm.claude.js / llm.openai.js / llm.google.js request
 * building, with FAKE provider SDKs that only record what they were built
 * with and what they were sent. No DB (db.pg is a stub: only llm_usage
 * inserts are recorded, anything else throws), no network, no keys, no
 * model calls, no Google credentials.
 *
 *   node scripts/test-vertex-route.js
 *   node scripts/test-vertex-route.js --capture-baseline   (rewrites the Direct baseline — only
 *                                                          when a Direct request is MEANT to change)
 *
 * What it proves:
 *   A. Direct agent (no modelRoute / 'direct') → every client construction,
 *      request and llm_usage row is identical to the baseline captured from
 *      the code BEFORE #984 (scripts/fixtures/vertex-route-direct-baseline.json).
 *   B. Vertex agent → AnthropicVertex / OpenAI-on-Vertex / GoogleGenAI(vertexai)
 *      clients, right project / location / base URL / model ids, a fresh
 *      Google token per OpenAI call, no direct client ever constructed,
 *      usage rows carry the route.
 *   C. Loud failures, never a silent direct call: a model not on Vertex,
 *      missing VERTEX_PROJECT_ID, OpenAI web search on Vertex, Files API /
 *      hosted file search on Vertex.
 *   D. Units: route normalisation, models registry flags, /api/models
 *      payload, the "add-ons not on Vertex" scan.
 *   E. The Builder MCP door: read + set the route (mcpRoute mounted alone).
 *   F. The REAL SDKs (child process, fetch intercepted, fake Google auth,
 *      no network): the wire URLs + bearer each provider would really send.
 *      Guards the SDK pairing — @anthropic-ai/vertex-sdk must match
 *      @anthropic-ai/sdk's internals (0.19.x on sdk 0.74 sent /v1/v1/messages
 *      with no auth); bump them together.
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const SERVER = path.join(__dirname, '..');
const CAPTURE = process.argv.includes('--capture-baseline');
const BASELINE = path.join(__dirname, 'fixtures', 'vertex-route-direct-baseline.json');

// Section F runs this same file again as a child, with the REAL SDKs.
if (process.argv.includes('--real-sdk-child')) {
  realSdkChild().then(() => process.exit(0), e => { console.error('CHILD CRASH', e); process.exit(2); });
  return; // eslint-disable-line no-unreachable
}

process.env.DB_HOST = '127.0.0.255';
process.env.DATABASE_URL = 'postgres://dead:dead@127.0.0.255:1/dead';
process.env.ANTHROPIC_API_KEY = 'sk-ant-offline-test';
process.env.OPENAI_API_KEY = 'sk-offline-test';
process.env.GEMINI_API_KEY = 'gemini-offline-test';
delete process.env.VERTEX_PROJECT_ID;
delete process.env.VERTEX_LOCATION;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ── What the fakes saw ──
const rec = { ctor: [], calls: [], usage: [] };
let tokenN = 0;

// ── stub the DB: only llm_usage inserts are recorded ──
function stubFile(file, exportsObj) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
function stub(rel, exportsObj) { stubFile(require.resolve(path.join(SERVER, rel)), exportsObj); }
const dbTouches = [];
const drizzleStub = {
  insert() {
    return { values(v) { return { execute() { rec.usage.push(clone(v)); return Promise.resolve(); } }; } };
  },
};
const dbStub = new Proxy({}, {
  get(_, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    if (prop === 'getDrizzle') return () => new Proxy(drizzleStub, {
      get(t, p) {
        if (p in t) return t[p];
        return () => { dbTouches.push(`drizzle.${String(p)}`); throw new Error(`DB stub: drizzle.${String(p)}`); };
      },
    });
    return () => { dbTouches.push(String(prop)); throw new Error(`DB stub: ${String(prop)} called`); };
  },
});
stub('services/db.pg.js', dbStub);
let fakeHistory = [];
stub('builder/runtime/historyService.js', {
  loadHistory: async () => ({ messages: fakeHistory, resolution: { requested: 'none', effective: 'none' } }),
});
stub('builder/runtime/addonRunsStore.js', { insertRun: async () => {} });
// The Builder MCP is mounted alone (section E) over a fake project store.
const mcpState = { body: null, saved: [], activated: [] };
function mcpAgentDoc() {
  const body = mcpState.body;
  return {
    id: 'agent_bank', slug: 'bank', name: 'Bank', ...body,
    crews: [{ id: 'crew_main', name: 'Main', addons: [
      { instanceId: 'a1', pluginId: 'talker', config: { name: 'Voice', model: { providerId: 'openai', modelId: 'gpt-5.6-terra' } } },
      { instanceId: 'a2', pluginId: 'field-extractor', config: { name: 'Ext', model: { providerId: 'anthropic', modelId: 'claude-haiku-5-5' } } },
    ] }],
    versions: [{ id: 'v1', number: 1, body }],
    activeVersionId: 'v1', viewingVersionId: 'v1',
  };
}
stub('builder/services/builderProjects.js', {
  hydrateProject: async ({ agentSlug }) => (agentSlug === 'bank' ? { agents: [mcpAgentDoc()] } : null),
  saveAgentVersionAs: async args => { mcpState.saved.push(clone(args)); mcpState.body = clone(args.body); },
  setAgentActive: async args => { mcpState.activated.push(args.versionId); },
  nextAgentWideNumber: async () => 2,
});

// ── fake provider SDKs ──
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
function anthropicMessages(kind) {
  const text = '{"ok":"claude"}';
  const final = { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  return {
    stream(params) {
      rec.calls.push({ kind, method: 'messages.stream', params: clone(params) });
      const evs = anthropicEvents(text);
      return {
        async *[Symbol.asyncIterator]() { for (const e of evs) yield e; },
        async finalMessage() { return final; },
      };
    },
    async create(params) {
      rec.calls.push({ kind, method: 'messages.create', params: clone(params) });
      return final;
    },
  };
}
class FakeAnthropic {
  constructor(opts) {
    rec.ctor.push({ cls: 'Anthropic', opts: clone(opts) });
    this.messages = anthropicMessages('anthropic');
    this.beta = { messages: this.messages };
  }
}
class FakeAnthropicVertex {
  constructor(opts) {
    rec.ctor.push({ cls: 'AnthropicVertex', opts: clone(opts) });
    this.messages = anthropicMessages('anthropic-vertex');
    this.beta = { messages: this.messages };
  }
}
const openaiResponse = text => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
});
class FakeOpenAI {
  constructor(opts) {
    rec.ctor.push({ cls: 'OpenAI', opts: clone(opts) });
    const kind = opts && opts.baseURL ? 'openai-vertex' : 'openai';
    this.responses = {
      async create(params) {
        rec.calls.push({ kind, method: 'responses.create', params: clone(params), apiKey: opts && opts.apiKey });
        const text = '{"ok":"openai"}';
        if (!params.stream) return openaiResponse(text);
        const evs = [
          { type: 'response.output_text.delta', delta: text },
          { type: 'response.completed', response: openaiResponse(text) },
        ];
        return { async *[Symbol.asyncIterator]() { for (const e of evs) yield e; } };
      },
    };
  }
}
class FakeGoogleAuth {
  constructor(opts) { rec.ctor.push({ cls: 'GoogleAuth', opts: clone(opts) }); }
  async getAccessToken() { tokenN += 1; return `ya29.offline-token-${tokenN}`; }
}

function stubPackage(name, exportsObj) {
  let file;
  try { file = require.resolve(name, { paths: [SERVER] }); } catch { return false; }
  stubFile(file, exportsObj);
  return true;
}
stubPackage('@anthropic-ai/sdk', FakeAnthropic);
stubPackage('openai', { OpenAI: FakeOpenAI });
const haveVertexSdk = stubPackage('@anthropic-ai/vertex-sdk', { AnthropicVertex: FakeAnthropicVertex });
const haveAuthLib = stubPackage('google-auth-library', { GoogleAuth: FakeGoogleAuth });

// @google/genai is ESM, loaded with import() — a loader hook swaps it for
// a fake whose calls land in globalThis.__vr (main thread).
globalThis.__vr = {
  ctor(opts) { rec.ctor.push({ cls: 'GoogleGenAI', opts: clone(opts) }); },
  oneShot(opts, params) {
    rec.calls.push({ kind: opts && opts.vertexai ? 'google-vertex' : 'google', method: 'models.generateContent', params: clone(params) });
    return { text: '{"ok":"gemini"}', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, candidates: [{ finishReason: 'STOP' }] };
  },
  chat(opts, createParams) {
    const kind = opts && opts.vertexai ? 'google-vertex' : 'google';
    return {
      async sendMessageStream(arg) {
        rec.calls.push({ kind, method: 'chats.create+sendMessageStream', params: clone(createParams), message: clone(arg) });
        const chunks = [{
          candidates: [{ content: { parts: [{ text: 'Hello from Gemini.' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }];
        return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
      },
    };
  },
};
const FAKE_GENAI = 'export class GoogleGenAI { constructor(o) { globalThis.__vr.ctor(o);'
  + ' this.models = { generateContent: async (p) => globalThis.__vr.oneShot(o, p) };'
  + ' this.chats = { create: (p) => globalThis.__vr.chat(o, p) }; } }';
const HOOKS = `const FAKE = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(FAKE_GENAI))};
export async function resolve(spec, ctx, next) {
  if (spec === '@google/genai') return { url: FAKE, shortCircuit: true };
  return next(spec, ctx);
}`;
Module.register('data:text/javascript,' + encodeURIComponent(HOOKS));

// ── the real code ──
const llm = require(path.join(SERVER, 'services/llm.js'));
const usageLogger = require(path.join(SERVER, 'services/usageLogger.js'));
require(path.join(SERVER, 'builder/plugins'));
const { runAddon } = require(path.join(SERVER, 'builder/runtime/addonRunner.js'));

let fails = 0;
let passes = 0;
const check = (name, cond, extra = '') => {
  if (cond) passes++; else fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? ` — ${extra}` : ''}`);
};

const PROMPT = 'You are a helpful assistant for a small bank. Answer briefly.';
const QUESTION = 'Can I open an account online?';

function ctxFor(agentBody, events) {
  return {
    runnable: { agent: { body: agentBody }, crew: { id: 'crew_main', body: { name: 'Main' } } },
    agentSlug: 'offline-test', ownerUserId: 1, userId: 1,
    conversationId: 123, assistantMessageId: 456,
    userMessage: QUESTION,
    crewLabel: 'Main', agentNameForLogs: 'offline-test',
    agentPersonas: [], agentParameters: [], agentEnums: [],
    memory: {},
    memoryValuesByDomain: () => ({}), memoryDomainList: () => [],
    thinkingValuesByDomain: () => ({}), thinkingDomainList: () => [],
    retrievalValueOf: () => '', fieldValueOf: () => '',
    drizzle: null, convRow: { id: 123, metadata: {} },
    emit: (type, payload) => events.push({ type, payload }),
    llm, logUsage: usageLogger.logUsage,
    resolveModelLabel: () => null,
    historyExcludeFromMessageId: 456,
    historyCache: new Map(),
  };
}

function instanceOf(s) {
  return {
    instanceId: `inst-${s.id}`,
    pluginId: s.pluginId,
    lane: 'main',
    outputType: s.outputType || (s.pluginId === 'talker' ? 'text-to-user' : 'json-to-memory'),
    promptTemplate: PROMPT,
    context: { history: { mode: 'none' } },
    config: {
      name: s.id,
      model: { providerId: s.providerId, modelId: s.modelId },
      prompt: PROMPT,
      ...(s.pluginId === 'thinker' ? { domain: 'strategy' } : {}),
      ...(s.webSearch ? { webSearch: s.webSearch } : {}),
    },
  };
}

/** Timing is not part of the contract: a fake answers in 0-1 ms, and
 *  logUsage writes 0 ms as null. Both sides are normalised. */
function normUsage(u) {
  return { ...u, durationMs: (typeof u.durationMs === 'number' || u.durationMs === null || u.durationMs === '<ms>') ? '<ms>' : u.durationMs };
}

/** Run one scenario; return only what changed in the recorders. */
async function runScenario(s, agentBody) {
  fakeHistory = s.history || [];
  const before = { ctor: rec.ctor.length, calls: rec.calls.length, usage: rec.usage.length };
  const events = [];
  await runAddon({ ctx: ctxFor(agentBody, events), instance: instanceOf(s) });
  await new Promise(r => setImmediate(r)); // usage inserts are fire-and-forget
  return {
    ctor: rec.ctor.slice(before.ctor),
    calls: rec.calls.slice(before.calls),
    usage: rec.usage.slice(before.usage).map(normUsage),
    errors: events.filter(e => e.type === 'addon.error').map(e => e.payload.error),
  };
}

// The Direct scenarios. Order matters (clients are cached per process), so
// never reorder — append.
const DIRECT = [
  { id: 'talker-claude', pluginId: 'talker', providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
  { id: 'talker-openai', pluginId: 'talker', providerId: 'openai', modelId: 'gpt-5.6-terra' },
  { id: 'talker-gemini', pluginId: 'talker', providerId: 'google', modelId: 'gemini-2.5-flash' },
  { id: 'thinker-claude', pluginId: 'thinker', providerId: 'anthropic', modelId: 'claude-sonnet-5-5' },
  { id: 'thinker-openai', pluginId: 'thinker', providerId: 'openai', modelId: 'gpt-6.1-terra' },
  { id: 'thinker-gemini', pluginId: 'thinker', providerId: 'google', modelId: 'gemini-2.5-pro' },
  { id: 'extractor-openai', pluginId: 'field-extractor', providerId: 'openai', modelId: 'gpt-4o-mini' },
  { id: 'extractor-claude-haiku', pluginId: 'field-extractor', providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  { id: 'talker-claude-websearch', pluginId: 'talker', providerId: 'anthropic', modelId: 'claude-sonnet-5-5', webSearch: { enabled: true, maxSearches: 2 } },
  { id: 'talker-openai-websearch', pluginId: 'talker', providerId: 'openai', modelId: 'gpt-5.6-terra', webSearch: { enabled: true, allowedDomains: ['boi.org.il'] } },
  { id: 'thinker-openai-websearch', pluginId: 'thinker', providerId: 'openai', modelId: 'gpt-6.1-terra', webSearch: { enabled: true } },
  { id: 'thinker-claude-websearch', pluginId: 'thinker', providerId: 'anthropic', modelId: 'claude-opus-5-5', webSearch: { enabled: true } },
  { id: 'talker-openai-history', pluginId: 'talker', providerId: 'openai', modelId: 'gpt-6-luna', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }] },
  { id: 'talker-claude-history', pluginId: 'talker', providerId: 'anthropic', modelId: 'claude-haiku-5-5', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }] },
];

(async () => {
  // ════ A. Direct = byte-for-byte today ════
  console.log('── A. Direct agent: identical to the pre-#984 baseline ──');
  const direct = {};
  for (const s of DIRECT) direct[s.id] = await runScenario(s, {});
  // An agent that says 'direct' explicitly must be identical too.
  const explicitDirect = await runScenario(DIRECT[0], { modelRoute: 'direct' });

  if (CAPTURE) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${JSON.stringify(direct, null, 2)}\n`);
    console.log(`Baseline written: ${BASELINE} (${Object.keys(direct).length} scenarios)`);
    console.log(`DB stub touched: ${dbTouches.length ? [...new Set(dbTouches)].join(', ') : 'never'}`);
    process.exit(0);
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  for (const v of Object.values(baseline)) v.usage = v.usage.map(normUsage);
  for (const s of DIRECT) {
    const got = JSON.stringify(direct[s.id]);
    const want = JSON.stringify(baseline[s.id]);
    check(`Direct ${s.id}: clients, requests and usage rows identical to baseline`, got === want,
      firstDiff(baseline[s.id], direct[s.id]));
    check(`Direct ${s.id}: no add-on error`, direct[s.id].errors.length === 0, JSON.stringify(direct[s.id].errors));
  }
  check('Direct: explicit modelRoute "direct" sends the same request as no route',
    JSON.stringify(explicitDirect.calls) === JSON.stringify(direct[DIRECT[0].id].calls)
    && explicitDirect.ctor.length === 0
    && JSON.stringify(explicitDirect.usage) === JSON.stringify(direct[DIRECT[0].id].usage));
  check('Direct: no Vertex client was ever constructed',
    !rec.ctor.some(c => c.cls === 'AnthropicVertex' || c.cls === 'GoogleAuth' || (c.cls === 'OpenAI' && c.opts && c.opts.baseURL) || (c.cls === 'GoogleGenAI' && c.opts && c.opts.vertexai)));

  await vertexPart(direct);
  await mcpPart();
  realSdkPart();

  console.log(`\nDB stub touched (other than llm_usage inserts): ${dbTouches.length ? [...new Set(dbTouches)].join(', ') : 'never'}`);
  console.log(`\n${passes} passed, ${fails} failed — ${fails ? 'FAILED' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });

function firstDiff(a, b, p = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return '';
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${p}.${k}`);
      if (d) return d;
    }
  }
  return `${p || '(root)'}: want ${JSON.stringify(a)?.slice(0, 160)} got ${JSON.stringify(b)?.slice(0, 160)}`;
}

// ════ B–D. The Vertex route ════
async function vertexPart(direct) {
  const modelRoute = require(path.join(SERVER, 'services/modelRoute.js'));
  const models = require(path.join(SERVER, 'services/models.service.js'));
  const claude = require(path.join(SERVER, 'services/llm.claude.js'));
  const openai = require(path.join(SERVER, 'services/llm.openai.js'));
  const google = require(path.join(SERVER, 'services/llm.google.js'));
  const VERTEX = { modelRoute: 'vertex' };
  const PROJECT = 'lybi-staging';
  const OPENAI_BASE = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/openai/v1`;
  check('vertex SDK installed (@anthropic-ai/vertex-sdk) and stubbed', haveVertexSdk);
  check('google-auth-library installed and stubbed', haveAuthLib);

  const vertexStart = { ctor: rec.ctor.length, calls: rec.calls.length };
  const byId = Object.fromEntries(DIRECT.map(s => [s.id, s]));
  const withoutInclude = p => { const c = { ...p }; delete c.include; return c; };
  const asVertexRow = u => ({ ...u, provider: `${u.provider}@vertex` });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  process.env.VERTEX_PROJECT_ID = PROJECT;

  console.log('\n── B. Vertex agent: Claude ──');
  {
    const r = await runScenario(byId['talker-claude'], VERTEX);
    check('Talker Claude: no add-on error', r.errors.length === 0, JSON.stringify(r.errors));
    const av = r.ctor.filter(c => c.cls === 'AnthropicVertex');
    check('Talker Claude: AnthropicVertex({ projectId: lybi-staging, region: global, googleAuth, apiKey: null, authToken: null }) + its Google auth (cloud-platform) — nothing else',
      r.ctor.length === 2 && av.length === 1 && av[0].opts.projectId === PROJECT && av[0].opts.region === 'global'
      && Object.keys(av[0].opts).sort().join() === 'apiKey,authToken,googleAuth,projectId,region' && av[0].opts.apiKey === null && av[0].opts.authToken === null
      && r.ctor.some(c => c.cls === 'GoogleAuth' && same(c.opts, { scopes: 'https://www.googleapis.com/auth/cloud-platform' })), JSON.stringify(r.ctor));
    check('Talker Claude: one call, on the Vertex client', r.calls.length === 1 && r.calls[0].kind === 'anthropic-vertex', JSON.stringify(r.calls.map(c => c.kind)));
    check('Talker Claude: request identical to the Direct one (same model id claude-sonnet-4-6)',
      r.calls[0] && same(r.calls[0].params, direct['talker-claude'].calls[0].params),
      firstDiff(direct['talker-claude'].calls[0].params, r.calls[0] && r.calls[0].params));
    check('Talker Claude: usage row = Direct row with provider "anthropic@vertex"',
      same(r.usage, direct['talker-claude'].usage.map(asVertexRow)), JSON.stringify(r.usage));
  }
  {
    const r = await runScenario(byId['extractor-claude-haiku'], VERTEX);
    const want = { ...direct['extractor-claude-haiku'].calls[0].params, model: 'claude-haiku-4-5@20251001' };
    check('Extractor Claude Haiku 4.5: Vertex model id claude-haiku-4-5@20251001, rest identical',
      r.errors.length === 0 && r.calls.length === 1 && r.calls[0].kind === 'anthropic-vertex'
      && same(r.calls[0].params, want), firstDiff(want, r.calls[0] && r.calls[0].params));
    check('Extractor Claude Haiku 4.5: usage row keeps OUR model id, provider anthropic@vertex',
      same(r.usage, direct['extractor-claude-haiku'].usage.map(asVertexRow)), JSON.stringify(r.usage));
    check('Claude Vertex client is reused (no second construction)', r.ctor.length === 0, JSON.stringify(r.ctor));
  }
  {
    const r = await runScenario(byId['talker-claude-websearch'], VERTEX);
    const t = r.calls[0] && (r.calls[0].params.tools || []).find(x => x.name === 'web_search');
    check('Talker Claude + web search on Vertex: runs, basic web_search_20250305 tool, request identical to Direct',
      r.errors.length === 0 && r.calls.length === 1 && r.calls[0].kind === 'anthropic-vertex' && t && t.type === 'web_search_20250305'
      && same(r.calls[0].params, direct['talker-claude-websearch'].calls[0].params),
      JSON.stringify(r.errors) + firstDiff(direct['talker-claude-websearch'].calls[0].params, r.calls[0] && r.calls[0].params));
  }
  for (const id of ['thinker-claude', 'thinker-claude-websearch', 'talker-claude-history']) {
    const r = await runScenario(byId[id], VERTEX);
    check(`${id}: Vertex client, request identical to Direct, row anthropic@vertex`,
      r.errors.length === 0 && r.calls.length === 1 && r.calls[0].kind === 'anthropic-vertex'
      && same(r.calls[0].params, direct[id].calls[0].params)
      && same(r.usage, direct[id].usage.map(asVertexRow)),
      JSON.stringify(r.errors) + firstDiff(direct[id].calls[0].params, r.calls[0] && r.calls[0].params));
  }

  console.log('\n── B. Vertex agent: OpenAI (GPT-6 family) ──');
  {
    const r = await runScenario(byId['talker-openai-history'], VERTEX); // gpt-6-luna, streaming
    const authBuilt = r.ctor.filter(c => c.cls === 'GoogleAuth');
    const oa = r.ctor.filter(c => c.cls === 'OpenAI');
    check('Talker GPT-6 Luna: no add-on error', r.errors.length === 0, JSON.stringify(r.errors));
    check('Talker GPT-6 Luna: Google auth with the cloud-platform scope',
      authBuilt.length === 1 && same(authBuilt[0].opts, { scopes: ['https://www.googleapis.com/auth/cloud-platform'] }), JSON.stringify(authBuilt));
    check('Talker GPT-6 Luna: OpenAI SDK pointed at Vertex (global, publishers/openai) with the Google token as key',
      oa.length === 1 && oa[0].opts.baseURL === OPENAI_BASE && /^ya29\.offline-token-\d+$/.test(oa[0].opts.apiKey)
      && Object.keys(oa[0].opts).sort().join() === 'apiKey,baseURL,organization,project'
      && oa[0].opts.organization === null && oa[0].opts.project === null, JSON.stringify(oa));
    check('Talker GPT-6 Luna: one Responses call on the Vertex client',
      r.calls.length === 1 && r.calls[0].kind === 'openai-vertex' && r.calls[0].method === 'responses.create');
    const want = withoutInclude(direct['talker-openai-history'].calls[0].params);
    check('Talker GPT-6 Luna: request = Direct request minus `include: [file_search_call.results]` (no hosted file search on Vertex); store:false, stream:true',
      r.calls[0] && same(r.calls[0].params, want) && r.calls[0].params.store === false && r.calls[0].params.stream === true,
      firstDiff(want, r.calls[0] && r.calls[0].params));
    check('Talker GPT-6 Luna: usage row provider openai@vertex',
      same(r.usage, direct['talker-openai-history'].usage.map(asVertexRow)), JSON.stringify(r.usage));
  }
  {
    const tokenBefore = tokenN;
    const r = await runScenario(byId['thinker-openai'], VERTEX); // gpt-6.1-terra one-shot JSON
    const oa = r.ctor.filter(c => c.cls === 'OpenAI');
    check('Thinker GPT-6.1 Terra (one-shot JSON): Vertex call, request identical to Direct',
      r.errors.length === 0 && r.calls.length === 1 && r.calls[0].kind === 'openai-vertex'
      && same(r.calls[0].params, direct['thinker-openai'].calls[0].params),
      JSON.stringify(r.errors) + firstDiff(direct['thinker-openai'].calls[0].params, r.calls[0] && r.calls[0].params));
    check('A fresh Google token per call: the call used the NEW token (new client), never a stale one',
      tokenN === tokenBefore + 1 && oa.length === 1 && oa[0].opts.apiKey === `ya29.offline-token-${tokenN}` && r.calls[0].apiKey === oa[0].opts.apiKey,
      JSON.stringify({ tokenN, oa, used: r.calls[0] && r.calls[0].apiKey }));
    check('Google auth object built once (the library caches + refreshes the token)', !r.ctor.some(c => c.cls === 'GoogleAuth'));
    check('Thinker GPT-6.1 Terra: row openai@vertex',
      same(r.usage, direct['thinker-openai'].usage.map(asVertexRow)), JSON.stringify(r.usage));
  }

  console.log('\n── B. Vertex agent: Gemini ──');
  for (const id of ['talker-gemini', 'thinker-gemini']) {
    const r = await runScenario(byId[id], VERTEX);
    const g = r.ctor.filter(c => c.cls === 'GoogleGenAI');
    if (id === 'talker-gemini') {
      check('Gemini: GoogleGenAI({ vertexai: true, project, location: global }) — no API key',
        g.length === 1 && same(g[0].opts, { vertexai: true, project: PROJECT, location: 'global' }), JSON.stringify(g));
    } else {
      check('Gemini: Vertex client reused', g.length === 0, JSON.stringify(g));
    }
    check(`${id}: Vertex client, request identical to Direct, row google@vertex`,
      r.errors.length === 0 && r.calls.length === 1 && r.calls[0].kind === 'google-vertex'
      && same(r.calls[0].params, direct[id].calls[0].params)
      && same(r.calls[0].message, direct[id].calls[0].message)
      && same(r.usage, direct[id].usage.map(asVertexRow)),
      JSON.stringify(r.errors) + firstDiff(direct[id].calls[0], r.calls[0]));
  }

  console.log('\n── B. Nested model (KB Retriever LLM trigger) ──');
  {
    const inst = m => ({
      instanceId: 'inst-kb', pluginId: 'kb-retriever', lane: 'main', promptTemplate: '', context: { history: { mode: 'none' } },
      config: { name: 'kb', kbNamespaces: ['ns1'], trigger: { mode: 'llm', prompt: 'Retrieve? yes/no', model: { providerId: m.startsWith('gpt') ? 'openai' : 'anthropic', modelId: m } } },
    });
    let events = [];
    let before = rec.calls.length;
    await runAddon({ ctx: ctxFor({ modelRoute: 'vertex' }, events), instance: inst('gpt-6-luna') });
    check('KB Retriever trigger on a Vertex agent → the nested model call goes to Vertex',
      rec.calls.length === before + 1 && rec.calls[before].kind === 'openai-vertex' && !events.some(e => e.type === 'addon.error'),
      JSON.stringify(rec.calls.slice(before).map(c => c.kind)) + JSON.stringify(events.filter(e => e.type === 'addon.error')));
    events = []; before = rec.calls.length;
    await runAddon({ ctx: ctxFor({ modelRoute: 'vertex' }, events), instance: inst('gpt-4o-mini') });
    const err = events.find(e => e.type === 'addon.error');
    check('KB Retriever trigger with a non-Vertex model → loud add-on error naming the model, no call',
      rec.calls.length === before && err && /gpt-4o-mini/.test(err.payload.error.message) && /not available on Vertex/.test(err.payload.error.message),
      JSON.stringify(err && err.payload));
  }

  console.log('\n── B. VERTEX_LOCATION override ──');
  {
    process.env.VERTEX_LOCATION = 'us-east5';
    const r1 = await runScenario(byId['talker-claude'], VERTEX);
    check('Claude uses VERTEX_LOCATION as its region',
      r1.ctor.some(c => c.cls === 'AnthropicVertex' && c.opts.region === 'us-east5' && c.opts.projectId === PROJECT) && r1.calls[0] && r1.calls[0].kind === 'anthropic-vertex', JSON.stringify(r1.ctor));
    const r2 = await runScenario(byId['thinker-openai'], VERTEX);
    check('OpenAI stays on the global endpoint whatever VERTEX_LOCATION says',
      r2.ctor.some(c => c.cls === 'OpenAI' && c.opts.baseURL === OPENAI_BASE) && r2.calls[0] && r2.calls[0].kind === 'openai-vertex', JSON.stringify(r2.ctor));
    const r3 = await runScenario(byId['thinker-gemini'], VERTEX);
    check('Gemini uses VERTEX_LOCATION', r3.ctor.some(c => c.cls === 'GoogleGenAI' && c.opts.location === 'us-east5' && c.opts.vertexai === true), JSON.stringify(r3.ctor));
    delete process.env.VERTEX_LOCATION;
  }

  console.log('\n── C. Loud failures (never a silent direct call) ──');
  {
    const before = { ctor: rec.ctor.length, calls: rec.calls.length };
    const r = await runScenario(byId['talker-openai'], VERTEX); // gpt-5.6-terra — not on Vertex
    const e = r.errors[0];
    check('Model not on Vertex (GPT-5.6 Terra Talker) → add-on error naming the model',
      e && /gpt-5\.6-terra/.test(e.message) && /not available on Vertex AI/.test(e.message), JSON.stringify(r.errors));
    check('… and no client built, no request sent (neither Vertex nor direct)', rec.ctor.length === before.ctor && rec.calls.length === before.calls);
  }
  {
    const before = rec.calls.length;
    const r = await runScenario(byId['thinker-openai-websearch'], VERTEX); // gpt-6.1-terra + web search
    check('OpenAI web search on Vertex (Thinker GPT-6.1 Terra, one-shot) → loud error, no request',
      r.errors[0] && /Web search on an OpenAI model is not available on Vertex/.test(r.errors[0].message) && rec.calls.length === before, JSON.stringify(r.errors));
  }
  {
    const before = rec.calls.length;
    const r = await runScenario({ ...byId['talker-openai-websearch'], modelId: 'gpt-6.1-terra' }, VERTEX);
    check('OpenAI web search on Vertex (Talker GPT-6.1 Terra, streaming) → loud error, no request',
      r.errors[0] && /Web search on an OpenAI model is not available on Vertex/.test(r.errors[0].message) && rec.calls.length === before, JSON.stringify(r.errors));
  }
  {
    delete process.env.VERTEX_PROJECT_ID;
    const before = { ctor: rec.ctor.length, calls: rec.calls.length };
    const r1 = await runScenario(byId['talker-claude'], VERTEX);
    const r2 = await runScenario(byId['thinker-openai'], VERTEX);
    const r3 = await runScenario(byId['thinker-gemini'], VERTEX);
    check('VERTEX_PROJECT_ID missing → every provider fails loudly, naming the setting',
      [r1, r2, r3].every(r => r.errors[0] && /VERTEX_PROJECT_ID is not set/.test(r.errors[0].message)), JSON.stringify([r1, r2, r3].map(r => r.errors)));
    check('… and nothing was built or sent (no direct fallback)', rec.ctor.length === before.ctor && rec.calls.length === before.calls);
    process.env.VERTEX_PROJECT_ID = PROJECT;
  }
  {
    const before = rec.calls.length;
    const real = FakeGoogleAuth.prototype.getAccessToken;
    FakeGoogleAuth.prototype.getAccessToken = async () => { throw new Error('Could not load the default credentials'); };
    const r = await runScenario(byId['thinker-openai'], VERTEX);
    FakeGoogleAuth.prototype.getAccessToken = real;
    check('No Google credentials → loud error explaining roles/aiplatform.user / ADC, no request',
      r.errors[0] && /no Google credentials could be loaded/.test(r.errors[0].message) && /roles\/aiplatform\.user/.test(r.errors[0].message) && rec.calls.length === before, JSON.stringify(r.errors));
  }
  const rejects = async (name, fn, re) => {
    const before = rec.calls.length;
    let err = null;
    try {
      const out = fn();
      if (out && typeof out[Symbol.asyncIterator] === 'function') { for await (const _ of out) { /* drain */ } } else await out;
    } catch (e) { err = e; }
    check(name, err && re.test(err.message) && rec.calls.length === before, err ? err.message.slice(0, 200) : 'no error');
  };
  await rejects('Claude one-shot with Files API documents on Vertex → loud error, no request',
    () => claude.sendOneShot('S', 'M', { model: 'claude-sonnet-4-6', ...VERTEX, knowledgeBase: { anthropicFileIds: ['file_1'] } }),
    /Anthropic Files API\) is not available on Vertex/);
  await rejects('Claude stream with Files API documents on Vertex → loud error, no request',
    () => claude.sendMessageStreamWithPrompt('M', 1, { model: 'claude-sonnet-4-6', ...VERTEX, historyMessages: [], anthropicDocuments: ['file_1'] }),
    /Anthropic Files API\) is not available on Vertex/);
  await rejects('OpenAI one-shot with hosted file search on Vertex → loud error, no request',
    () => openai.sendOneShot('S', 'M', { model: 'gpt-6.1-terra', ...VERTEX, knowledgeBase: { enabled: true, storeIds: ['vs_1'] } }),
    /file search \(vector stores\) is not available on Vertex/);
  await rejects('Gemini with file search stores on Vertex → loud error, no request',
    () => google.sendOneShot('S', 'M', { model: 'gemini-2.5-pro', ...VERTEX, knowledgeBase: { enabled: true, corpusIds: ['fileSearchStores/x'] } }),
    /Gemini file search \(file search stores\) is not available on Vertex/);
  await rejects('llm.sendOneShot with an unknown model on Vertex → loud error (no "default to OpenAI")',
    () => llm.sendOneShot('S', 'M', { model: 'gpt-nope', ...VERTEX }), /"gpt-nope" is not available on Vertex/);
  await rejects('llm.sendMessageStreamWithPrompt with a non-Vertex model → loud error',
    () => llm.sendMessageStreamWithPrompt('M', 1, { model: 'gpt-4o', ...VERTEX, historyMessages: [] }), /GPT-4o \(gpt-4o\) is not available on Vertex/);
  {
    let err = null;
    try { await llm.sendOneShot('S', 'M', { model: 'gpt-4o-mini', ...VERTEX }); } catch (e) { err = e; }
    check('The route error is a ModelRouteError with code "model_route" (never retried)', err && err.code === 'model_route' && err.name === 'ModelRouteError');
  }

  console.log('\n── B/C. Over the whole Vertex section ──');
  const vCtor = rec.ctor.slice(vertexStart.ctor);
  const vCalls = rec.calls.slice(vertexStart.calls);
  check('No DIRECT client was constructed while running the Vertex agent',
    !vCtor.some(c => c.cls === 'Anthropic' || (c.cls === 'OpenAI' && !(c.opts && c.opts.baseURL)) || (c.cls === 'GoogleGenAI' && !(c.opts && c.opts.vertexai))), JSON.stringify(vCtor.map(c => c.cls)));
  check('No request went to a direct API while running the Vertex agent',
    vCalls.length > 0 && vCalls.every(c => /-vertex$/.test(c.kind)), JSON.stringify(vCalls.map(c => c.kind)));
  {
    const r = await runScenario(byId['talker-claude'], {});
    check('A Direct agent right after Vertex runs is still the baseline (direct client, same request, plain provider)',
      r.calls.length === 1 && r.calls[0].kind === 'anthropic'
      && same(r.calls[0].params, direct['talker-claude'].calls[0].params)
      && same(r.usage, direct['talker-claude'].usage));
  }

  console.log('\n── D. Units ──');
  check('normalize: absent / "direct" / junk → direct; "vertex" → vertex',
    modelRoute.normalize(undefined) === 'direct' && modelRoute.normalize('direct') === 'direct' && modelRoute.normalize('VERTEX') === 'direct' && modelRoute.normalize('vertex') === 'vertex');
  check('routeOfAgentBody', modelRoute.routeOfAgentBody({ modelRoute: 'vertex' }) === 'vertex' && modelRoute.routeOfAgentBody({}) === 'direct' && modelRoute.routeOfAgentBody(null) === 'direct');
  check('Registry: every Claude model is on Vertex', models.MODELS.filter(m => m.providerId === 'anthropic').every(m => m.vertex === true));
  check('Registry: OpenAI on Vertex = exactly gpt-6-luna, gpt-6.1-sol, gpt-6.1-terra, gpt-6-astra',
    same(models.MODELS.filter(m => m.providerId === 'openai' && m.vertex).map(m => m.id).sort(), ['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra']));
  check('Registry: Gemini 2.5 Pro / Flash on Vertex', modelRoute.onVertex('gemini-2.5-pro') && modelRoute.onVertex('gemini-2.5-flash'));
  check('Registry: Vertex ids — Haiku 4.5 dated snapshot, others unchanged',
    modelRoute.vertexModelId('claude-haiku-4-5') === 'claude-haiku-4-5@20251001' && modelRoute.vertexModelId('claude-sonnet-5-5') === 'claude-sonnet-5-5' && modelRoute.vertexModelId('gpt-6.1-terra') === 'gpt-6.1-terra');
  const api = models.listForApi();
  check('GET /api/models payload carries `vertex` (and vertexId) per model',
    api.models.find(m => m.id === 'gpt-6.1-terra').vertex === true && !api.models.find(m => m.id === 'gpt-5.6-terra').vertex
    && api.providers.find(p => p.id === 'anthropic').models.find(m => m.id === 'claude-haiku-4-5').vertexId === 'claude-haiku-4-5@20251001');
  check('usageProvider / routeOfUsageProvider round-trip',
    modelRoute.usageProvider('openai', 'vertex') === 'openai@vertex' && modelRoute.usageProvider('openai', 'direct') === 'openai'
    && modelRoute.routeOfUsageProvider('anthropic@vertex') === 'vertex' && modelRoute.routeOfUsageProvider('anthropic') === 'direct');
  const probs = modelRoute.vertexProblems(
    {
      cortex: [{ pluginId: 'thinker', config: { name: 'Planner', model: { providerId: 'openai', modelId: 'gpt-5.6-terra' } } }],
      profiler: { panels: [{ title: 'Risk', source: { kind: 'prompt', model: { providerId: 'openai', modelId: 'gpt-4o-mini' } } }], ask: { enabled: true, model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' } } },
    },
    [{ name: 'Main', addons: [
      { pluginId: 'talker', config: { name: 'Voice', model: { providerId: 'openai', modelId: 'gpt-6.1-terra' }, webSearch: { enabled: true } } },
      { pluginId: 'kb-retriever', config: { name: 'KB', trigger: { mode: 'llm', model: { providerId: 'openai', modelId: 'gpt-4o-mini' } } } },
      { pluginId: 'field-extractor', config: { name: 'Ext', model: { providerId: 'anthropic', modelId: 'claude-haiku-5-5' } } },
    ] }],
  );
  check('vertexProblems: lists non-Vertex models (agent level, Profiler panel, nested KB trigger) + OpenAI web search; Vertex models not listed',
    probs.length === 4
    && probs.some(p => p.reason === 'model' && p.modelId === 'gpt-5.6-terra' && p.where === 'Agent level · Planner')
    && probs.some(p => p.reason === 'model' && p.modelId === 'gpt-4o-mini' && p.where === 'Profiler · Risk')
    && probs.some(p => p.reason === 'model' && p.modelId === 'gpt-4o-mini' && p.crew === 'Main' && /KB trigger/.test(p.where))
    && probs.some(p => p.reason === 'web_search' && p.addon === 'Voice' && p.crew === 'Main')
    && !probs.some(p => p.modelId === 'claude-haiku-5-5' || p.modelId === 'claude-sonnet-4-6'),
    JSON.stringify(probs));
  check('vertexProblems: an all-Vertex agent (Claude + Claude web search) has none',
    modelRoute.vertexProblems({ cortex: [] }, [{ name: 'A', addons: [{ pluginId: 'talker', config: { model: { providerId: 'anthropic', modelId: 'claude-sonnet-5-5' }, webSearch: { enabled: true } } }] }]).length === 0);
  const runtimeSrc = fs.readFileSync(path.join(SERVER, 'builder/routes/runtimeRoute.js'), 'utf8');
  check('Ask Profiler (runtimeRoute) passes the agent\'s route', /routeOfAgentBody\(runnable\.agent\.body\)/.test(runtimeSrc));
  const hydrateSrc = fs.readFileSync(path.join(SERVER, 'builder/services/builderProjects.js'), 'utf8');
  check('builderProjects hydrates modelRoute from the body (survives a reload)', /modelRoute:\s+agentBody\.modelRoute/.test(hydrateSrc));
}

// ════ E. The Builder MCP door (mcpRoute mounted alone, fake project store) ════
async function mcpPart() {
  console.log('\n── E. Builder MCP: read + set the route ──');
  process.env.VERTEX_PROJECT_ID = 'lybi-staging';
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/builder/mcp', require(path.join(SERVER, 'builder/routes/mcpRoute.js')));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/builder/mcp`;
  const get = async u => { const r = await fetch(base + u); return { status: r.status, text: await r.text() }; };
  const post = async (u, b) => {
    const r = await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, text: await r.text() };
  };
  const BODY = { name: 'Bank', slug: 'bank', spec: '', persona: '', fields: [], personas: [], domains: [], parameters: [], enums: [], cortex: [], snippets: [] };
  try {
    const entry = await get('/');
    check('Entry page: Reading row + "Model route" section + the easy-to-get-wrong line',
      entry.status === 200 && entry.text.includes('/agents/<slug>/model-route') && /\*\*Model route — Direct or Vertex \(BETA\)\.\*\*/.test(entry.text)
      && /`modelRoute` in the agent body/.test(entry.text) && /vertex: true/.test(entry.text), entry.text.slice(0, 120));
    check('Entry page says the route is BETA and Vertex is not active yet',
      /Model route — Direct or Vertex \(BETA\)/.test(entry.text) && /Vertex is NOT active yet/.test(entry.text));

    mcpState.body = { ...BODY };
    const r1 = await get('/agents/bank/model-route');
    check('GET model-route on a Direct agent: says DIRECT, this server\'s Vertex project, and what WOULD fail',
      r1.status === 200 && /Model route: DIRECT/.test(r1.text) && /project lybi-staging, location global/.test(r1.text)
      && /If this agent is switched to Vertex, these would fail — 1:/.test(r1.text) && /Crew "Main" · Voice — GPT-5\.6 Terra \(gpt-5\.6-terra\) is not on Vertex/.test(r1.text)
      && !/claude-haiku-5-5/.test(r1.text) && /Still direct on either route/.test(r1.text), r1.text);
    check('GET model-route carries the BETA line', /BETA: Vertex is not active yet/.test(r1.text), r1.text);
    check('GET model-route on an unknown agent → 404 with what to do', (await get('/agents/nope/model-route')).status === 404);

    const bad = await post('/agents/bank/model-route', { route: 'bogus' });
    check('POST model-route with a bad route → 400, nothing saved', bad.status === 400 && mcpState.saved.length === 0);

    const r2 = await post('/agents/bank/model-route', { route: 'vertex' });
    const sv = mcpState.saved[mcpState.saved.length - 1];
    check('POST { route: "vertex" } → a NEW version with modelRoute "vertex", made active (never published)',
      r2.status === 200 && sv && sv.body.modelRoute === 'vertex' && sv.number === 2 && mcpState.activated.includes(sv.versionId)
      && /Model route: Vertex/.test(sv.description) && /NOT live to customers/.test(r2.text), r2.text);
    check('POST model-route answer carries the BETA line', /BETA: Vertex is not active yet/.test(r2.text), r2.text);
    check('… the rest of the body is unchanged', sv && JSON.stringify({ ...sv.body, modelRoute: undefined }) === JSON.stringify({ ...BODY, modelRoute: undefined }));
    check('… and the answer lists the add-on that now FAILS on Vertex',
      /Model route: VERTEX/.test(r2.text) && /These FAIL on Vertex right now \(no fallback to the direct API\) — 1:/.test(r2.text) && /gpt-5\.6-terra/.test(r2.text), r2.text);

    const same = await post('/agents/bank/model-route', { route: 'vertex' });
    check('POST the route it already has → nothing saved, says so', same.status === 200 && /already vertex/.test(same.text) && mcpState.saved.length === 1);

    const n0 = mcpState.saved.length;
    const r3 = await post('/agents/bank', { body: { ...BODY, spec: 'edited' } });
    const sv3 = mcpState.saved[mcpState.saved.length - 1];
    check('A whole-body save WITHOUT modelRoute keeps Vertex (never quietly back to direct)',
      r3.status === 200 && mcpState.saved.length === n0 + 1 && sv3.body.modelRoute === 'vertex' && sv3.body.spec === 'edited', r3.text);
    check('… and its answer shows the Vertex problems', /These FAIL on Vertex right now/.test(r3.text));

    const r4 = await post('/agents/bank', { body: { ...BODY, modelRoute: 'sometimes' } });
    check('A body with a bad modelRoute → 400, nothing saved', r4.status === 400 && mcpState.saved.length === n0 + 1, r4.text);

    const r5 = await post('/agents/bank', { body: { ...BODY, modelRoute: 'direct' } });
    const sv5 = mcpState.saved[mcpState.saved.length - 1];
    check('A body with modelRoute "direct" → saved WITHOUT the key (Direct = absent, as the Builder stores it)',
      r5.status === 200 && !('modelRoute' in sv5.body) && !/These FAIL on Vertex/.test(r5.text), r5.text);

    const r6 = await post('/agents/bank', { body: { ...BODY } });
    const sv6 = mcpState.saved[mcpState.saved.length - 1];
    check('A Direct agent saved without modelRoute stays Direct (no key added)', r6.status === 200 && !('modelRoute' in sv6.body));

    mcpState.body = { ...BODY, modelRoute: 'vertex' };
    const r7 = await post('/agents/bank/model-route', { route: 'direct' });
    const sv7 = mcpState.saved[mcpState.saved.length - 1];
    check('POST { route: "direct" } on a Vertex agent → new version with the key removed',
      r7.status === 200 && !('modelRoute' in sv7.body) && /Model route: DIRECT/.test(r7.text), r7.text);

    delete process.env.VERTEX_PROJECT_ID;
    const r8 = await get('/agents/bank/model-route');
    check('GET model-route on a server without VERTEX_PROJECT_ID says Vertex is NOT set up',
      /Vertex on this server: NOT set up \(VERTEX_PROJECT_ID is empty\)/.test(r8.text), r8.text);
  } finally {
    server.close();
  }
}

// ════ F. The REAL SDKs — wire URLs (child process) ════
function realSdkPart() {
  console.log('\n── F. Real SDKs: what would go on the wire (fetch intercepted, no network) ──');
  const { execFileSync } = require('child_process');
  let out = '';
  try {
    out = execFileSync(process.execPath, [__filename, '--real-sdk-child'], { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String(e.stdout || '');
    console.log(String(e.stderr || '').slice(-800));
  }
  const line = out.split('\n').find(l => l.startsWith('RESULT:'));
  const seen = line ? JSON.parse(line.slice(7)) : [];
  const V = 'https://aiplatform.googleapis.com/v1/projects/lybi-staging/locations/global/publishers';
  const find = re => seen.find(x => re.test(x.url));
  const c1 = find(/anthropic\/models\/claude-haiku-4-5@20251001:rawPredict$/);
  check('Claude one-shot (Haiku 4.5) → Vertex rawPredict URL with the @-snapshot id + Google bearer',
    c1 && c1.url === `${V}/anthropic/models/claude-haiku-4-5@20251001:rawPredict` && c1.auth === 'Bearer ya29.child', JSON.stringify(seen));
  check('… body: model moved into the URL, anthropic_version added (the SDK\'s Vertex shape)',
    c1 && c1.body && !('model' in c1.body) && typeof c1.body.anthropic_version === 'string' && c1.body.max_tokens === 10, JSON.stringify(c1 && c1.body));
  const c2 = find(/anthropic\/models\/claude-sonnet-5-5:streamRawPredict$/);
  check('Claude stream (Sonnet 5.5) → Vertex streamRawPredict URL',
    c2 && c2.url === `${V}/anthropic/models/claude-sonnet-5-5:streamRawPredict` && c2.auth === 'Bearer ya29.child', JSON.stringify(seen));
  const o1 = find(/publishers\/openai\/v1\/responses$/);
  check('OpenAI (GPT-6.1 Terra) → Vertex Responses URL (global, publishers/openai) + Google bearer',
    o1 && o1.url === `${V}/openai/v1/responses` && o1.auth === 'Bearer ya29.child' && o1.body && o1.body.model === 'gpt-6.1-terra' && o1.body.store === false, JSON.stringify(o1));
  const g1 = find(/publishers\/google\/models\/gemini-2\.5-flash:generateContent$/);
  check('Gemini (2.5 Flash, our constructor options) → Vertex generateContent URL in the project',
    g1 && /^https:\/\/aiplatform\.googleapis\.com\/v1(beta1)?\/projects\/lybi-staging\/locations\/global\/publishers\/google\/models\/gemini-2\.5-flash:generateContent$/.test(g1.url), JSON.stringify(seen));
  check('… Gemini on Vertex uses the Google bearer even with GEMINI_API_KEY set (project/location win over the env key)',
    g1 && g1.auth === 'Bearer ya29.child' && !g1.apiKeyHeader, JSON.stringify(g1 && { auth: g1.auth, apiKeyHeader: g1.apiKeyHeader }));
  check('No Vertex request carries a direct-provider credential or org header (x-api-key, x-goog-api-key, OpenAI-Organization, OpenAI-Project)', seen.length >= 4 && seen.every(x => !x.apiKeyHeader), JSON.stringify(seen.map(x => x.apiKeyHeader)));
  const af = out.split(/\r?\n/).find(l => l.startsWith('AUTHFAIL:'));
  const authFail = af ? JSON.parse(af.slice(9)) : null;
  check('Real Vertex SDK, no Google credentials → the call fails loudly, nothing sent, NO unhandled rejection (it would exit the server)',
    authFail && authFail.error && /credential/i.test(authFail.error) && authFail.requests === 0 && authFail.unhandled === 0, JSON.stringify(authFail));
  check('No request to a direct API host',
    seen.length >= 4 && !seen.some(x => /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/.test(x.url)), JSON.stringify(seen.map(x => x.url)));
}

async function realSdkChild() {
  process.env.DB_HOST = '127.0.0.255';
  process.env.DATABASE_URL = 'postgres://dead:dead@127.0.0.255:1/dead';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-offline-test';
  process.env.OPENAI_API_KEY = 'sk-offline-test';
  // Set like production: the Gemini SDK must still use OAuth, not this key.
  process.env.GEMINI_API_KEY = 'gemini-direct-key-must-not-be-used';
  process.env.OPENAI_ORG_ID = 'org-must-not-be-sent';
  process.env.OPENAI_PROJECT_ID = 'proj-must-not-be-sent';
  process.env.VERTEX_PROJECT_ID = 'lybi-staging';
  delete process.env.VERTEX_LOCATION;
  const stubAt = (file, exp) => { require.cache[file] = { id: file, filename: file, loaded: true, exports: exp }; };
  stubAt(require.resolve(path.join(SERVER, 'services/db.pg.js')),
    new Proxy({}, { get: (_, p) => (p === 'then' || typeof p === 'symbol' ? undefined : () => { throw new Error('no DB'); }) }));
  // Fake Google auth (no credentials, no token endpoint): used by modelRoute
  // (the OpenAI token) and by @anthropic-ai/vertex-sdk (same top-level package).
  const fakeClient = { projectId: 'lybi-staging', getRequestHeaders: async () => ({ Authorization: 'Bearer ya29.child' }), getAccessToken: async () => ({ token: 'ya29.child' }) };
  class GoogleAuth {
    async getClient() { if (process.env.VR_FAIL_AUTH) throw new Error('Could not load the default credentials'); return fakeClient; }
    async getAccessToken() { return 'ya29.child'; }
  }
  stubAt(require.resolve('google-auth-library', { paths: [SERVER] }), { GoogleAuth });
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    let auth = null;
    const h = init.headers;
    let apiKeyHeader = false;
    try {
      auth = h instanceof Headers ? h.get('authorization') : (h && (h.authorization || h.Authorization)) || null;
      const hk = n => (h instanceof Headers ? h.has(n) : !!(h && Object.keys(h).some(k => k.toLowerCase() === n && h[k] != null)));
      apiKeyHeader = ['x-goog-api-key', 'x-api-key', 'openai-organization', 'openai-project'].some(hk);
    } catch { /* */ }
    let body = null;
    try { body = init.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
    seen.push({ url, auth, apiKeyHeader, body });
    return new Response(JSON.stringify({ error: { message: 'intercepted by the battery' } }), { status: 418, headers: { 'content-type': 'application/json' } });
  };
  const quiet = async fn => {
    try {
      const r = fn();
      if (r && r[Symbol.asyncIterator]) { for await (const _ of r) { /* drain */ } } else await r;
    } catch { /* the 418 is expected */ }
  };
  const claude = require(path.join(SERVER, 'services/llm.claude.js'));
  const openai = require(path.join(SERVER, 'services/llm.openai.js'));
  const keep = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  await quiet(() => claude.sendOneShot('S', 'M', { model: 'claude-haiku-4-5', modelRoute: 'vertex', maxTokens: 10 }));
  await quiet(() => claude.sendMessageStreamWithPrompt('M', 1, { prompt: 'S', model: 'claude-sonnet-5-5', modelRoute: 'vertex', maxTokens: 10, historyMessages: [] }));
  await quiet(() => openai.sendOneShot('S', 'M', { model: 'gpt-6.1-terra', modelRoute: 'vertex', maxTokens: 10 }));
  // Gemini: the real SDK with exactly the options llm.google.js passes (plus a
  // fake auth client — its nested google-auth-library is ESM, not stubbable).
  const genaiPath = require.resolve('@google/genai', { paths: [SERVER] });
  const genai = await import(require('url').pathToFileURL(genaiPath).href);
  const g = new genai.GoogleGenAI({
    vertexai: true, project: 'lybi-staging', location: 'global',
    googleAuthOptions: { authClient: { getRequestHeaders: async () => new Headers({ authorization: 'Bearer ya29.child' }), getAccessToken: async () => ({ token: 'ya29.child' }) } },
  });
  await quiet(() => g.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hi' }));
  // No credentials: a NEW Claude Vertex client (another location) whose auth
  // fails. Must fail the call loudly — and must NOT leave an unhandled
  // rejection (on the server that exits the process, via the error center).
  let unhandled = 0;
  process.on('unhandledRejection', () => { unhandled += 1; });
  process.env.VR_FAIL_AUTH = '1';
  process.env.VERTEX_LOCATION = 'us-east5';
  const before = seen.length;
  let authErr = null;
  try { await claude.sendOneShot('S', 'M', { model: 'claude-haiku-5-5', modelRoute: 'vertex', maxTokens: 10 }); } catch (e) { authErr = e.message; }
  await new Promise(r => setTimeout(r, 300));
  const authFail = { error: authErr, unhandled, requests: seen.length - before };
  Object.assign(console, keep);
  console.log(`RESULT:${JSON.stringify(seen.slice(0, before))}`);
  console.log(`AUTHFAIL:${JSON.stringify(authFail)}`);
}
