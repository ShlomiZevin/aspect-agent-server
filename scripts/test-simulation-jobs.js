#!/usr/bin/env node
/**
 * Offline battery for simulation jobs (builder/services/simulationJobs.js,
 * task #897).
 *
 *   node scripts/test-simulation-jobs.js
 *
 * No database, no network, no model: the database and the agent are
 * stand-ins, so this checks the JOB logic only — release, run to the end,
 * stop reasons, failure, interrupted jobs, listing. Exits 1 on any failure.
 * After changing the service, also release one real job against a test
 * agent (see docs/guides/BUILDER_MCP_MAINTENANCE.md).
 */

const path = require('path');
const root = path.join(__dirname, '..') + path.sep;
const fake = (file, exports) => { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; };

const rows = [];
let nextId = 1;
const match = (r, c) => (!c ? true : c.and ? c.and.every(x => match(r, x)) : r[c.col] === c.val);
const drizzle = () => ({
  insert: () => ({ values: v => ({ returning: async () => { const r = { id: nextId++, error: null, createdAt: new Date(), updatedAt: new Date(), ...v }; rows.push(r); return [{ ...r }]; } }) }),
  update: () => ({ set: p => ({ where: c => { const hit = rows.filter(r => match(r, c)); hit.forEach(r => Object.assign(r, p)); const out = hit.map(r => ({ ...r })); return Object.assign(Promise.resolve(out), { returning: async () => out }); } }) }),
  select: () => ({ from: () => ({ where: c => { const hit = rows.filter(r => match(r, c)).map(r => ({ ...r })); return { limit: async () => hit, orderBy: () => ({ limit: async () => [...hit].sort((a, b) => b.createdAt - a.createdAt) }) }; } }) }),
});
fake(root + 'services/db.pg.js', { getDrizzle: drizzle });
fake(root + 'db/schema/index.js', { testRuns: { id: 'id', type: 'type', agentName: 'agentName', createdAt: 'createdAt' } });
fake(root + 'node_modules/drizzle-orm/index.cjs', { eq: (col, val) => ({ col, val }), and: (...a) => ({ and: a }), desc: x => x });

const said = {};
let failOn = null;
let doneAfter = 99;
fake(root + 'builder/services/mcpConversations.js', {
  startConversation: async ({ slug, version, startCrew }) => {
    if (slug === 'nope') { const e = new Error('No agent with slug "nope".'); e.status = 404; throw e; }
    const conversationId = 9000 + Object.keys(said).length; said[conversationId] = [];
    return { conversationId, agent: slug, version: version || 'active', crew: startCrew ? { id: 'c1', name: startCrew } : null };
  },
  sendMessage: async ({ conversationId, text }) => { if (text === failOn) throw new Error('the agent broke'); said[conversationId].push(text); return { reply: 'ok' }; },
  userReply: async ({ conversationId, model }) => { const n = said[conversationId].length + 1; return { text: `persona line ${n}`, done: n >= doneAfter, model: model || 'gpt-5.6-terra' }; },
  readState: async () => ({ crew: { id: 'c9', name: 'Closing' } }),
});

const jobs = require(root + 'builder/services/simulationJobs.js');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const settle = () => new Promise(r => setTimeout(r, 80));
const refused = async fn => { try { await fn(); return null; } catch (e) { return e.status || 500; } };

(async () => {
  check('no scenario → 400', await refused(() => jobs.releaseJob({ slug: 'a', by: 'Noa', body: {} })) === 400);
  check('persona AND lines → 400', await refused(() => jobs.releaseJob({ slug: 'a', by: 'Noa', body: { persona: 'x', lines: ['hi'] } })) === 400);
  check('unknown model → 400', await refused(() => jobs.releaseJob({ slug: 'a', by: 'Noa', body: { persona: 'x', model: 'zz' } })) === 400);
  check('unknown agent → 404, and no job is left behind', await refused(() => jobs.releaseJob({ slug: 'nope', by: 'Noa', body: { persona: 'x' } })) === 404 && rows.length === 0);

  // script job
  const s = await jobs.releaseJob({ slug: 'bank', by: 'Noa', body: { lines: ['hi', ' ', 'fees?'], version: 'published', fields: { age: 19 } } });
  check('release answers at once, as pending, with the conversation id', s.status === 'pending' && s.conversationId === 9000 && s.turns === 0, JSON.stringify({ status: s.status, conv: s.conversationId }));
  check('script setup recorded', s.kind === 'script' && s.lines.length === 2 && s.version === 'published' && s.by === 'Noa' && s.userModel === null && s.label === 'script, 2 lines', s.label);
  await settle();
  const sDone = await jobs.getJob(s.id);
  check('script job ran by itself to the end', sDone.status === 'completed' && sDone.turns === 2 && sDone.stopped === 'script finished' && sDone.endedInCrew === 'Closing', JSON.stringify({ st: sDone.status, turns: sDone.turns, stopped: sDone.stopped }));
  check('…sending the lines in order, blank ones dropped', JSON.stringify(said[9000]) === '["hi","fees?"]');

  // persona job, user finishes early
  doneAfter = 3;
  const p = await jobs.releaseJob({ slug: 'bank', by: 'Hila', body: { persona: 'Dana, 19', goal: 'fees', maxTurns: 10, model: 'gpt-5.6-luna', label: 'student' } });
  await settle();
  const pDone = await jobs.getJob(p.id);
  check('persona job stops when the user is done', pDone.status === 'completed' && pDone.turns === 3 && pDone.stopped === 'the user was done', JSON.stringify({ turns: pDone.turns, stopped: pDone.stopped }));
  check('persona setup + chosen model recorded', pDone.kind === 'persona' && pDone.userModel === 'gpt-5.6-luna' && pDone.label === 'student' && pDone.maxTurns === 10);

  // persona job, hits the turn limit; default model
  doneAfter = 99;
  const l = await jobs.releaseJob({ slug: 'bank', by: 'Hila', body: { persona: 'Avi', maxTurns: 4 } });
  await settle();
  const lDone = await jobs.getJob(l.id);
  check('persona job stops at the turn limit', lDone.turns === 4 && lDone.stopped === 'turn limit (4)', lDone.stopped);
  check('default user model is the everyday model', lDone.userModel === 'gpt-5.6-terra', lDone.userModel);
  const capped = await jobs.releaseJob({ slug: 'bank', by: 'Hila', body: { persona: 'Cap', maxTurns: 500 } });
  check('turn limit is capped at 30', capped.maxTurns === 30, String(capped.maxTurns));
  await settle(); await settle();

  // failure
  failOn = 'boom';
  const f = await jobs.releaseJob({ slug: 'bank', by: 'Noa', body: { lines: ['one', 'boom', 'three'] } });
  await settle();
  const fDone = await jobs.getJob(f.id);
  check('a failing turn marks the job failed with the reason, keeping the turns done', fDone.status === 'failed' && fDone.turns === 1 && /agent broke/.test(fDone.error) && /error/.test(fDone.stopped), JSON.stringify({ st: fDone.status, turns: fDone.turns, err: fDone.error }));
  failOn = null;

  // interrupted
  rows.push({ id: nextId++, type: 'simulation', agentName: 'bank', status: 'running', input: { persona: 'ghost', by: 'Noa', conversationId: 1 }, output: { turns: 2 }, error: null, createdAt: new Date(Date.now() - 3600e3), updatedAt: new Date(Date.now() - jobs.STALE_MS - 1000) });
  const ghostId = nextId - 1;
  rows.push({ id: nextId++, type: 'simulation', agentName: 'bank', status: 'running', input: { persona: 'alive', by: 'Noa', conversationId: 2 }, output: { turns: 1 }, error: null, createdAt: new Date(), updatedAt: new Date() });
  const aliveId = nextId - 1;
  const g = await jobs.getJob(ghostId);
  check('a running job with no heartbeat is reported as interrupted, turns kept', g.status === 'interrupted' && g.turns === 2 && !!g.error);
  check('…and that is saved', rows.find(r => r.id === ghostId).status === 'interrupted');
  check('a running job with a fresh heartbeat stays running', (await jobs.getJob(aliveId)).status === 'running');

  // list
  rows.push({ id: nextId++, type: 'individuals', agentName: 'bank', status: 'completed', input: {}, output: {}, error: null, createdAt: new Date(), updatedAt: new Date() });
  const otherKindId = nextId - 1;
  rows.push({ id: nextId++, type: 'simulation', agentName: 'other-agent', status: 'completed', input: { persona: 'x' }, output: {}, error: null, createdAt: new Date(), updatedAt: new Date() });
  const list = await jobs.listJobs({ slug: 'bank' });
  check('list holds only this agent\'s simulations, not other agents or other test-run kinds', list.length === 7 && list.every(j => j.agent === 'bank'), String(list.length));
  check('unknown job → 404', await refused(() => jobs.getJob(99999)) === 404);
  check('a non-simulation test run is not readable as a simulation', await refused(() => jobs.getJob(otherKindId)) === 404);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
