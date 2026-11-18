#!/usr/bin/env node
/**
 * Customer-chat problems (task #985) — offline battery. No database, no model.
 *
 *   node scripts/test-customer-problems.js
 *
 * A stand-in for services/db.pg answers each query of
 * builder/services/customerProblems.js with canned rows, then the real
 * routes are mounted on a local port: the management API
 * (builder/routes/manageRoute.js, signed in — the door's own checks are in
 * test-manage-access.js)
 * and the Builder MCP door (builder/routes/mcpRoute.js — entry page +
 * /agents/:slug/customer-problems). Checks the plain-words table, one
 * problem per customer turn, answered vs not, "no reply" and its
 * de-duplication, "slow reply" (round 3) and when it repeats, the real /
 * test mark on every row, the reply-timing write (builder/runtime/replyTiming.js)
 * and its hook in the runtime, and that no code / stack / raw message leaks.
 */

const path = require('path');
const express = require('express');

// ─── The database stand-in ─────────────────────────────────────────

const NOW = new Date();
const ago = min => new Date(NOW.getTime() - min * 60000);
const TODAY = new Date(NOW.getTime() - 60 * 60000);          // "midnight" one hour ago
const WEEK = new Date(NOW.getTime() - 6 * 24 * 3600000);

const ERRORS = [
  // turn A (reply 900, empty → no answer): a retried model call + the turn
  { agent_slug: 'acme', conversation_id: 10, message_id: 900, area: 'model', kind: 'model_rate_limit', created_at: ago(20) },
  { agent_slug: 'acme', conversation_id: 10, message_id: 900, area: 'turn', kind: 'model_rate_limit', created_at: ago(20) },
  // turn B (reply 950 has text → answered): a transient model error
  { agent_slug: 'acme', conversation_id: 11, message_id: 950, area: 'model', kind: 'model_other', created_at: ago(30) },
  // turn C (reply 960 has text): background only
  { agent_slug: 'acme', conversation_id: 12, message_id: 960, area: 'offline', kind: 'model_bad_answer', created_at: ago(40) },
  // an unknown kind, no answer, older than 24 h (this week, not new)
  { agent_slug: 'acme', conversation_id: 13, message_id: 970, area: 'turn', kind: 'something_new', created_at: ago(3 * 24 * 60) },
  // a trigger failure, no reply message
  { agent_slug: 'other', conversation_id: 20, message_id: null, area: 'trigger', kind: 'code', created_at: ago(50) },
];
const SILENT = [
  // conversation 14 — nothing recorded, unanswered → a "no reply" row
  { conversation_id: 14, agent_slug: 'acme', user_msg_id: 1000, user_msg: 'hello? anyone there', at: ago(10) },
  // conversation 10 — already covered by turn A's errors (reply 900 > message 899)
  { conversation_id: 10, agent_slug: 'acme', user_msg_id: 899, user_msg: 'covered', at: ago(20) },
];
// Slow replies (read from messages.metadata.replyTiming)
const DAY = '2026-11-17';
const SLOW = [
  // acme, conversation 15 — one slow reply that day → nothing to do
  { reply_id: 1100, conversation_id: 15, agent_slug: 'acme', reply_ms: '75000', at: ago(15), day: DAY, user_msg: 'can you check my form?' },
  // acme, reply 950 — turn B already has an Error Center row → told there, not twice
  { reply_id: 950, conversation_id: 11, agent_slug: 'acme', reply_ms: '64000', at: ago(30), day: DAY, user_msg: 'dup' },
  // other — three slow replies the same day → it repeats → call Shlomi
  { reply_id: 2001, conversation_id: 21, agent_slug: 'other', reply_ms: '61000', at: ago(60), day: DAY, user_msg: 'a' },
  { reply_id: 2002, conversation_id: 22, agent_slug: 'other', reply_ms: '190000', at: ago(70), day: DAY, user_msg: 'b' },
  { reply_id: 2003, conversation_id: 23, agent_slug: 'other', reply_ms: '62000', at: ago(80), day: DAY, user_msg: 'c' },
];
const REAL_CONVERSATIONS = new Set([11, 21]);
let failTimingWrite = false;
const timingWrites = [];

const FACTS = {
  m900: { last_user: 'I sent the ID photo, what now?', answered: false },
  m950: { last_user: 'Can I book for Sunday?', answered: true },
  m960: { last_user: 'thanks', answered: true },
  m970: { last_user: 'old one', answered: false },
};
const queries = [];

// The management center's door (manageRoute): its session secret and grants.
const config = new Map();
const GRANTS = [
  { email: 'noa@lybi.ai', agent_id: null },
  { email: 'super@acme.com', agent_id: 'agent_acme' },
];
const AGENT_IDS = { acme: 'agent_acme', other: 'agent_other' };

const fakeDb = {
  async query(sql, params = []) {
    queries.push(sql);
    if (/INSERT INTO provider_config/.test(sql)) {
      if (!config.has(params[0])) config.set(params[0], params[1]);
      return { rows: [] };
    }
    if (/FROM provider_config/.test(sql)) return { rows: config.has(params[0]) ? [{ value: config.get(params[0]) }] : [] };
    if (/FROM manage_access WHERE email/.test(sql)) return { rows: GRANTS.filter(g => g.email === params[0]) };
    if (/SELECT id FROM builder_agents WHERE slug/.test(sql)) return { rows: AGENT_IDS[params[0]] ? [{ id: AGENT_IDS[params[0]] }] : [] };
    if (/UPDATE messages/.test(sql)) {
      timingWrites.push({ sql, params });
      if (failTimingWrite) throw new Error('database down (on purpose)');
      return { rows: [] };
    }
    if (/JOIN messages r ON/.test(sql)) {
      return { rows: SLOW.filter(x => x.at >= params[0] && (!params[1] || x.agent_slug === params[1]) && Number(x.reply_ms) > params[2]) };
    }
    if (/AS today/.test(sql)) return { rows: [{ today: TODAY, week: WEEK, now: NOW }] };
    if (/FROM builder_agents a/.test(sql)) {
      const all = [{ slug: 'acme', name: 'Acme bank', archived_at: null }, { slug: 'other', name: 'Other', archived_at: null }];
      return { rows: params[0] ? all.filter(a => a.slug === params[0]) : all };
    }
    if (/FROM error_events e/.test(sql)) {
      return { rows: ERRORS.filter(e => e.created_at >= params[0] && (!params[1] || e.agent_slug === params[1])) };
    }
    if (/CROSS JOIN LATERAL/.test(sql)) {
      return { rows: SILENT.filter(s => s.at >= params[0] && (!params[1] || s.agent_slug === params[1])) };
    }
    if (/GROUP BY 1/.test(sql) && /url_slug AS slug/.test(sql)) {
      const rows = [{ slug: 'acme', n: 7 }, { slug: 'other', n: 2 }];
      return { rows: params[1] ? rows.filter(r => r.slug === params[1]) : rows };
    }
    if (/unnest\(/.test(sql)) {
      return { rows: params[0].map(key => ({ key, ...(FACTS[key] || { last_user: 'before the trigger', answered: false }) })) };
    }
    if (/LEFT JOIN users u/.test(sql)) {
      return { rows: params[0].map(id => ({ id, name: id === 11 ? 'Ronit' : null, audience: REAL_CONVERSATIONS.has(id) ? 'real' : (id === 12 ? 'test' : null) })) };
    }
    throw new Error(`unexpected query in the stand-in: ${sql.slice(0, 80)}`);
  },
  getDrizzle() { throw new Error('no drizzle in the offline battery'); },
  close: async () => {},
};
const dbPath = require.resolve(path.join(__dirname, '..', 'services', 'db.pg'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const cp = require('../builder/services/customerProblems');
const manageSession = require('../builder/services/manageSession');

let fails = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
}

(async () => {
  // ─── The plain-words table ──────────────────────────────────────
  console.log('\n-- plain words');
  for (const kind of Object.keys(cp.KINDS)) {
    const no = cp.plainWords({ type: 'error', kind, area: 'turn', answered: false });
    const yes = cp.plainWords({ type: 'error', kind, area: 'turn', answered: true });
    check(`${kind}: a sentence + an act-chip when unanswered, an ok-chip when answered`,
      !!no.title && no.action.tone === 'act' && yes.action.tone === 'ok' && no.title !== yes.title);
  }
  const unknown = cp.plainWords({ type: 'error', kind: 'brand_new_kind', area: 'turn', answered: false });
  check('an unknown kind falls back to a safe sentence', unknown.title === cp.FALLBACK.problem && unknown.action.text === cp.ACTIONS.shlomi.text);
  check('a transient kind that was answered reads "fixed automatically"',
    cp.plainWords({ type: 'error', kind: 'model_rate_limit', area: 'model', answered: true }).action === cp.ACTIONS.auto);
  check('background-only + answered → "the customer did not notice"',
    cp.plainWords({ type: 'error', kind: 'model_bad_answer', area: 'offline', answered: true, backgroundOnly: true }).action === cp.ACTIONS.unnoticed);
  check('no reply → "contact the customer"', cp.plainWords({ type: 'no_reply' }).action === cp.ACTIONS.customer);

  // ─── listProblems ───────────────────────────────────────────────
  console.log('\n-- listProblems');
  const week = await cp.listProblems({ slug: 'acme', range: 'week' });
  const byConv = id => week.problems.filter(p => p.conversationId === id);
  check('one problem per customer turn (two rows of turn A → one line)', byConv(10).length === 1, JSON.stringify(byConv(10)));
  const a = byConv(10)[0] || {};
  check('turn A: no answer → rate-limit sentence + contact the customer',
    a.title === cp.KINDS.model_rate_limit.problem && a.action.text === cp.ACTIONS.customer.text && a.outcome === cp.OUTCOMES.noAnswer);
  check('turn A carries the customer\'s last message', a.lastCustomerMessage === FACTS.m900.last_user);
  const b = byConv(11)[0] || {};
  check('turn B: answered transient → fixed automatically', b.action && b.action.text === cp.ACTIONS.auto.text && b.answered === true);
  check('turn B: the customer\'s name', b.customerName === 'Ronit');
  const c = byConv(12)[0] || {};
  check('turn C: background only → did not notice', c.title === cp.SPECIAL.background.title);
  const n = byConv(14)[0] || {};
  check('"no reply" found where nothing was recorded', n.type === 'no_reply' && n.title === cp.SPECIAL.noReply.title && n.lastCustomerMessage === 'hello? anyone there');
  check('"no reply" skipped where an error already covers that turn', !week.problems.some(p => p.type === 'no_reply' && p.conversationId === 10));
  check('newest first', week.problems.every((p, i) => i === 0 || week.problems[i - 1].at >= p.at));
  check('the 3-day-old problem is in the week but not new', byConv(13).length === 1 && byConv(13)[0].isNew === false);
  check('new count = problems in the last 24 h', week.newCount === week.problems.filter(p => p.isNew).length && week.newCount === 5, String(week.newCount));
  check('per-agent scope never shows another agent', week.problems.every(p => p.agentSlug === 'acme'));
  const today = await cp.listProblems({ slug: 'acme', range: 'today' });
  check('today leaves out the older problem', !today.problems.some(p => p.conversationId === 13) && today.range === 'today');
  check('served conversations per agent', (today.agents.find(x => x.slug === 'acme') || {}).conversations === 7);
  check('per agent: how many rows need someone to act', (week.agents.find(x => x.slug === 'acme') || {}).needsAction === week.problems.filter(p => p.action.tone === 'act').length);
  const all = await cp.listProblems({ slug: null, range: 'week' });
  check('every agent: the trigger failure of another agent shows', all.problems.some(p => p.agentSlug === 'other' && p.title === cp.SPECIAL.trigger.title));
  check('agents list carries names', all.agents.some(x => x.slug === 'acme' && x.name === 'Acme bank'));
  check('only customer-source errors are read', queries.some(q => /e\.source = 'customer'/.test(q)) && queries.some(q => /IS DISTINCT FROM 'ignored'/.test(q)));

  // ─── Slow replies (round 3) ─────────────────────────────────────
  console.log('\n-- slow replies');
  const slow = week.problems.find(p => p.type === 'slow_reply' && p.conversationId === 15) || {};
  check('a reply over the limit is a "slow reply" row', slow.title === cp.SPECIAL.slowReply.title && slow.icon === 'clock' && slow.replyMs === 75000);
  check('…the customer got an answer → nothing to do', slow.answered === true && slow.action === cp.ACTIONS.answered);
  check('…its outcome line says how long it took', /75/.test(slow.outcome || ''), slow.outcome);
  check('…with the customer\'s message before it', slow.lastCustomerMessage === 'can you check my form?');
  check('a slow turn that has an Error Center row is told once (by that row)', !week.problems.some(p => p.type === 'slow_reply' && p.conversationId === 11));
  const others = all.problems.filter(p => p.type === 'slow_reply' && p.agentSlug === 'other');
  check(`${cp.SLOW_REPEAT_PER_DAY} slow replies of one agent in a day → it repeats → call Shlomi`,
    others.length === 3 && others.every(p => p.action === cp.ACTIONS.shlomi), JSON.stringify(others.map(p => p.action.id)));
  check('a long one reads in minutes', others.some(p => p.replyMs === 190000 && /3/.test(p.outcome)));
  check('the limit is one named constant (60 s)', cp.SLOW_REPLY_MS === 60000 && queries.some(q => /replyTiming/.test(q) && /> \$3/.test(q)));
  check('the response says the limit', week.slowReplySeconds === 60);

  // ─── Real / test on every row (#968) ────────────────────────────
  console.log('\n-- real or test');
  check('every row carries audience', week.problems.every(p => 'audience' in p));
  check('a conversation marked real reads real', (byConv(11)[0] || {}).audience === 'real');
  check('no mark = test (fail closed)', (byConv(10)[0] || {}).audience === 'test' && (byConv(14)[0] || {}).audience === 'test');
  check('test rows are still listed (tagged, never hidden)', week.problems.some(p => p.audience === 'test'));

  // ─── The reply-timing write ─────────────────────────────────────
  console.log('\n-- reply timing');
  const rt = require('../builder/runtime/replyTiming');
  const t0 = Date.UTC(2026, 10, 17, 10, 0, 0);
  const timing = rt.buildReplyTiming({ receivedAt: t0, firstTextAt: t0 + 2500, finishedAt: t0 + 7200 });
  check('replyMs = received → reply saved; firstTextMs = received → first word',
    timing && timing.replyMs === 7200 && timing.firstTextMs === 2500 && timing.receivedAt === new Date(t0).toISOString());
  check('no first word → firstTextMs null', rt.buildReplyTiming({ receivedAt: t0, firstTextAt: null, finishedAt: t0 + 10 }).firstTextMs === null);
  check('nonsense times → nothing kept', rt.buildReplyTiming({ receivedAt: t0 + 5, finishedAt: t0 }) === null && rt.buildReplyTiming({}) === null);
  timingWrites.length = 0;
  const ret = rt.saveReplyTiming(4242, timing);
  check('saving returns at once (never waits the turn)', ret === undefined && timingWrites.length === 0);
  await new Promise(r => setTimeout(r, 30));
  const w = timingWrites[0] || { sql: '', params: [] };
  check('…then merges metadata.replyTiming into that reply only (jsonb ||, no overwrite)',
    w.params[0] === 4242 && /COALESCE\(metadata, '\{\}'::jsonb\) \|\| jsonb_build_object\('replyTiming'/.test(w.sql) && JSON.parse(w.params[1]).replyMs === 7200);
  failTimingWrite = true;
  let threw = false;
  try { rt.saveReplyTiming(4243, timing); rt.saveReplyTiming('nope', timing); rt.saveReplyTiming(4244, null); } catch { threw = true; }
  await new Promise(r => setTimeout(r, 30));
  failTimingWrite = false;
  check('a failed write is swallowed (never throws into the turn)', !threw);
  const fs = require('fs');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'builder', 'runtime', 'BuilderRunner.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'builder', 'routes', 'runtimeRoute.js'), 'utf8');
  const iSave = runner.indexOf('.set({ content: assistantText })');
  const iAnnounce = runner.indexOf("emit('assistant.message'", iSave);
  const iTiming = runner.indexOf('saveReplyTiming(assistantMessageId', iSave);
  check('runtime: timing is written right after the reply is saved and announced', iSave > 0 && iAnnounce > iSave && iTiming > iAnnounce);
  check('runtime: the first word is noticed from addon.token (events still pass through)', /type === 'addon\.token'\) firstTextAt = Date\.now\(\);\s*return emitRaw\(type, payload\)/.test(runner));
  check('chat route stamps receivedAt first thing and hands it to the run', /messages', async \(req, res\) => \{\s*\/\/[^\n]*\n\s*const receivedAt = Date\.now\(\);/.test(route) && /convRow,\s*receivedAt,\s*\}\)\)/.test(route));

  // ─── The routes ─────────────────────────────────────────────────
  console.log('\n-- routes');
  const app = express();
  app.use(express.json());
  app.use('/api/manage', require('../builder/routes/manageRoute'));
  app.use('/builder/mcp', require('../builder/routes/mcpRoute'));
  const srv = app.listen(0);
  const port = srv.address().port;
  const get = async (p, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
    return { status: r.status, text: await r.text() };
  };
  try {
    // Signed in (manageSession) — the door itself is tested in test-manage-access.js.
    const team = { Authorization: `Bearer ${(await manageSession.issue({ email: 'noa@lybi.ai', name: 'Noa' })).token}` };
    const acmeOnly = { Authorization: `Bearer ${(await manageSession.issue({ email: 'super@acme.com', name: 'Acme' })).token}` };
    check('per-agent API without signing in → 401', (await get('/api/manage/agents/acme/customer-problems')).status === 401);
    const one = await get('/api/manage/agents/acme/customer-problems?range=week', acmeOnly);
    const oneJson = one.status === 200 ? JSON.parse(one.text) : {};
    check('per-agent API answers the agent\'s own grant', one.status === 200 && oneJson.scope === 'agent' && oneJson.agent.name === 'Acme bank');
    check('…and refuses another agent (403)', (await get('/api/manage/agents/other/customer-problems', acmeOnly)).status === 403);
    check('no stack, code or raw error text in the API rows',
      one.status === 200 && oneJson.problems.every(p => !('kind' in p) && !('code' in p) && !('message' in p) && !('area' in p)));
    check('unknown agent → 404 (every-agent person)', (await get('/api/manage/agents/nope/customer-problems', team)).status === 404);
    check('"all" for a one-agent grant → 403', (await get('/api/manage/customer-problems', acmeOnly)).status === 403);
    const allRes = await get('/api/manage/customer-problems?range=week&agent=acme', team);
    const allJson = allRes.status === 200 ? JSON.parse(allRes.text) : {};
    check('"all" for an every-agent grant → every agent in the filter, problems narrowed to one',
      allRes.status === 200 && allJson.scope === 'all' && allJson.agents.length === 2 && allJson.problems.every(p => p.agentSlug === 'acme'));

    const entry = await get('/builder/mcp');
    check('MCP entry page still loads (template literal intact)', entry.status === 200 && entry.text.includes('/agents/<slug>/customer-problems'));
    const mcp = await get('/builder/mcp/agents/acme/customer-problems?range=week');
    check('MCP lists the problems with the same plain words',
      mcp.status === 200 && mcp.text.includes(cp.KINDS.model_rate_limit.problem) && mcp.text.includes(cp.ACTIONS.customer.text) && mcp.text.includes(cp.SPECIAL.noReply.title), mcp.text.slice(0, 200));
    check('MCP lines point at the conversation', /read it: http:\/\/127\.0\.0\.1:\d+\/builder\/mcp\/conversations\/10/.test(mcp.text));
    check('MCP: no kind codes in the lines', !/model_rate_limit|something_new/.test(mcp.text));
    check('MCP shows the slow reply with its time', mcp.text.includes(cp.SPECIAL.slowReply.title) && /reply took 75 s/.test(mcp.text));
    check('MCP says REAL customer / TEST conversation per line', /REAL customer/.test(mcp.text) && /TEST conversation/.test(mcp.text));
    check('API rows carry audience and replyMs', one.status === 200 && oneJson.problems.every(p => 'audience' in p && 'replyMs' in p));
    check('MCP unknown agent → 404 with a pointer', (await get('/builder/mcp/agents/nope/customer-problems')).text.includes('/agents for the list'));
  } finally {
    srv.close();
  }

  console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(err => { console.error('BATTERY ERROR:', err); process.exit(1); });
