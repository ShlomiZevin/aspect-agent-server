#!/usr/bin/env node
/**
 * Management center sign-in and access (task #985) — offline battery.
 * No database, no Google, no model.
 *
 *   node scripts/test-manage-access.js
 *
 * A stand-in for services/db.pg holds `manage_access`, the session secret
 * (provider_config) and a few agents / one customer conversation; a stand-in
 * for services/google-auth.service plays Google. Then the real routes are
 * mounted on a local port: builder/routes/manageRoute.js (sign-in, /me, the
 * per-agent and every-agent doors, the conversation window) and the Builder
 * MCP's read-only access pages. Also checks migration 070 is safe to run
 * twice and the CORS header list carries Authorization.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');

// ─── Stand-ins ─────────────────────────────────────────────────────

const config = new Map();
let secretInserts = 0;
const GRANTS = [
  { email: 'noa@lybi.ai', agent_id: null },
  { email: 'super@acme.com', agent_id: 'agent_acme' },
  { email: 'two@partner.com', agent_id: 'agent_acme' },
  { email: 'two@partner.com', agent_id: 'agent_other' },
];
const AGENTS = [
  { id: 'agent_acme', slug: 'acme', name: 'Acme bank', archived_at: null },
  { id: 'agent_other', slug: 'other', name: 'Other', archived_at: null },
  { id: 'agent_old', slug: 'old', name: 'Old one', archived_at: new Date('2026-10-01') },
];
const T0 = new Date('2026-11-18T08:00:00Z');
const CONVERSATION = {
  id: 10, channel: 'web', status: 'active', created_at: T0, last_message_at: new Date(T0.getTime() + 600000),
  last_user_message_at: new Date(T0.getTime() + 540000), audience: 'real', customer_name: 'Ronit',
  agent_slug: 'acme', agent_name: 'Acme bank', phase: 'Opening', message_count: 12, customer_messages: 6,
};
const LAST = [ // newest first, as the query's inner ORDER BY id DESC … the outer query re-sorts
  { id: 3, role: 'user', content: 'I sent the ID photo, what now?', created_at: new Date(T0.getTime() + 540000) },
  { id: 2, role: 'assistant', content: 'Please send a photo of your ID.', created_at: new Date(T0.getTime() + 60000) },
  { id: 1, role: 'user', content: 'שלום, אני רוצה לפתוח חשבון', created_at: T0 },
];
const queries = [];

const fakeDb = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/INSERT INTO provider_config/.test(sql)) {
      secretInserts++;
      if (!config.has(params[0])) config.set(params[0], params[1]);
      return { rows: [] };
    }
    if (/FROM provider_config/.test(sql)) return { rows: config.has(params[0]) ? [{ value: config.get(params[0]) }] : [] };
    if (/FROM manage_access WHERE email/.test(sql)) return { rows: GRANTS.filter(g => g.email === params[0]).map(g => ({ agent_id: g.agent_id })) };
    if (/FROM manage_access m/.test(sql)) {
      const rows = GRANTS.map(g => {
        const a = AGENTS.find(x => x.id === g.agent_id);
        return { email: g.email, agent_id: g.agent_id, note: g.agent_id ? null : 'Lybi team', granted_by: 'migration 070', created_at: T0, slug: a ? a.slug : null, name: a ? a.name : null };
      });
      return { rows: rows.filter(r => !params[0] || r.agent_id === null || r.slug === params[0]) };
    }
    if (/SELECT id FROM builder_agents WHERE slug/.test(sql)) return { rows: AGENTS.filter(a => a.slug === params[0]).map(a => ({ id: a.id })) };
    if (/a\.id = ANY/.test(sql)) return { rows: AGENTS.filter(a => !params[0] || params[0].includes(a.id)) };
    if (/FROM builder_agents a/.test(sql)) return { rows: AGENTS.filter(a => !params[0] || a.slug === params[0]) };
    if (/FROM conversations c/.test(sql) && /currentCrewId/.test(sql)) {
      return { rows: params[0] === CONVERSATION.id && params[1] === CONVERSATION.agent_slug ? [CONVERSATION] : [] };
    }
    if (/ORDER BY m\.id DESC LIMIT/.test(sql)) return { rows: params[0] === CONVERSATION.id ? [...LAST].reverse() : [] };
    throw new Error(`unexpected query in the stand-in: ${sql.slice(0, 80)}`);
  },
  getDrizzle() { throw new Error('no drizzle in the offline battery'); },
  close: async () => {},
};
const dbPath = require.resolve(path.join(__dirname, '..', 'services', 'db.pg'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

class AuthError extends Error {
  constructor(message, code = 401) { super(message); this.name = 'AuthError'; this.code = code; }
}
const fakeGoogle = {
  CLIENT_ID: 'test-client.apps.googleusercontent.com',
  isConfigured: () => true,
  async verify(idToken) {
    if (!idToken) throw new AuthError('Missing Google credential', 400);
    if (!String(idToken).startsWith('google:')) throw new AuthError('Google sign-in could not be verified', 401);
    const email = String(idToken).slice(7).toLowerCase();
    return { sub: `sub-${email}`, email, name: email.split('@')[0], picture: null };
  },
  AuthError,
};
const gPath = require.resolve(path.join(__dirname, '..', 'services', 'google-auth.service'));
require.cache[gPath] = { id: gPath, filename: gPath, loaded: true, exports: fakeGoogle };

const manageSession = require('../builder/services/manageSession');
const manageAccess = require('../builder/services/manageAccess');

let fails = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? ` — ${extra}` : ''}`);
  if (!cond) fails++;
}

(async () => {
  // ─── The session token ──────────────────────────────────────────
  console.log('\n-- session token');
  const a = await manageSession.issue({ email: 'noa@lybi.ai', name: 'Noa', picture: 'https://x/p.png' });
  const who = await manageSession.verify(a.token);
  check('issue → verify gives back who it was', who && who.email === 'noa@lybi.ai' && who.name === 'Noa' && who.picture === 'https://x/p.png');
  const days = (new Date(a.expiresAt).getTime() - Date.now()) / 86400000;
  check(`lives ${manageSession.SESSION_DAYS} days`, manageSession.SESSION_DAYS === 30 && days > 29.9 && days <= 30);
  check('the secret is made once, in provider_config', config.has(manageSession.SECRET_KEY) && config.get(manageSession.SECRET_KEY).length >= 60);
  const firstSecret = config.get(manageSession.SECRET_KEY);
  manageSession._resetForTests();
  check('a second instance reads the same secret (insert-then-read, never overwrites)',
    (await manageSession.verify(a.token)) !== null && config.get(manageSession.SECRET_KEY) === firstSecret && secretInserts === 2);
  const [v, p, sig] = a.token.split('.');
  const forged = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  forged.e = 'evil@x.com';
  const forgedP = Buffer.from(JSON.stringify(forged)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('a changed payload fails', (await manageSession.verify(`${v}.${forgedP}.${sig}`)) === null);
  check('a changed signature fails', (await manageSession.verify(`${v}.${p}.${sig.slice(0, -2)}xx`)) === null);
  check('another version / junk / nothing fails',
    (await manageSession.verify(`v2.${p}.${sig}`)) === null && (await manageSession.verify('abc')) === null && (await manageSession.verify(null)) === null);
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 86400000;
  check('an expired token fails', (await manageSession.verify(a.token)) === null);
  Date.now = realNow;
  check('Bearer header parsing', manageSession.fromRequest({ headers: { authorization: 'Bearer abc.def.ghi' } }) === 'abc.def.ghi'
    && manageSession.fromRequest({ headers: {} }) === null && manageSession.fromRequest({ headers: { authorization: 'Basic x' } }) === null);

  // ─── Grants ─────────────────────────────────────────────────────
  console.log('\n-- grants');
  const team = await manageAccess.grantsFor('  Noa@Lybi.AI ');
  check('grants match a lowercased, trimmed address', team && team.email === 'noa@lybi.ai' && team.all === true);
  const two = await manageAccess.grantsFor('two@partner.com');
  check('one row per agent → the agent ids', two && two.all === false && two.agentIds.length === 2);
  check('no row → null (not allowed in)', (await manageAccess.grantsFor('nobody@x.com')) === null && (await manageAccess.grantsFor('')) === null);
  check('every agent → all agents', (await manageAccess.agentsFor(team)).length === AGENTS.length);
  check('their agents only', (await manageAccess.agentsFor(two)).map(x => x.slug).sort().join() === 'acme,other');
  check('canOpen: own agent yes, other agent no, unknown slug = not existing',
    (await manageAccess.canOpen({ all: false, agentIds: ['agent_acme'] }, 'acme')).allowed
    && !(await manageAccess.canOpen({ all: false, agentIds: ['agent_acme'] }, 'other')).allowed
    && !(await manageAccess.canOpen(team, 'nope')).exists);

  // ─── The routes ─────────────────────────────────────────────────
  console.log('\n-- routes');
  const app = express();
  app.use(express.json());
  app.use('/api/manage', require('../builder/routes/manageRoute'));
  app.use('/builder/mcp', require('../builder/routes/mcpRoute'));
  const srv = app.listen(0);
  const port = srv.address().port;
  const call = async (method, p, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, text, json };
  };
  try {
    const cfg = await call('GET', '/api/manage/auth/config');
    check('auth/config is open and gives the OAuth client id', cfg.status === 200 && cfg.json.clientId === fakeGoogle.CLIENT_ID);

    const ok = await call('POST', '/api/manage/auth/google', { body: { idToken: 'google:Noa@lybi.ai' } });
    check('Google sign-in with a grant → token + me', ok.status === 200 && !!ok.json.token && ok.json.me.email === 'noa@lybi.ai' && ok.json.me.all === true);
    check('…me lists every agent for an every-agent grant', ok.status === 200 && ok.json.me.agents.length === AGENTS.length && ok.json.me.agents.every(x => 'slug' in x && 'name' in x && 'archived' in x && !('id' in x)));
    const noTeam = await call('POST', '/api/manage/auth/google', { body: { idToken: 'google:stranger@gmail.com' } });
    check('Google sign-in without a grant → 403 no_access, naming the address', noTeam.status === 403 && noTeam.json.code === 'no_access' && noTeam.json.email === 'stranger@gmail.com' && !noTeam.json.token);
    const bad = await call('POST', '/api/manage/auth/google', { body: { idToken: 'forged' } });
    check('a token Google does not vouch for → 401', bad.status === 401 && bad.json.code === 'google_failed');
    check('no token at all → 400', (await call('POST', '/api/manage/auth/google', { body: {} })).status === 400);

    const noaT = ok.json.token;
    const acmeT = (await call('POST', '/api/manage/auth/google', { body: { idToken: 'google:super@acme.com' } })).json.token;
    const twoT = (await call('POST', '/api/manage/auth/google', { body: { idToken: 'google:two@partner.com' } })).json.token;

    check('/me without a token → 401 signed_out', (await call('GET', '/api/manage/me')).json?.code === 'signed_out');
    check('/me with a forged token → 401', (await call('GET', '/api/manage/me', { token: `${noaT}x` })).status === 401);
    const meOne = await call('GET', '/api/manage/me', { token: acmeT });
    check('/me: one agent → just that agent, all = false', meOne.status === 200 && meOne.json.all === false && meOne.json.agents.map(x => x.slug).join() === 'acme');
    const meTwo = await call('GET', '/api/manage/me', { token: twoT });
    check('/me: two agents → those two', meTwo.status === 200 && meTwo.json.all === false && meTwo.json.agents.length === 2);

    // Revoke while the token is still valid → closed at once.
    const i = GRANTS.findIndex(g => g.email === 'super@acme.com');
    const [removed] = GRANTS.splice(i, 1);
    const after = await call('GET', '/api/manage/me', { token: acmeT });
    check('a deleted grant closes the door at once (valid token, 403 no_access)', after.status === 403 && after.json.code === 'no_access' && after.json.email === 'super@acme.com');
    check('…on every page, too', (await call('GET', '/api/manage/agents/acme/customer-problems', { token: acmeT })).status === 403);
    GRANTS.splice(i, 0, removed);

    // The conversation window
    const conv = await call('GET', '/api/manage/agents/acme/conversations/10', { token: acmeT });
    check('conversation window: the basic facts', conv.status === 200 && conv.json.customerName === 'Ronit' && conv.json.phase === 'Opening'
      && conv.json.messageCount === 12 && conv.json.customerMessages === 6 && conv.json.audience === 'real' && conv.json.agentName === 'Acme bank');
    check('…the last messages oldest first, as customer / agent',
      conv.status === 200 && conv.json.messages.map(m => m.role).join() === 'customer,agent,customer' && conv.json.messages[0].text.startsWith('שלום'));
    const convSql = queries.find(q => /currentCrewId/.test(q.sql));
    check('…customer chat only, and only on the agent in the address',
      !!convSql && /c\.kind = 'user'/.test(convSql.sql) && /metadata->>'kind' = 'live'/.test(convSql.sql) && /a\.url_slug = \$2/.test(convSql.sql));
    check('…no internals (no add-on runs, prompts or metadata)', conv.status === 200 && !/addonRuns|prompt|metadata/.test(conv.text));
    check('a conversation of another agent → 404', (await call('GET', '/api/manage/agents/other/conversations/10', { token: twoT })).status === 404);
    check('another agent\'s address → 403 (not theirs)', (await call('GET', '/api/manage/agents/other/conversations/10', { token: acmeT })).status === 403);
    check('a nonsense id → 404', (await call('GET', '/api/manage/agents/acme/conversations/abc', { token: noaT })).status === 404);
    check('no token → 401', (await call('GET', '/api/manage/agents/acme/conversations/10')).status === 401);
    check('every-agent view: two-agent grant → 403 not_all', (await call('GET', '/api/manage/customer-problems', { token: twoT })).json?.code === 'not_all');
    check('the super-admin key opens nothing any more',
      (await fetch(`http://127.0.0.1:${port}/api/manage/customer-problems`, { headers: { 'X-Super-Admin-Key': require('../services/super-admin').SUPER_ADMIN_KEY } })).status === 401);

    // The MCP — read only
    const entry = await call('GET', '/builder/mcp');
    check('MCP entry page points at /access (template literal intact)', entry.status === 200 && entry.text.includes('/access') && entry.text.includes('/agents/<slug>/access'));
    const all = await call('GET', '/builder/mcp/access');
    check('MCP /access lists every grant', all.status === 200 && all.text.includes('noa@lybi.ai → EVERY agent') && all.text.includes('two@partner.com → Other (other)') && /3 address\(es\), 4 grant\(s\)/.test(all.text), all.text.slice(0, 300));
    const one = await call('GET', '/builder/mcp/agents/other/access');
    check('MCP /agents/<slug>/access: its own grants + the every-agent ones',
      one.status === 200 && /own grants \(1\)/.test(one.text) && one.text.includes('two@partner.com') && /Every-agent grants \(1\)/.test(one.text) && !one.text.includes('super@acme.com'), one.text);
    check('MCP unknown agent → 404', (await call('GET', '/builder/mcp/agents/nope/access')).status === 404);
    check('MCP has no way to grant (POST /access is not a route)', (await call('POST', '/builder/mcp/access', { body: { email: 'x@y.z' } })).status === 404);
  } finally {
    srv.close();
  }

  // ─── Migration 070, schema, CORS ────────────────────────────────
  console.log('\n-- migration');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '070_manage_access.sql'), 'utf8');
  const stmts = sql.replace(/--[^\n]*/g, '').split(';').map(x => x.trim()).filter(Boolean);
  check('every CREATE is IF NOT EXISTS (safe to run twice)', stmts.filter(x => /^CREATE/i.test(x)).every(x => /IF NOT EXISTS/i.test(x)));
  check('the seed skips rows already there', stmts.filter(x => /^INSERT/i.test(x)).every(x => /ON CONFLICT DO NOTHING$/i.test(x)));
  check('seeds the three Lybi addresses with every agent',
    ['shlomi@lybi.ai', 'noa@lybi.ai', 'hila@lybi.ai'].every(e => new RegExp(`'${e.replace('.', '\\.')}',\\s*NULL`).test(sql)));
  check('agent_id → builder_agents ON DELETE CASCADE, email kept lowercased',
    /REFERENCES builder_agents\(id\) ON DELETE CASCADE/.test(sql) && /email = lower\(btrim\(email\)\)/.test(sql));
  check('one every-agent row per person, one row per person per agent',
    /ON manage_access \(email\) WHERE agent_id IS NULL/.test(sql) && /ON manage_access \(email, agent_id\) WHERE agent_id IS NOT NULL/.test(sql));
  check('a paired runner', fs.existsSync(path.join(__dirname, '..', 'db', 'migrations', 'run-070-manage-access.js')));
  const schema = require('../db/schema/builder');
  check('drizzle knows the table', !!schema.manageAccess);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('CORS lets the Authorization header through (dev + production lists)',
    (server.match(/allowedHeaders: \[[^\]]*'Authorization'[^\]]*\]/g) || []).length === 2);

  console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(err => { console.error('BATTERY ERROR:', err); process.exit(1); });
