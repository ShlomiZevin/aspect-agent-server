#!/usr/bin/env node
/**
 * Direct vs Vertex — the comparison harness for the model route (board #996,
 * built for the "Vertex Lab" agent: scripts/setup-vertex-lab.js).
 *
 * Two modes. Both make REAL model calls (small: the lab agent is cheap).
 *
 * 1) SERVER (default) — the real product path, on Lybi Staging.
 *    Runs the same scripted conversations (scripts/fixtures/vertex-lab-scenarios.json)
 *    through the customer streaming API, once per route. The route is set per
 *    turn with `overrideAgentBody` (the agent's ACTIVE body + modelRoute) — the
 *    same working-copy override the Builder test chat uses — so no version is
 *    saved and the two routes can be interleaved (A/B, B/A …) to cancel drift.
 *    Per turn it records, from the SSE stream: time to the first reply token
 *    (what the customer waits for, the whole blocking chain included), time to
 *    the full reply, time to the end of the turn (offline lane included),
 *    whether the reply streamed, every add-on's status / duration / first token
 *    / web searches / transition / error; then, from Admin → LLM Usage
 *    (/api/llm-usage/conversation), every model call's tokens, cost, duration
 *    and route (anthropic vs anthropic@vertex); retried model errors from the
 *    agent's error list; the final field values per conversation. Pairs the
 *    turns of the two routes and compares the outputs (crew, transition,
 *    fields, reply length, word overlap).
 *
 *      node scripts/compare-vertex-direct.js [--routes=direct,vertex] [--repeat=1]
 *           [--scenarios=happy-path,cascade] [--out=verification/vertex-vs-direct]
 *           [--tag=<name>]
 *
 *    Today (2026-11-27) the staging server has no VERTEX_PROJECT_ID, so a
 *    Vertex turn fails loudly with `model_route` — run --routes=direct until
 *    #996's steps 1–2 (IAM + env + deploy) are done; then run both.
 *
 * 2) LOCAL A/B (--local) — the same model requests, sent twice from this
 *    machine through our own services/llm.js: once Direct (the staging
 *    Anthropic key, read from .env.production.staging, never printed) and once
 *    through Vertex (VERTEX_PROJECT_ID, Application Default Credentials). The
 *    requests are rebuilt from a SERVER run's results (--from=<json>): each
 *    add-on's assembled prompt as the model received it (addon.prompt event),
 *    the conversation so far, the add-on's model and web search setting.
 *    Talker = streaming call (time to first token + total); JSON add-ons =
 *    one-shot. Order alternates per call; one warm-up call per route first.
 *    No database: db.pg is a stub (usage rows are captured in memory).
 *    Measures the ROUTE alone — same request, same machine, same minute.
 *
 *      VERTEX_PROJECT_ID=lybi-staging [VERTEX_LOCATION=global] \
 *        node scripts/compare-vertex-direct.js --local --from=verification/vertex-vs-direct/server-<tag>.json
 *        [--repeat=1] [--rep=0|all] [--only=talker,thinker,field-extractor,summarizer] [--no-web-search]
 *
 * Writes: <out>/server-<tag>.json or <out>/local-<tag>.json (raw) and prints
 * a summary table. Never reads .env (Origin's database); never prints a key.
 */
const fs = require('fs');
const path = require('path');

const STAGING = 'https://lybi-server-700084613835.me-west1.run.app';
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const OUT = path.resolve(ROOT, arg('out', 'verification/vertex-vs-direct'));
const TAG = arg('tag', new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
const SLUG = arg('agent', 'vertex-lab');
const REPEAT = Math.max(1, Number(arg('repeat', '1')) || 1);
const OWNER = 'vertex-lab-harness';

// ─── small stats ───────────────────────────────────────────────────────
const nums = a => a.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
const pct = (a, p) => { const s = nums(a); if (!s.length) return null; return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))]; };
const med = a => pct(a, 50);
const sum = a => nums(a).reduce((x, y) => x + y, 0);
const ms = v => (v == null ? '—' : `${(v / 1000).toFixed(2)} s`);
const usd = v => (v == null ? '—' : `$${v.toFixed(4)}`);
const words = t => new Set(String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
function jaccard(a, b) {
  const A = words(a), B = words(b);
  if (!A.size && !B.size) return 1;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}
function stableFields(mem) {
  const out = {};
  for (const [dom, vals] of Object.entries((mem && mem.memory) || {})) {
    for (const [k, v] of Object.entries(vals || {})) out[`${dom}.${k}`] = v;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// SERVER MODE
// ═══════════════════════════════════════════════════════════════════════
async function getJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t), text: t }; } catch { return { status: r.status, json: null, text: t }; }
}

/** One turn through the customer streaming API; every SSE event, timed. */
async function streamTurn(server, convId, userMessage, overrideAgentBody) {
  const t0 = Date.now();
  const res = await fetch(`${server}/api/agents/${SLUG}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ownerUserId: OWNER, userMessage, version: 'active', overrideAgentBody }),
  });
  const turn = {
    httpStatus: res.status, firstTokenMs: null, replyMs: null, doneMs: null, endMs: null,
    tokenEvents: 0, reply: '', crewAtStart: null, addons: {}, turnErrors: [], warnings: [], websearchEvents: 0,
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const addon = id => (turn.addons[id] = turn.addons[id] || { instanceId: id, status: 'started' });
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = block.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      const at = Date.now() - t0;
      switch (ev.type) {
        case 'conversation': turn.crewAtStart = ev.currentCrewId || null; break;
        case 'addon.start': Object.assign(addon(ev.instanceId), { label: ev.label, pluginId: ev.pluginId, lane: ev.lane, model: ev.model && ev.model.modelId, startedAt: at }); break;
        case 'addon.prompt': addon(ev.instanceId).prompt = ev.prompt; addon(ev.instanceId).historyCount = ev.historyCount; break;
        case 'addon.token':
          turn.tokenEvents++;
          if (turn.firstTokenMs == null) turn.firstTokenMs = at;
          addon(ev.instanceId).tokenEvents = (addon(ev.instanceId).tokenEvents || 0) + 1;
          break;
        case 'addon.websearch': turn.websearchEvents++; break;
        case 'addon.skipped': Object.assign(addon(ev.instanceId), { status: 'skipped', reason: ev.reason || ev.why || null }); break;
        case 'addon.output': {
          const a = addon(ev.instanceId);
          Object.assign(a, {
            status: 'ok', endedAt: at, durationMs: ev.durationMs, firstTokenMs: ev.firstTokenMs ?? null,
            sseTokens: ev.tokens, rawOutput: ev.rawOutput, memoryWrites: ev.memoryWrites,
            webSearch: ev.webSearch ? { count: ev.webSearch.count ?? (ev.webSearch.queries || []).length, queries: ev.webSearch.queries } : null,
            transition: ev.transition || null,
          });
          if (!a.prompt && ev.prompt) a.prompt = ev.prompt;
          break;
        }
        case 'addon.error':
          if (ev.instanceId) Object.assign(addon(ev.instanceId), { status: 'error', endedAt: at, error: ev.error });
          else turn.turnErrors.push(ev.error);
          break;
        case 'warning': turn.warnings.push(ev); break;
        case 'assistant.message': turn.replyMs = at; turn.reply = ev.text; turn.messageId = ev.messageId; break;
        case 'done': turn.doneMs = at; break;
        default: break;
      }
    }
  }
  turn.endMs = Date.now() - t0;
  turn.addons = Object.values(turn.addons);
  const talkers = turn.addons.filter(a => a.pluginId === 'talker' && a.status === 'ok');
  turn.streamed = turn.tokenEvents > 1;
  turn.talker = talkers.length ? talkers[talkers.length - 1].label : null;
  turn.transition = (turn.addons.find(a => a.transition) || {}).transition || null;
  turn.webSearches = sum(turn.addons.map(a => (a.webSearch ? a.webSearch.count : 0)));
  turn.addonErrors = turn.addons.filter(a => a.status === 'error').map(a => ({ label: a.label, code: a.error && a.error.code, message: a.error && a.error.message }));
  return turn;
}

async function serverMode() {
  const server = arg('server', STAGING);
  if (server !== STAGING && !args.includes('--i-know-this-is-not-staging')) {
    console.error(`Refusing: run against Lybi Staging (${STAGING}).`); process.exit(1);
  }
  const routes = arg('routes', 'direct,vertex').split(',').map(s => s.trim()).filter(Boolean);
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vertex-lab-scenarios.json'), 'utf8'));
  const want = arg('scenarios', '');
  const scenarios = fx.scenarios.filter(s => !want || want.split(',').includes(s.id));

  const proj = await getJson(`${server}/api/builder/projects?agentSlug=${SLUG}&ownerUserId=${OWNER}`);
  if (proj.status !== 200 || !proj.json || !proj.json.agents) { console.error(`Agent ${SLUG} not found on ${server}`); process.exit(1); }
  const agent = proj.json.agents[0];
  const activeBody = (agent.versions.find(v => v.id === agent.activeVersionId) || {}).body;
  if (!activeBody) { console.error('No active agent body.'); process.exit(1); }
  const crewName = Object.fromEntries(agent.crews.map(c => [c.id, c.name]));
  const bodyFor = route => { const b = { ...activeBody }; delete b.modelRoute; if (route === 'vertex') b.modelRoute = 'vertex'; return b; };
  const models = (await getJson(`${server}/api/models`)).json;
  const routeInfo = (await getJson(`${server}/builder/mcp/agents/${SLUG}/model-route`)).text;

  const started = new Date();
  console.log(`Server mode · ${server} · agent ${SLUG} (active v${(agent.versions.find(v => v.id === agent.activeVersionId) || {}).number}) · routes ${routes.join('+')} · ${scenarios.length} scenarios × ${REPEAT}\n`);
  const convs = [];
  for (let rep = 0; rep < REPEAT; rep++) {
    for (const [si, sc] of scenarios.entries()) {
      // Alternate which route goes first, so warm-up / drift hits both.
      const order = (rep + si) % 2 === 0 ? routes : [...routes].reverse();
      for (const route of order) {
        const c = await (await fetch(`${server}/api/agents/${SLUG}/conversations`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ownerUserId: OWNER, source: 'builder' }),
        })).json();
        const conv = { route, rep, scenario: sc.id, conversationId: c.conversationId, turns: [] };
        convs.push(conv);
        for (const [ti, line] of sc.lines.entries()) {
          const t = await streamTurn(server, c.conversationId, line, bodyFor(route));
          t.turn = ti + 1; t.userText = line;
          t.crewAtStartName = crewName[t.crewAtStart] || (t.crewAtStart ? t.crewAtStart : crewName[agent.defaultCrewId]);
          if (t.transition) t.transitionTo = crewName[t.transition.to] || t.transition.to;
          conv.turns.push(t);
          const err = t.turnErrors.length || t.addonErrors.length ? ` · ERR ${[...t.turnErrors.map(e => e && (e.code || e.message)), ...t.addonErrors.map(e => `${e.label}:${e.code}`)].join(', ')}` : '';
          console.log(`  ${route.padEnd(6)} ${sc.id.padEnd(11)} t${t.turn}  first token ${ms(t.firstTokenMs).padStart(8)} · reply ${ms(t.replyMs).padStart(8)} · end ${ms(t.endMs).padStart(8)} · ${t.talker || '-'}${t.transitionTo ? ` → ${t.transitionTo}` : ''}${t.webSearches ? ` · ${t.webSearches} search` : ''}${err}`);
        }
        const mem = await getJson(`${server}/api/agents/${SLUG}/conversations/${c.conversationId}/memory?ownerUserId=${OWNER}`);
        conv.finalFields = stableFields(mem.json);
      }
    }
  }

  // Usage rows (tokens, cost, route) — Admin → LLM Usage, per conversation.
  // Its report caches a period for 30 s; wait so the last offline calls are in.
  console.log('\nReading model calls from LLM Usage …');
  await new Promise(r => setTimeout(r, 35000));
  for (const conv of convs) {
    const u = await getJson(`${server}/api/llm-usage/conversation?agentSlug=${SLUG}&id=${conv.conversationId}&period=today`);
    conv.usage = u.json && u.json.interactions ? u.json.interactions : [];
    for (const t of conv.turns) {
      const it = conv.usage.find(x => x.interaction === t.turn);
      t.calls = it ? it.runs.map(r => ({
        addon: r.addonName, type: r.addonType, crew: r.crew, model: r.model, route: r.route || 'direct',
        inputTokens: r.input, outputTokens: r.output, durationMs: r.durationMs, cost: r.cost, searches: r.searches || 0, kind: r.kind || 'call',
      })) : [];
      t.inputTokens = sum(t.calls.map(c => c.inputTokens));
      t.outputTokens = sum(t.calls.map(c => c.outputTokens));
      t.cost = t.calls.length ? sum(t.calls.map(c => c.cost)) : null;
      t.callRoutes = [...new Set(t.calls.filter(c => c.kind !== 'web_search').map(c => c.route))];
    }
  }
  const errors = (await getJson(`${server}/builder/mcp/agents/${SLUG}/errors`)).text;

  const result = {
    kind: 'server', tag: TAG, server, agent: SLUG, agentVersion: (agent.versions.find(v => v.id === agent.activeVersionId) || {}).number,
    startedAt: started.toISOString(), finishedAt: new Date().toISOString(), routes, repeat: REPEAT,
    modelRouteAnswer: routeInfo, errorsAnswer: errors, conversations: convs,
    prices: (models && models.models || []).filter(m => m.providerId === 'anthropic').map(m => ({ id: m.id, price: m.price, vertex: m.vertex, vertexId: m.vertexId })),
  };
  result.summary = summarizeServer(result);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `server-${TAG}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  printServerSummary(result.summary);
  console.log(`\nRaw: ${path.relative(ROOT, file)}`);
}

function summarizeServer(r) {
  const by = {};
  for (const route of r.routes) {
    const turns = r.conversations.filter(c => c.route === route).flatMap(c => c.turns);
    const ok = turns.filter(t => !t.turnErrors.length && t.reply);
    const callsByModel = {};
    for (const t of turns) for (const c of (t.calls || [])) {
      if (c.kind === 'web_search') continue;
      (callsByModel[c.model] = callsByModel[c.model] || []).push(c.durationMs);
    }
    // Per add-on durations from the stream (the one-shot add-ons' own wall time).
    const addonDur = {};
    for (const t of turns) for (const a of t.addons) if (a.status === 'ok' && a.durationMs != null) (addonDur[a.label] = addonDur[a.label] || []).push(a.durationMs);
    const talkerFirst = turns.flatMap(t => t.addons.filter(a => a.pluginId === 'talker' && a.firstTokenMs != null).map(a => a.firstTokenMs));
    by[route] = {
      turns: turns.length,
      answered: ok.length,
      turnErrors: turns.filter(t => t.turnErrors.length).length,
      addonErrors: turns.reduce((n, t) => n + t.addonErrors.length, 0),
      errorCodes: [...new Set(turns.flatMap(t => [...t.turnErrors.map(e => e && e.code), ...t.addonErrors.map(e => e.code)]).filter(Boolean))],
      streamed: turns.filter(t => t.streamed).length,
      webSearchTurns: turns.filter(t => t.webSearches > 0).length,
      firstToken: { median: med(turns.map(t => t.firstTokenMs)), p90: pct(turns.map(t => t.firstTokenMs), 90) },
      reply: { median: med(turns.map(t => t.replyMs)), p90: pct(turns.map(t => t.replyMs), 90) },
      end: { median: med(turns.map(t => t.endMs)), p90: pct(turns.map(t => t.endMs), 90) },
      talkerFirstToken: { median: med(talkerFirst), p90: pct(talkerFirst, 90) },
      inputTokens: sum(turns.map(t => t.inputTokens)),
      outputTokens: sum(turns.map(t => t.outputTokens)),
      cost: sum(turns.map(t => t.cost)),
      costPerTurn: turns.length ? sum(turns.map(t => t.cost)) / turns.length : null,
      callRoutes: [...new Set(turns.flatMap(t => t.callRoutes || []))],
      callMsByModel: Object.fromEntries(Object.entries(callsByModel).map(([m, a]) => [m, { calls: a.length, median: med(a), p90: pct(a, 90) }])),
      addonMs: Object.fromEntries(Object.entries(addonDur).map(([k, a]) => [k, { runs: a.length, median: med(a) }])),
    };
  }
  // Pair the routes turn by turn.
  const pairs = [];
  if (r.routes.length === 2) {
    const [A, B] = r.routes;
    for (const ca of r.conversations.filter(c => c.route === A)) {
      const cb = r.conversations.find(c => c.route === B && c.scenario === ca.scenario && c.rep === ca.rep);
      if (!cb) continue;
      const fa = ca.finalFields || {}, fb = cb.finalFields || {};
      const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])];
      const fieldDiffs = keys.filter(k => JSON.stringify(fa[k]) !== JSON.stringify(fb[k])).map(k => ({ field: k, [A]: fa[k], [B]: fb[k] }));
      ca.turns.forEach((ta, i) => {
        const tb = cb.turns[i]; if (!tb) return;
        pairs.push({
          scenario: ca.scenario, rep: ca.rep, turn: ta.turn,
          sameTalker: ta.talker === tb.talker, sameTransition: (ta.transitionTo || null) === (tb.transitionTo || null),
          len: { [A]: (ta.reply || '').length, [B]: (tb.reply || '').length },
          wordOverlap: Number(jaccard(ta.reply, tb.reply).toFixed(2)),
          firstTokenDeltaMs: ta.firstTokenMs != null && tb.firstTokenMs != null ? tb.firstTokenMs - ta.firstTokenMs : null,
          ...(i === ca.turns.length - 1 ? { finalFieldDiffs: fieldDiffs } : {}),
        });
      });
    }
  }
  return { byRoute: by, pairs };
}

function printServerSummary(s) {
  const routes = Object.keys(s.byRoute);
  const row = (label, f) => console.log(`${label.padEnd(30)} ${routes.map(r => String(f(s.byRoute[r])).padStart(16)).join(' ')}`);
  console.log(`\n${''.padEnd(30)} ${routes.map(r => r.toUpperCase().padStart(16)).join(' ')}`);
  row('turns answered', b => `${b.answered}/${b.turns}`);
  row('turn errors / add-on errors', b => `${b.turnErrors} / ${b.addonErrors}`);
  row('error codes', b => b.errorCodes.join(',') || '-');
  row('streamed', b => `${b.streamed}/${b.turns}`);
  row('turns with a web search', b => b.webSearchTurns);
  row('first token median (p90)', b => `${ms(b.firstToken.median)} (${ms(b.firstToken.p90)})`);
  row('talker first token median', b => ms(b.talkerFirstToken.median));
  row('full reply median (p90)', b => `${ms(b.reply.median)} (${ms(b.reply.p90)})`);
  row('turn end median', b => ms(b.end.median));
  row('tokens in / out', b => `${b.inputTokens} / ${b.outputTokens}`);
  row('cost (per turn)', b => `${usd(b.cost)} (${usd(b.costPerTurn)})`);
  row('call routes seen', b => b.callRoutes.join(',') || '-');
  const allModels = [...new Set(routes.flatMap(r => Object.keys(s.byRoute[r].callMsByModel)))];
  for (const m of allModels) row(`  call ms ${m}`, b => (b.callMsByModel[m] ? `${ms(b.callMsByModel[m].median)} ×${b.callMsByModel[m].calls}` : '-'));
  if (s.pairs.length) {
    const same = s.pairs.filter(p => p.sameTalker && p.sameTransition).length;
    console.log(`\nPaired turns: ${s.pairs.length} · same crew + transition on ${same} · word overlap median ${med(s.pairs.map(p => p.wordOverlap))}`);
    const diffs = s.pairs.filter(p => p.finalFieldDiffs && p.finalFieldDiffs.length);
    console.log(diffs.length ? `Final field differences: ${diffs.map(p => `${p.scenario}: ${p.finalFieldDiffs.map(d => d.field).join(',')}`).join(' · ')}` : 'Final field values: identical on every scenario');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LOCAL A/B MODE — same request, both routes, through services/llm.js
// ═══════════════════════════════════════════════════════════════════════
function loadStagingKey() {
  const env = fs.readFileSync(path.join(ROOT, '.env.production.staging'), 'utf8');
  const m = env.match(/^ANTHROPIC_API_KEY=(.*)$/m);
  if (!m) throw new Error('ANTHROPIC_API_KEY not in .env.production.staging');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

async function localMode() {
  if (!process.env.VERTEX_PROJECT_ID) { console.error('Set VERTEX_PROJECT_ID (e.g. lybi-staging).'); process.exit(1); }
  const from = arg('from', '');
  if (!from) { console.error('--from=<server-run json> is required (the requests are rebuilt from it).'); process.exit(1); }
  const src = JSON.parse(fs.readFileSync(path.resolve(ROOT, from), 'utf8'));
  const only = arg('only', 'talker,thinker,field-extractor,summarizer').split(',');

  // No database, ever; only Anthropic is used. Key from the staging env file, never printed.
  process.env.DB_HOST = '127.0.0.255';
  process.env.DATABASE_URL = 'postgres://dead:dead@127.0.0.255:1/dead';
  process.env.ANTHROPIC_API_KEY = loadStagingKey();
  process.env.OPENAI_API_KEY = 'unused-in-this-check';
  process.env.GEMINI_API_KEY = 'unused-in-this-check';
  const stub = (rel, exp) => { const f = require.resolve(path.join(ROOT, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
  const usageRows = [];
  stub('services/db.pg.js', new Proxy({}, {
    get(_, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === 'getDrizzle') return () => new Proxy({ insert: () => ({ values: v => ({ execute: () => { usageRows.push(v); return Promise.resolve(); } }) }) }, { get: (t, p) => (p in t ? t[p] : () => { throw new Error('no DB'); }) });
      return () => { throw new Error('no DB'); };
    },
  }));
  // Quiet the providers' per-call console lines.
  const realLog = console.log;
  const quiet = fn => async (...a) => { console.log = () => {}; try { return await fn(...a); } finally { console.log = realLog; } };
  const llm = require(path.join(ROOT, 'services/llm.js'));
  const { webSearchFor } = require(path.join(ROOT, 'services/webSearch.js'));

  // Rebuild the requests: every add-on run with a model and a prompt, in turn order.
  const agentFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vertex-lab-agent.json'), 'utf8'));
  const instById = {};
  for (const a of [...agentFx.agent.cortex, ...agentFx.crews.intake.addons, ...agentFx.crews.plan.addons]) instById[a.instanceId] = a;
  const requests = [];
  // Rebuilt from ONE repeat of the server run (default the first) — keeps the cost down.
  const fromRep = arg('rep', '0');
  for (const conv of src.conversations.filter(c => c.route === 'direct' && (fromRep === 'all' || c.rep === Number(fromRep)))) {
    const history = [];
    for (const t of conv.turns) {
      for (const a of t.addons) {
        if (!a.prompt || !a.model || a.status !== 'ok' || !only.includes(a.pluginId)) continue;
        const inst = instById[a.instanceId] || { pluginId: a.pluginId, config: { model: { modelId: a.model } } };
        requests.push({
          scenario: conv.scenario, turn: t.turn, label: a.label, pluginId: a.pluginId, lane: a.lane, model: a.model,
          prompt: a.prompt, userMessage: t.userText, history: history.slice(),
          // --no-web-search: drop the tool on both routes (e.g. while the
          // lybi-staging org policy blocks web_search for Claude on Vertex).
          webSearch: args.includes('--no-web-search') ? null : (webSearchFor(inst, a.model) || null),
        });
      }
      history.push({ role: 'user', content: t.userText });
      if (t.reply) history.push({ role: 'assistant', content: t.reply });
    }
  }
  console.log(`Local A/B · ${requests.length} requests rebuilt from ${path.basename(from)} · × ${REPEAT} · Vertex ${process.env.VERTEX_PROJECT_ID}/${process.env.VERTEX_LOCATION || 'global'}\n`);

  async function once(req, route) {
    const opt = route === 'vertex' ? { modelRoute: 'vertex' } : {};
    const t0 = Date.now();
    const rowsBefore = usageRows.length;
    const out = { route, firstTokenMs: null, totalMs: null, inputTokens: null, outputTokens: null, error: null, text: '', chunks: 0, searches: 0 };
    try {
      if (req.pluginId === 'talker') {
        const stream = llm.sendMessageStreamWithPrompt(req.userMessage, 0, {
          prompt: req.prompt, model: req.model, historyMessages: req.history, maxTokens: 16000,
          context: 'vertex_ab_talker', agentName: 'vertex-lab-ab', ...(req.webSearch ? { webSearch: req.webSearch } : {}), ...opt,
        });
        console.log = () => {};
        try {
          for await (const ch of stream) {
            const txt = typeof ch === 'string' ? ch : (ch && ch.type === 'text' ? ch.text : null);
            if (txt) { if (out.firstTokenMs == null) out.firstTokenMs = Date.now() - t0; out.text += txt; out.chunks++; }
            else if (ch && ch.type === 'usage') { out.inputTokens = ch.inputTokens; out.outputTokens = ch.outputTokens; }
            else if (ch && ch.type === 'web_search' && ch.phase === 'done') out.searches++;
          }
        } finally { console.log = realLog; }
      } else {
        const r = await quiet(() => llm.sendOneShot(req.prompt, req.userMessage, {
          model: req.model, jsonOutput: true, historyMessages: req.history, maxTokens: 16000, withMeta: true,
          context: `vertex_ab_${req.pluginId}`, agentName: 'vertex-lab-ab', ...(req.webSearch ? { webSearch: req.webSearch } : {}), ...opt,
        }))();
        out.text = typeof r === 'string' ? r : (r && r.text) || '';
        out.searches = (r && r.usage && r.usage.webSearches) || 0;
        const row = usageRows.slice(rowsBefore).find(x => x.model === req.model);
        if (row) { out.inputTokens = row.inputTokens; out.outputTokens = row.outputTokens; }
      }
    } catch (e) {
      out.error = { code: e.code || e.status || null, message: String(e.message || e).slice(0, 300) };
    }
    out.totalMs = Date.now() - t0;
    out.usageProvider = (usageRows.slice(rowsBefore).find(x => x.model === req.model) || {}).provider || null;
    return out;
  }

  // Warm-up: one tiny call per route (TLS, token fetch) — not counted.
  const warm = { prompt: 'Reply with: ok', userMessage: 'ok', history: [], model: 'claude-haiku-5-5', pluginId: 'talker' };
  for (const route of ['direct', 'vertex']) { const w = await once(warm, route); console.log(`  warm-up ${route}: ${w.error ? `ERROR ${w.error.message}` : `ok in ${ms(w.totalMs)} (usage provider ${w.usageProvider})`}`); }
  console.log('');

  const results = [];
  let k = 0;
  for (let rep = 0; rep < REPEAT; rep++) {
    for (const req of requests) {
      const order = k++ % 2 === 0 ? ['direct', 'vertex'] : ['vertex', 'direct'];
      const pair = {};
      for (const route of order) pair[route] = await once(req, route);
      const d = pair.direct, v = pair.vertex;
      results.push({ rep, scenario: req.scenario, turn: req.turn, label: req.label, pluginId: req.pluginId, model: req.model, webSearch: !!req.webSearch, direct: d, vertex: v, wordOverlap: Number(jaccard(d.text, v.text).toFixed(2)) });
      const f = o => (o.error ? `ERR ${o.error.code || ''} ${o.error.message.slice(0, 60)}` : `${req.pluginId === 'talker' ? `first ${ms(o.firstTokenMs)} · ` : ''}total ${ms(o.totalMs)} · ${o.inputTokens}/${o.outputTokens} tok${o.searches ? ` · ${o.searches} search` : ''}`);
      console.log(`  ${req.scenario.padEnd(11)} t${req.turn} ${req.label.padEnd(15)} ${req.model.padEnd(18)} DIRECT ${f(d)}  |  VERTEX ${f(v)}`);
    }
  }

  // Summary per model / add-on type.
  const groups = {};
  for (const r of results) (groups[`${r.pluginId} · ${r.model}${r.webSearch ? ' · web search on' : ''}`] = groups[`${r.pluginId} · ${r.model}${r.webSearch ? ' · web search on' : ''}`] || []).push(r);
  const summary = { byGroup: {}, totals: {} };
  for (const [g, rs] of Object.entries(groups)) {
    const side = route => ({
      calls: rs.length, errors: rs.filter(r => r[route].error).length,
      firstTokenMedian: med(rs.map(r => r[route].firstTokenMs)), totalMedian: med(rs.map(r => r[route].totalMs)), totalP90: pct(rs.map(r => r[route].totalMs), 90),
      inputTokens: sum(rs.map(r => r[route].inputTokens)), outputTokens: sum(rs.map(r => r[route].outputTokens)),
    });
    summary.byGroup[g] = { direct: side('direct'), vertex: side('vertex'), wordOverlapMedian: med(rs.map(r => r.wordOverlap)) };
  }
  for (const route of ['direct', 'vertex']) {
    summary.totals[route] = {
      calls: results.length, errors: results.filter(r => r[route].error).length,
      errorSamples: [...new Set(results.filter(r => r[route].error).map(r => r[route].error.message))].slice(0, 5),
      totalMedian: med(results.map(r => r[route].totalMs)), inputTokens: sum(results.map(r => r[route].inputTokens)), outputTokens: sum(results.map(r => r[route].outputTokens)),
      usageProviders: [...new Set(results.map(r => r[route].usageProvider).filter(Boolean))],
    };
  }
  const out = { kind: 'local', tag: TAG, from: path.basename(from), startedAt: null, vertex: { project: process.env.VERTEX_PROJECT_ID, location: process.env.VERTEX_LOCATION || 'global' }, repeat: REPEAT, results, summary };
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `local-${TAG}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n${'group'.padEnd(52)} ${'DIRECT total (first)'.padStart(24)} ${'VERTEX total (first)'.padStart(24)}  errors D/V  overlap`);
  for (const [g, s] of Object.entries(summary.byGroup)) {
    const f = x => `${ms(x.totalMedian)}${x.firstTokenMedian != null ? ` (${ms(x.firstTokenMedian)})` : ''}`;
    console.log(`${g.padEnd(52)} ${f(s.direct).padStart(24)} ${f(s.vertex).padStart(24)}  ${String(s.direct.errors).padStart(3)}/${s.vertex.errors}     ${s.wordOverlapMedian}`);
  }
  console.log(`\nTokens in/out — direct ${summary.totals.direct.inputTokens}/${summary.totals.direct.outputTokens} · vertex ${summary.totals.vertex.inputTokens}/${summary.totals.vertex.outputTokens}`);
  console.log(`Usage provider rows — direct: ${summary.totals.direct.usageProviders.join(',')} · vertex: ${summary.totals.vertex.usageProviders.join(',')}`);
  console.log(`\nRaw: ${path.relative(ROOT, file)}`);
}

(args.includes('--local') ? localMode() : serverMode()).catch(e => { console.error('CRASH', e); process.exit(2); });
