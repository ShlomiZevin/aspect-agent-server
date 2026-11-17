#!/usr/bin/env node
/**
 * LIVE check for #984 — the Vertex model route, once Vertex quota / model
 * access exists. Does NOTHING without --live.
 *
 * One tiny Talker turn per provider through the REAL path — runAddon →
 * Talker plugin → services/llm.js → llm.claude / llm.openai / llm.google —
 * on an agent whose modelRoute is 'vertex', with the REAL SDKs and Google
 * Application Default Credentials. Every outgoing HTTP request is printed
 * (host + path), so you can see each call hit aiplatform.googleapis.com
 * and never a direct API. The direct provider keys are blanked first, so a
 * silent direct fallback could not even authenticate.
 *
 * No database: db.pg is a stub (the llm_usage rows are printed instead of
 * written), history / run store are stubs. It never reads .env.
 *
 *   VERTEX_PROJECT_ID=lybi-staging [VERTEX_LOCATION=global] \
 *     node scripts/check-vertex-route.js --live [--only=claude,openai,gemini]
 *     [--claude=claude-haiku-5-5] [--openai=gpt-6-luna] [--gemini=gemini-2.5-flash]
 *
 * Credentials: locally `gcloud auth application-default login` (an account
 * with roles/aiplatform.user on the project); on Cloud Run the service
 * account. The Claude / Gemini models must be enabled in the project's
 * Model Garden; GPT-6 models need the OpenAI-on-Vertex preview access.
 * Cost: three ~30-token calls.
 */
const path = require('path');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

if (!args.includes('--live')) {
  console.log('check-vertex-route: nothing done. This makes REAL model calls through Vertex AI.');
  console.log('Run:  VERTEX_PROJECT_ID=<project> node scripts/check-vertex-route.js --live [--only=claude,openai,gemini]');
  process.exit(0);
}
if (!process.env.VERTEX_PROJECT_ID) {
  console.error('VERTEX_PROJECT_ID is not set — e.g. VERTEX_PROJECT_ID=lybi-staging');
  process.exit(1);
}

const SERVER = path.join(__dirname, '..');
// No database, ever: a dead DB address + a stub module.
process.env.DB_HOST = '127.0.0.255';
process.env.DATABASE_URL = 'postgres://dead:dead@127.0.0.255:1/dead';
// Blank the direct keys: if anything tried to go direct, it could not authenticate.
process.env.ANTHROPIC_API_KEY = 'direct-key-disabled-for-vertex-check';
process.env.OPENAI_API_KEY = 'direct-key-disabled-for-vertex-check';
process.env.GEMINI_API_KEY = 'direct-key-disabled-for-vertex-check';

// ── print every outgoing request ──
const hits = [];
const DIRECT_HOSTS = /(^|\.)api\.anthropic\.com$|(^|\.)api\.openai\.com$|(^|\.)generativelanguage\.googleapis\.com$/;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input));
  const line = `${(init && init.method) || (input && input.method) || 'GET'} ${url.host}${url.pathname}`;
  hits.push({ host: url.host, line });
  console.log(`   → ${line}`);
  return realFetch(input, init);
};
// Some clients (gaxios / node-fetch) use the https module instead of fetch.
const https = require('https');
const realRequest = https.request;
https.request = function patchedRequest(...a) {
  try {
    const o = a[0] instanceof URL ? a[0] : (typeof a[0] === 'string' ? new URL(a[0]) : a[0]);
    const host = o.host || o.hostname || '';
    const line = `${o.method || 'GET'} ${host}${o.pathname || o.path || ''}`.replace(/\?.*$/, '');
    hits.push({ host: String(host).replace(/:\d+$/, ''), line });
    console.log(`   → ${line}`);
  } catch { /* logging only */ }
  return realRequest.apply(this, a);
};

function stub(rel, exportsObj) {
  const file = require.resolve(path.join(SERVER, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}
const usageRows = [];
stub('services/db.pg.js', new Proxy({}, {
  get(_, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    if (prop === 'getDrizzle') {
      return () => new Proxy({
        insert: () => ({ values: v => ({ execute: () => { usageRows.push(v); return Promise.resolve(); } }) }),
      }, { get: (t, p) => (p in t ? t[p] : () => { throw new Error('no DB in this check'); }) });
    }
    return () => { throw new Error('no DB in this check'); };
  },
}));
stub('builder/runtime/historyService.js', { loadHistory: async () => ({ messages: [], resolution: { requested: 'none', effective: 'none' } }) });
stub('builder/runtime/addonRunsStore.js', { insertRun: async () => {} });

const llm = require(path.join(SERVER, 'services/llm.js'));
const { logUsage } = require(path.join(SERVER, 'services/usageLogger.js'));
const modelRoute = require(path.join(SERVER, 'services/modelRoute.js'));
require(path.join(SERVER, 'builder/plugins'));
const { runAddon } = require(path.join(SERVER, 'builder/runtime/addonRunner.js'));

const CASES = {
  claude: { providerId: 'anthropic', modelId: arg('claude', 'claude-haiku-5-5') },
  openai: { providerId: 'openai', modelId: arg('openai', 'gpt-6-luna') },
  gemini: { providerId: 'google', modelId: arg('gemini', 'gemini-2.5-flash') },
};
const only = arg('only', 'claude,openai,gemini').split(',').map(s => s.trim()).filter(Boolean);

(async () => {
  const cfg = modelRoute.vertexConfig();
  console.log(`Vertex project ${cfg.projectId}, location ${cfg.location} (OpenAI: global)\n`);
  let bad = 0;
  for (const key of only) {
    const c = CASES[key];
    if (!c) { console.log(`unknown provider "${key}" — use claude, openai, gemini`); bad++; continue; }
    console.log(`── ${key}: ${c.modelId} (Vertex id ${modelRoute.vertexModelId(c.modelId)}) ──`);
    const events = [];
    const before = hits.length;
    const rowsBefore = usageRows.length;
    const started = Date.now();
    await runAddon({
      ctx: {
        runnable: { agent: { body: { modelRoute: 'vertex' } }, crew: { id: 'crew_check', body: { name: 'Check' } } },
        agentSlug: 'vertex-check', ownerUserId: 'vertex-check', userId: 0,
        conversationId: 0, assistantMessageId: 0,
        userMessage: 'Reply with the single word: ok',
        crewLabel: 'Check', agentNameForLogs: 'vertex-check',
        agentPersonas: [], agentParameters: [], agentEnums: [], memory: {},
        memoryValuesByDomain: () => ({}), memoryDomainList: () => [],
        thinkingValuesByDomain: () => ({}), thinkingDomainList: () => [],
        retrievalValueOf: () => '', fieldValueOf: () => '',
        drizzle: null, convRow: null,
        emit: (type, payload) => events.push({ type, payload }),
        llm, logUsage, resolveModelLabel: () => null,
        historyExcludeFromMessageId: 0, historyCache: new Map(),
      },
      instance: {
        instanceId: `check-${key}`, pluginId: 'talker', lane: 'main', outputType: 'text-to-user',
        promptTemplate: 'You are a connectivity check. Answer in one word.',
        context: { history: { mode: 'none' } },
        config: { name: `check ${key}`, model: c, prompt: 'You are a connectivity check. Answer in one word.', maxOutputTokens: 1024 },
      },
    });
    const err = events.find(e => e.type === 'addon.error');
    const out = events.find(e => e.type === 'addon.output');
    const mine = hits.slice(before);
    const direct = mine.filter(h => DIRECT_HOSTS.test(h.host));
    const vertex = mine.filter(h => /aiplatform\.googleapis\.com$/.test(h.host));
    if (err) { console.log(`   ✗ error: ${err.payload.error.message}`); bad++; }
    if (out) console.log(`   reply: ${JSON.stringify(String(out.payload.rawOutput).slice(0, 80))} · ${out.payload.tokens.input}+${out.payload.tokens.output} tokens · ${Date.now() - started} ms`);
    for (const r of usageRows.slice(rowsBefore)) console.log(`   llm_usage row: model=${r.model} provider=${r.provider} in=${r.inputTokens} out=${r.outputTokens}`);
    if (direct.length) { console.log(`   ✗ DIRECT API HIT: ${direct.map(h => h.line).join(', ')}`); bad++; }
    console.log(vertex.length ? `   ✓ went through Vertex AI (${vertex.length} request${vertex.length === 1 ? '' : 's'})` : '   ✗ no request reached aiplatform.googleapis.com');
    if (!vertex.length) bad++;
    console.log('');
  }
  console.log(bad ? `${bad} problem(s)` : 'ALL OK — every call went through Vertex AI');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
