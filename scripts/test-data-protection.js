#!/usr/bin/env node
/**
 * Battery for data protection (task #986) — fully OFFLINE: no database, no
 * model, no network. The database module is a stub in `require.cache`
 * (never `.env`), so nothing here can touch Origin or staging.
 *
 *   node scripts/test-data-protection.js
 *
 *   A. detectors.mjs — every detector, normalisation, no text in the output
 *   B. settings — defaults, crew exceptions, off agents, validation
 *   C. the server gate (runtimeRoute POST .../messages): a match saves
 *      nothing, runs nothing, records detector ids only, and emits
 *      `protection.blocked`; a failed record still blocks; a clean message
 *      runs the turn on the SAME runnable the gate checked
 *   D. the chat's block calls (protectionRoute)
 *   E. the MCP door: read, set agent, set crew exception, keep-rules,
 *      test, detectors, report
 *   F. static guards: the gate sits before the message insert; nothing
 *      hands message text to the record
 *
 * Exits 1 on any failure.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

let fails = 0;
let passes = 0;
function check(name, cond, extra = '') {
  if (cond) passes++; else fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? ` — ${extra}` : ''}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

const ROOT = path.join(__dirname, '..');

// ─── The database stub (installed before anything requires it) ──────

const dbCalls = { inserts: [], queries: [], updates: [] };
const state = {
  convRow: null,          // what SELECT conversations returns
  failEventInsert: false, // make the protection_events INSERT throw
  agentExists: true,
  convOfAgent: true,
  nextEventId: 500,
};

function tableName(t) {
  try {
    const sym = Object.getOwnPropertySymbols(t).find(s => String(s) === 'Symbol(drizzle:Name)');
    return sym ? t[sym] : null;
  } catch { return null; }
}

function chain() {
  const op = { kind: null, table: null, values: null };
  const c = {
    select() { op.kind = op.kind || 'select'; return c; },
    from(t) { op.table = tableName(t); return c; },
    where() { return c; }, limit() { return c; }, orderBy() { return c; },
    innerJoin() { return c; }, leftJoin() { return c; },
    insert(t) { op.kind = 'insert'; op.table = tableName(t); return c; },
    values(v) { op.values = v; return c; },
    returning() { return c; },
    update(t) { op.kind = 'update'; op.table = tableName(t); return c; },
    set(v) { op.values = v; return c; },
    delete(t) { op.kind = 'delete'; op.table = tableName(t); return c; },
    then(resolve, reject) {
      try {
        if (op.kind === 'insert') {
          dbCalls.inserts.push({ table: op.table, values: op.values });
          return resolve([{ id: 9000 + dbCalls.inserts.length, ...op.values }]);
        }
        if (op.kind === 'update') { dbCalls.updates.push({ table: op.table, values: op.values }); return resolve([]); }
        if (op.kind === 'delete') return resolve([]);
        if (op.table === 'users') return resolve([{ id: 5, externalId: 'u1', metadata: {} }]);
        if (op.table === 'conversations') return resolve(state.convRow ? [state.convRow] : []);
        return resolve([]);
      } catch (e) { return reject(e); }
    },
  };
  return c;
}

const dbStub = {
  getDrizzle: () => chain(),
  query: async (sql, params = []) => {
    dbCalls.queries.push({ sql, params });
    if (/INSERT INTO protection_events/.test(sql)) {
      if (state.failEventInsert) throw new Error('relation "protection_events" does not exist');
      return { rows: [{ id: state.nextEventId++ }] };
    }
    if (/UPDATE protection_events/.test(sql)) return { rows: params[0] === 501 ? [{ id: 501, already: false }] : [] };
    if (/FROM builder_agents/.test(sql)) return { rows: state.agentExists ? [{ '?column?': 1 }] : [] };
    if (/FROM conversations/.test(sql)) return { rows: state.convOfAgent ? [{ '?column?': 1 }] : [] };
    if (/count\(\*\)::int AS total/.test(sql)) return { rows: [{ total: 3, mistakes: 1 }] };
    if (/GROUP BY side/.test(sql)) return { rows: [{ side: 'client', n: 2 }, { side: 'server', n: 1 }] };
    if (/GROUP BY surface/.test(sql)) return { rows: [{ surface: 'live', n: 3 }] };
    if (/unnest\(detectors\)/.test(sql)) return { rows: [{ id: 'il_id', blocks: 2, mistakes: 1 }, { id: 'credit_card', blocks: 1, mistakes: 0 }] };
    if (/ORDER BY created_at DESC/.test(sql)) return { rows: [{ id: 7, created_at: new Date('2026-11-18T08:00:00Z'), side: 'server', surface: 'live', detectors: ['il_id'], conversation_id: 42, lang: 'he', mistake_reported_at: null }] };
    return { rows: [] };
  },
  initialize: async () => {},
  getPool: () => ({ query: dbStub.query }),
};
const dbPath = require.resolve(path.join(ROOT, 'services/db.pg'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

// ─── Agent / crew bodies the stubs serve ─────────────────────────────

const AGENT_SLUG = 'zz-dp-test';
const fixture = {
  agentBody: { name: 'DP test', slug: AGENT_SLUG, defaultCrewId: 'crew_a', dataProtection: { enabled: true } },
  crews: {
    crew_a: { name: 'Intake', addons: [], fields: [] },
    crew_b: { name: 'Closing', addons: [], fields: [], dataProtection: { detectors: { il_id: false } } },
  },
};

const bp = require(path.join(ROOT, 'builder/services/builderProjects'));
const resolveCalls = [];
bp.resolveRunnable = async (args) => {
  resolveCalls.push(args);
  const crewId = args.overrideCrewId && fixture.crews[args.overrideCrewId] ? args.overrideCrewId : fixture.agentBody.defaultCrewId;
  return {
    agent: { id: 'agent_x', slug: AGENT_SLUG, versionId: 'ver_a', body: args.overrideAgentBody || fixture.agentBody },
    crew: { id: crewId, versionId: 'ver_c', body: args.overrideCrewBody || fixture.crews[crewId] },
  };
};

function startServer(app) {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

function sseEvents(text) {
  return text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
}

(async () => {
  const m = await import(path.join(ROOT, 'builder/protection/detectors.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const ALL = m.DETECTOR_IDS;
  const fired = (text, ids = ALL) => m.detect(text, ids).map(h => h.id);

  // ═══ A. Detectors ═══
  section('A. detectors');
  check('Israeli ID with a valid check digit', fired('my id is 123456782').includes('il_id'));
  check('9 digits with a wrong check digit pass', !fired('id 123456789').includes('il_id'));
  check('ID written with dashes', fired('ת.ז 12345-678-2').includes('il_id'));
  check('ID with an RLM mark inside (Hebrew keyboards)', fired('1‏23456782').includes('il_id'));
  check('ID in Arabic-Indic digits', fired('١٢٣٤٥٦٧٨٢').includes('il_id'));
  check('all-zero "ID" is not an ID', !fired('000000000').includes('il_id'));
  check('a 9-digit ID inside a longer reference number is not pulled out', !fired('ref 99123456782').includes('il_id'));
  check('card 4111 1111 1111 1111 (Luhn)', fired('card 4111 1111 1111 1111').includes('credit_card'));
  check('card with dashes', fired('4111-1111-1111-1111').includes('credit_card'));
  check('16 digits failing Luhn pass', !fired('4111 1111 1111 1112').includes('credit_card'));
  check('Amex 4-6-5', fired('3782 822463 10005').includes('credit_card'));
  check('an ID next to a phone is not read as one card', !fired('123456782 0521234567').includes('credit_card'));
  check('IBAN IL62 0108 0000 0009 9999 999', fired('IBAN IL62 0108 0000 0009 9999 999').includes('iban'));
  check('IBAN with a bad check passes', !fired('IL63 0108 0000 0009 9999 999').includes('iban'));
  check('passport after the word "דרכון"', fired('מספר הדרכון שלי 12345678').includes('passport'));
  check('8 digits without "passport" are not a passport', !fired('the price is 12345678').includes('passport'));
  check('bank account after "חשבון"', fired('מספר חשבון 123456').includes('bank_account'));
  check('bank account after final-nun-less "חשבונות"', fired('חשבונות 1234567').includes('bank_account'));
  check('a short amount after "חשבון" is not an account', !fired('חשבון של 5000 שקל').includes('bank_account'));
  check('Israeli mobile 052-123-4567', fired('call 052-123-4567').includes('phone'));
  check('+972 mobile', fired('+972 52 123 4567').includes('phone'));
  check('international +44', fired('+44 20 7946 0958').includes('phone'));
  check('email', fired('mail a.b@x.co.il').includes('email'));
  check('plain Hebrew text passes everything', fired('שלום, אני רוצה לפתוח חשבון').length === 0);
  check('an amount passes everything', fired('I earn 12,000 a month and pay 3500 rent').length === 0);
  check('only the asked detectors run', fired('my id is 123456782 mail a@b.co', ['email']).join() === 'email');
  check('no detectors asked → nothing', m.detect('123456782', []).length === 0);
  const hit = m.detect('id 123456782 and 123456782', ALL)[0];
  check('output is {id, count} only — never the text', JSON.stringify(Object.keys(hit)) === '["id","count"]' && hit.count === 2, JSON.stringify(hit));
  check('every detector has he/en name + matches', m.DETECTORS.every(d => d.name.he && d.name.en && d.matches.he && d.matches.en));

  // ═══ B. Settings ═══
  section('B. settings');
  let r = m.resolveSettings(undefined, undefined);
  check('absent = off, checks nothing', r.enabled === false && r.detectorIds.length === 0);
  r = m.resolveSettings({ enabled: true });
  check('on with no switches = ID / card / IBAN only', r.detectorIds.join() === 'il_id,credit_card,iban', r.detectorIds.join());
  r = m.resolveSettings({ enabled: true, detectors: { phone: true, iban: false } });
  check('agent switches win over defaults', r.detectorIds.join() === 'il_id,credit_card,phone', r.detectorIds.join());
  r = m.resolveSettings({ enabled: true }, { detectors: { il_id: false } });
  check('crew exception turns il_id off for that crew', !r.detectorIds.includes('il_id') && r.crewOverrides.join() === 'il_id');
  r = m.resolveSettings({ enabled: false }, { detectors: { phone: true } });
  check('a crew cannot turn protection on for an off agent', r.enabled === false && r.detectorIds.length === 0);
  r = m.resolveSettings({ enabled: true, blockedMessage: { he: 'הודעה', en: '  ' } });
  check('own message used; blank falls back to built-in', r.blockedMessage.he === 'הודעה' && r.blockedMessage.en === m.DEFAULT_BLOCKED_MESSAGE.en);
  check('messageFor: en → en, anything else → he', m.messageFor(r, 'en') === r.blockedMessage.en && m.messageFor(r, 'fr') === 'הודעה');
  check('checkMessage: clean → null', m.checkMessage('hello', { dataProtection: { enabled: true } }, {}, 'he') === null);
  const cm = m.checkMessage('id 123456782', { dataProtection: { enabled: true } }, {}, 'en');
  check('checkMessage: match → detectors + message in the asked language', cm && cm.detectors.join() === 'il_id' && cm.message === m.DEFAULT_BLOCKED_MESSAGE.en);
  check('checkMessage: crew exception lets the ID through', m.checkMessage('id 123456782', { dataProtection: { enabled: true } }, { dataProtection: { detectors: { il_id: false } } }, 'he') === null);
  check('valid agent settings → no problems', m.agentSettingsProblems({ enabled: true, detectors: { phone: true }, blockedMessage: { he: 'x', en: 'y' } }).length === 0);
  check('unknown detector refused', m.agentSettingsProblems({ enabled: true, detectors: { ssn: true } }).length === 1);
  check('non-boolean switch refused', m.agentSettingsProblems({ detectors: { il_id: 'yes' } }).length === 1);
  check('unknown key refused', m.agentSettingsProblems({ enabled: true, foo: 1 }).length === 1);
  check('too-long message refused', m.agentSettingsProblems({ blockedMessage: { he: 'x'.repeat(m.MAX_MESSAGE_LENGTH + 1) } }).length === 1);
  check('crew may only carry detectors', m.crewSettingsProblems({ enabled: true }).length === 1 && m.crewSettingsProblems({ detectors: { il_id: false } }).length === 0);

  // ═══ C. The server gate ═══
  section('C. server gate (runtimeRoute)');
  const runner = require(path.join(ROOT, 'builder/runtime/BuilderRunner'));
  const runOnceCalls = [];
  runner.runOnce = async (args) => { runOnceCalls.push(args); return { assistantText: 'hi' }; };
  const express = require('express');
  const appR = express();
  appR.use(express.json());
  appR.use('/api/agents', require(path.join(ROOT, 'builder/routes/protectionRoute')));
  appR.use('/api/agents', require(path.join(ROOT, 'builder/routes/runtimeRoute')));
  const { server: srvR, base: baseR } = await startServer(appR);

  const send = (body) => postJson(`${baseR}/api/agents/${AGENT_SLUG}/conversations/42/messages`, { ownerUserId: 'u1', version: 'published', ...body });
  const reset = () => { dbCalls.inserts.length = 0; dbCalls.queries.length = 0; runOnceCalls.length = 0; resolveCalls.length = 0; };

  state.convRow = { id: 42, metadata: { kind: 'live', agentSlug: AGENT_SLUG, name: 'x' } };
  reset();
  let out = await send({ userMessage: 'my id is 123456782', lang: 'en' });
  let evs = sseEvents(out.text);
  const blockedEv = evs.find(e => e.type === 'protection.blocked');
  check('a match emits protection.blocked', !!blockedEv, out.text.slice(0, 200));
  check('…with detector ids, block id and the en message', blockedEv && blockedEv.detectors.join() === 'il_id' && blockedEv.blockId === 500 && blockedEv.message === m.DEFAULT_BLOCKED_MESSAGE.en);
  check('…then done', evs.some(e => e.type === 'done'));
  check('a match inserts NO message row', dbCalls.inserts.filter(i => i.table === 'messages').length === 0, JSON.stringify(dbCalls.inserts.map(i => i.table)));
  check('a match runs NO turn', runOnceCalls.length === 0);
  const evInsert = dbCalls.queries.find(q => /INSERT INTO protection_events/.test(q.sql));
  check('the block is recorded (server, live, il_id, en)', evInsert && evInsert.params[0] === AGENT_SLUG && evInsert.params[1] === 42 && evInsert.params[2] === 'server' && evInsert.params[3] === 'live' && evInsert.params[4].join() === 'il_id' && evInsert.params[5] === 'en', JSON.stringify(evInsert && evInsert.params));
  check('the record never holds the text', !JSON.stringify(dbCalls.queries.map(q => q.params)).includes('123456782'));
  check('no conversation event, no auto-name on a block', !evs.some(e => e.type === 'conversation') && dbCalls.updates.length === 0);

  reset();
  state.failEventInsert = true;
  out = await send({ userMessage: '4111 1111 1111 1111' });
  evs = sseEvents(out.text);
  const ev2 = evs.find(e => e.type === 'protection.blocked');
  check('a failed record STILL blocks (blockId null, he message)', ev2 && ev2.blockId === null && ev2.message === m.DEFAULT_BLOCKED_MESSAGE.he && runOnceCalls.length === 0 && dbCalls.inserts.filter(i => i.table === 'messages').length === 0);
  state.failEventInsert = false;

  reset();
  out = await send({ userMessage: 'hello, I want to open an account' });
  evs = sseEvents(out.text);
  check('a clean message is saved and runs the turn', dbCalls.inserts.some(i => i.table === 'messages' && i.values.role === 'user') && runOnceCalls.length === 1);
  check('…on the SAME runnable the gate checked (one resolve)', resolveCalls.length === 1 && runOnceCalls[0] && runOnceCalls[0].runnable && runOnceCalls[0].runnable.crew.id === 'crew_a');

  reset();
  state.convRow = { id: 42, metadata: { kind: 'live', agentSlug: AGENT_SLUG, name: 'x', currentCrewId: 'crew_b' } };
  out = await send({ userMessage: 'my id is 123456782' });
  check('the current crew\'s exception (Closing, il_id off) lets the ID through', runOnceCalls.length === 1 && !sseEvents(out.text).some(e => e.type === 'protection.blocked'));
  reset();
  out = await send({ userMessage: 'card 4111 1111 1111 1111' });
  check('…but the same crew still blocks a card', sseEvents(out.text).some(e => e.type === 'protection.blocked'));

  reset();
  state.convRow = { id: 42, metadata: { kind: 'builder-preview', agentSlug: AGENT_SLUG, name: 'x' } };
  out = await send({ userMessage: 'my id is 123456782', overrideAgentBody: { ...fixture.agentBody, dataProtection: { enabled: false } } });
  check('Builder working copy is honoured (unsaved "off" lets it through)', runOnceCalls.length === 1);
  reset();
  out = await send({ userMessage: 'my id is 123456782', overrideCrewId: 'crew_b' });
  check('a per-turn crew override picks that crew\'s exception', runOnceCalls.length === 1 && resolveCalls[0].overrideCrewId === 'crew_b');
  reset();
  out = await send({ userMessage: 'card 4111 1111 1111 1111' });
  const ev3 = dbCalls.queries.find(q => /INSERT INTO protection_events/.test(q.sql));
  check('Builder test chat is recorded as surface "builder"', ev3 && ev3.params[3] === 'builder');
  srvR.close();

  // ═══ D. The chat's block calls ═══
  section('D. protectionRoute (browser blocks + mistake tap)');
  const appP = express();
  appP.use(express.json());
  appP.use('/api/agents', require(path.join(ROOT, 'builder/routes/protectionRoute')));
  const { server: srvP, base: baseP } = await startServer(appP);
  reset();
  out = await postJson(`${baseP}/api/agents/${AGENT_SLUG}/protection-events`, { surface: 'live', detectors: ['il_id', 'il_id'], conversationId: 42, lang: 'he', text: 'my id is 123456782' });
  const ins = dbCalls.queries.find(q => /INSERT INTO protection_events/.test(q.sql));
  check('a browser block is recorded → blockId', out.status === 200 && /"blockId":\d+/.test(out.text), out.text);
  check('…side client, ids de-duplicated, the stray "text" never stored', ins && ins.params[2] === 'client' && ins.params[4].join() === 'il_id' && !JSON.stringify(ins.params).includes('123456782'));
  out = await postJson(`${baseP}/api/agents/${AGENT_SLUG}/protection-events`, { surface: 'live', detectors: ['ssn'] });
  check('unknown detector → 400', out.status === 400);
  out = await postJson(`${baseP}/api/agents/${AGENT_SLUG}/protection-events`, { surface: 'api', detectors: ['il_id'] });
  check('a browser can only say live / builder', out.status === 400);
  state.convOfAgent = false;
  out = await postJson(`${baseP}/api/agents/${AGENT_SLUG}/protection-events`, { surface: 'live', detectors: ['il_id'], conversationId: 99 });
  check('a conversation of another agent → 404', out.status === 404);
  state.convOfAgent = true;
  state.agentExists = false;
  out = await postJson(`${baseP}/api/agents/nope/protection-events`, { surface: 'live', detectors: ['il_id'] });
  check('unknown agent → 404', out.status === 404);
  state.agentExists = true;
  out = await postJson(`${baseP}/api/agents/${AGENT_SLUG}/protection-events/501/mistake`, {});
  check('"blocked by mistake" → ok', out.status === 200 && /"ok":true/.test(out.text), out.text);
  out = await postJson(`${baseP}/api/agents/${AGENT_SLUG}/protection-events/777/mistake`, {});
  check('mistake on an unknown block → 404', out.status === 404);
  {
    const res = await fetch(`${baseP}/api/agents/${AGENT_SLUG}/protection-events?days=7`);
    const j = await res.json();
    check('Admin report (P3): totals, per detector, recent rows', res.status === 200 && j.total === 3 && j.mistakes === 1
      && j.byDetector[0].id === 'il_id' && j.recent[0].conversationId === 42 && j.bySide.client === 2, JSON.stringify(j).slice(0, 200));
    const q = dbCalls.queries.find(x => /ORDER BY created_at DESC/.test(x.sql));
    check('…scoped to the agent and the period', q && q.params[0] === AGENT_SLUG && q.params[1] === 7);
  }
  srvP.close();

  // ═══ E. The MCP door ═══
  section('E. MCP (/builder/mcp)');
  const agentVersions = [{ id: 'ver_a1', body: { ...fixture.agentBody } }];
  const crewDoc = (id) => ({
    id, name: fixture.crews[id].name, ...fixture.crews[id],
    versions: [{ id: `ver_${id}`, body: { ...fixture.crews[id] } }], activeVersionId: `ver_${id}`,
  });
  const saved = { agent: [], crew: [] };
  bp.hydrateProject = async ({ agentSlug }) => (agentSlug !== AGENT_SLUG ? null : {
    agents: [{
      id: 'agent_x', slug: AGENT_SLUG, name: 'DP test',
      dataProtection: agentVersions[0].body.dataProtection,
      crews: [crewDoc('crew_a'), crewDoc('crew_b')],
      versions: agentVersions, activeVersionId: 'ver_a1', publishedVersionId: 'ver_a1',
    }],
  });
  bp.nextAgentWideNumber = async () => 7;
  bp.saveAgentVersionAs = async (a) => { saved.agent.push(a); };
  bp.setAgentActive = async () => {};
  bp.saveCrewVersionAs = async (a) => { saved.crew.push(a); };
  bp.setCrewActive = async () => {};
  const appM = express();
  appM.use(express.json());
  appM.use('/builder/mcp', require(path.join(ROOT, 'builder/routes/mcpRoute')));
  const { server: srvM, base: baseM } = await startServer(appM);
  const mcp = `${baseM}/builder/mcp`;

  let res = await fetch(`${mcp}/agents/${AGENT_SLUG}/data-protection`);
  let txt = await res.text();
  check('GET data-protection: status, detectors, crews', res.status === 200 && /Status: ON/.test(txt) && /il_id: on \(default\)/.test(txt) && /Closing \(crew_b\): exception \{"il_id":false\} → checks credit_card, iban/.test(txt), txt.slice(0, 400));
  check('GET data-protection shows the published state', /Customers get the PUBLISHED version: ON there/.test(txt));

  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/data-protection`, { detectors: { phone: true } });
  let lastAgent = saved.agent[saved.agent.length - 1];
  check('POST agent: only what was sent changes (phone on, still enabled)', out.status === 200 && lastAgent && lastAgent.body.dataProtection.enabled === true && lastAgent.body.dataProtection.detectors.phone === true, out.text.slice(0, 200));
  check('…a new version, with the summary line', /Saved\./.test(out.text) && /checks il_id, credit_card, iban, phone/.test(out.text));
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/data-protection`, { detectors: { ssn: true } });
  check('POST agent: unknown detector refused, nothing saved', out.status === 400 && saved.agent.length === 1);
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/data-protection`, { enabled: true });
  check('POST agent: no change → "Nothing to change"', out.status === 200 && /Nothing to change/.test(out.text) && saved.agent.length === 1);
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/data-protection`, { blockedMessage: { he: 'הודעה שלנו' } });
  lastAgent = saved.agent[saved.agent.length - 1];
  check('POST agent: own Hebrew message saved', lastAgent.body.dataProtection.blockedMessage.he === 'הודעה שלנו');
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/data-protection`, { clear: true });
  lastAgent = saved.agent[saved.agent.length - 1];
  check('POST agent: clear removes the key (= off)', !('dataProtection' in lastAgent.body));
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/data-protection`, { colour: 'red' });
  check('POST agent: unknown key refused', out.status === 400);

  const agentSavesBeforeCrew = saved.agent.length;
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/crews/crew_a/data-protection`, { detectors: { phone: false } });
  let lastCrew = saved.crew[saved.crew.length - 1];
  check('POST crew: exception saved on that crew only', out.status === 200 && lastCrew && JSON.stringify(lastCrew.body.dataProtection) === '{"detectors":{"phone":false}}', out.text.slice(0, 200));
  check('…with an unchanged agent copy under the same number (#923)', saved.agent.length === agentSavesBeforeCrew + 1 && saved.agent[saved.agent.length - 1].number === 7 && saved.crew[saved.crew.length - 1].number === 7);
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/crews/crew_b/data-protection`, { detectors: { il_id: null } });
  lastCrew = saved.crew[saved.crew.length - 1];
  check('POST crew: null = back to the agent (exception removed)', out.status === 200 && !('dataProtection' in lastCrew.body));
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/crews/crew_a/data-protection`, { enabled: false });
  check('POST crew: only detectors may be overridden', out.status === 400);
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/crews/crew_zz/data-protection`, { detectors: { il_id: false } });
  check('POST crew: unknown crew → 404', out.status === 404);

  const before = saved.agent.length;
  const fullBody = { ...fixture.agentBody };
  delete fullBody.dataProtection;
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}`, { body: fullBody });
  check('whole agent body without dataProtection KEEPS it', out.status === 200 && saved.agent[before] && saved.agent[before].body.dataProtection && saved.agent[before].body.dataProtection.enabled === true);
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}`, { body: { ...fullBody, dataProtection: { enabled: 'yes' } } });
  check('whole agent body with a bad dataProtection is refused', out.status === 400);
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}`, { body: { ...fullBody, dataProtection: null } });
  check('whole agent body with dataProtection null removes it', out.status === 200 && !('dataProtection' in saved.agent[saved.agent.length - 1].body));
  const crewBefore = saved.crew.length;
  const crewBody = { ...fixture.crews.crew_b };
  delete crewBody.dataProtection;
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/crews/crew_b`, { body: crewBody });
  check('whole crew body without dataProtection KEEPS the exception', out.status === 200 && saved.crew[crewBefore] && JSON.stringify(saved.crew[crewBefore].body.dataProtection) === '{"detectors":{"il_id":false}}');
  out = await postJson(`${mcp}/agents/${AGENT_SLUG}/crews/crew_b`, { body: { ...crewBody, dataProtection: { enabled: true } } });
  check('whole crew body with a bad exception is refused', out.status === 400);

  out = await postJson(`${mcp}/protection/test`, { text: 'my id is 123456782', agent: AGENT_SLUG });
  check('test: blocks an ID on the agent', out.status === 200 && /^BLOCKED — Israeli ID number \(il_id\) ×1/.test(out.text) && !out.text.includes('123456782'), out.text);
  out = await postJson(`${mcp}/protection/test`, { text: 'my id is 123456782', agent: AGENT_SLUG, crewId: 'crew_b' });
  check('test: passes in the crew with the ID exception', /^PASSES/.test(out.text), out.text);
  out = await postJson(`${mcp}/protection/test`, { text: 'mail a@b.co' });
  check('test: no agent → every detector', /email/.test(out.text));
  res = await fetch(`${mcp}/protection/detectors`);
  txt = await res.text();
  check('detectors catalog lists all seven', m.DETECTOR_IDS.every(id => txt.includes(`- ${id} —`)));
  res = await fetch(`${mcp}/agents/${AGENT_SLUG}/protection-events?days=7`);
  txt = await res.text();
  check('report: totals, mistake rate, per detector, recent', /3 blocked message\(s\); 1 reported "blocked by mistake" \(33%\)/.test(txt) && /Israeli ID number \(il_id\): 2 block/.test(txt) && /#7 2026-11-18/.test(txt), txt.slice(0, 500));
  res = await fetch(`${mcp}/`);
  txt = await res.text();
  check('entry page documents data protection', /Data protection — stopping sensitive personal data/.test(txt) && /data-protection/.test(txt));
  srvM.close();

  // ═══ F. Static guards ═══
  section('F. static guards');
  const route = fs.readFileSync(path.join(ROOT, 'builder/routes/runtimeRoute.js'), 'utf8');
  const post = route.slice(route.indexOf("router.post('/:slug/conversations/:convId/messages'"));
  check('the gate runs before the user message is inserted', post.indexOf('protection.checkMessage(') > 0 && post.indexOf('protection.checkMessage(') < post.indexOf('d.insert(messages)'));
  check('the record call never gets the message text', !/protectionEvents\.record\(\{[^}]*userMessage/.test(route));
  const svc = fs.readFileSync(path.join(ROOT, 'builder/services/protectionEvents.js'), 'utf8');
  check('protectionEvents has no text / message parameter', !/function record\(\{[^}]*(text|message)/.test(svc));
  const sql = fs.readFileSync(path.join(ROOT, 'db/migrations/071_protection_events.sql'), 'utf8');
  check('the table has no column for text or a hash', !/\b(text_value|value|content|hash|message)\s+(TEXT|VARCHAR)/i.test(sql));

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(err => { console.error('BATTERY CRASHED:', err); process.exit(1); });
