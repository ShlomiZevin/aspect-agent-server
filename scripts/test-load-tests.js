#!/usr/bin/env node
/**
 * Load tests (task #902) — offline battery. No database, no model, no spend.
 *
 *   node scripts/test-load-tests.js
 *
 * The database and the simulation jobs are faked; the load-test logic is
 * real: limits, the cost estimate, the $20 cap (refused before it starts,
 * and the stop while it runs), a manual stop, the verdict.
 */

const path = require('path');
const root = path.join(__dirname, '..') + '/';
const fake = (file, exp) => { require.cache[require.resolve(file)] = { id: file, filename: file, loaded: true, exports: exp }; };

// ── Fake database ────────────────────────────────────────────────────
const rows = [];
let nextId = 1;
let usageRows = [];          // what llm_usage "holds" for the estimate / spend
let historyTurns = 0;        // user messages behind usageRows
const match = (r, c) => (!c ? true : c.and ? c.and.every(x => match(r, x)) : r[c.col] === c.val);
const drizzle = () => ({
  insert: () => ({ values: v => ({ returning: async () => { const r = { id: nextId++, error: null, createdAt: new Date(), updatedAt: new Date(), ...v }; rows.push(r); return [{ ...r }]; } }) }),
  update: () => ({ set: p => ({ where: c => { const hit = rows.filter(r => match(r, c)); hit.forEach(r => Object.assign(r, p)); const out = hit.map(r => ({ ...r })); return Object.assign(Promise.resolve(out), { returning: async () => out }); } }) }),
  select: () => ({ from: () => ({ where: c => { const hit = rows.filter(r => match(r, c)).map(r => ({ ...r })); return { limit: async () => hit, orderBy: () => ({ limit: async () => [...hit].sort((a, b) => b.id - a.id) }) }; } }) }),
});
fake(root + 'services/db.pg.js', {
  getDrizzle: drizzle,
  pool: { totalCount: 3, idleCount: 1, waitingCount: 0, options: { max: 5 } },
  query: async (sql) => {
    if (/WITH conv AS/.test(sql)) return { rows: usageRows.map(u => ({ ...u, turns: historyTurns })) };
    if (/conversation_id = ANY/.test(sql)) return { rows: usageRows };
    return { rows: [] };
  },
});
fake(root + 'db/schema/index.js', { testRuns: { id: 'id', type: 'type', agentName: 'agentName', createdAt: 'createdAt', status: 'status' } });
fake(root + 'node_modules/drizzle-orm/index.cjs', { eq: (col, val) => ({ col, val }), and: (...a) => ({ and: a }), desc: x => x });

// ── Fake simulation jobs ─────────────────────────────────────────────
let gate = null;
const jobs = new Map();
fake(root + 'builder/services/simulationJobs.js', {
  STALE_MS: 10 * 60 * 1000,
  setTurnGate: fn => { gate = fn; },
  timingSummary: t => (t.filter(x => x.ok).length ? { turns: t.filter(x => x.ok).length, medianMs: 1000, p95Ms: 1000, maxMs: 1000 } : null),
  listChildJobs: async runId => [...jobs.values()].filter(j => j.loadTestId === runId),
  releaseJob: async ({ parentRunId }) => { const j = { id: 1000 + jobs.size, loadTestId: parentRunId, status: 'pending', turns: 0, timings: [], conversationId: 5000 + jobs.size, createdAt: new Date(), updatedAt: new Date() }; jobs.set(j.id, j); return j; },
  startJob: id => { const j = jobs.get(id); j.status = 'completed'; j.turns = 5; j.finishedAt = new Date().toISOString(); },
  getJob: async id => jobs.get(id),
});

const loadTests = require(root + 'builder/services/loadTests.js');
const { readSetup, verdictOf, costOfUsage } = loadTests._internal;

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };
const refused = async fn => { try { await fn(); return null; } catch (e) { return e.status || 500; } };
const base = 'https://lybi.example';

(async () => {
  // ── limits ──
  check('21 conversations → refused', await refused(() => readSetup({ conversations: 21 })) === 400);
  check('0 conversations → refused', await refused(() => readSetup({ conversations: 0 })) === 400);
  check('11 script lines → refused (10 turns max)', await refused(() => readSetup({ conversations: 2, lines: Array(11).fill('x') })) === 400);
  check('persona with 11 turns → refused', await refused(() => readSetup({ conversations: 2, persona: 'p', turns: 11 })) === 400);
  const d = readSetup({});
  check('defaults: 10 at once, fixed script of 5, together, baseline first', d.conversations === 10 && d.kind === 'script' && d.turns === 5 && d.start === 'together' && d.baseline === true);
  check('one conversation alone has no separate baseline', readSetup({ conversations: 1 }).baseline === false);
  check('"ramp" is kept; anything else starts together', readSetup({ start: 'ramp' }).start === 'ramp' && readSetup({ start: 'x' }).start === 'together');

  // ── prices ──
  // A made-up id, so the test never depends on which real models have a
  // price. Unpriced = counted at the dearest known rate (today Claude
  // Fable 5.1 / GPT-6 Astra, $10 in / $50 out per 1M).
  const UNPRICED = 'zz-unpriced-model';
  const c = costOfUsage([{ model: 'claude-haiku-4-5', inputTokens: 1e6, outputTokens: 0 }, { model: UNPRICED, inputTokens: 1e6, outputTokens: 0 }]);
  check('a priced model costs its list price; an unpriced one the top rate (errs high)', c.usd === 11 && c.unpriced.includes(UNPRICED), JSON.stringify(c));

  // ── estimate ──
  usageRows = []; historyTurns = 0;
  const e0 = await loadTests.estimate({ slug: 'a', body: { conversations: 2, lines: ['a', 'b'] } });
  check('no history → a stated, generous assumption per turn', e0.perTurnUsd === 0.05 && /no usage history/.test(e0.basis) && e0.agentTurns === 6, JSON.stringify(e0));
  usageRows = [{ model: UNPRICED, inputTokens: 1e6, outputTokens: 0 }]; historyTurns = 10; // $10 / 10 turns = $1 a turn
  const e1 = await loadTests.estimate({ slug: 'a', body: { conversations: 10 } });
  check('10 × 5 turns + baseline at $1 a turn → $55, over the cap', e1.usd === 55 && e1.overCap === true, JSON.stringify({ usd: e1.usd, over: e1.overCap }));

  // ── refused before it starts ──
  const before = rows.length;
  const st = await refused(() => loadTests.releaseRun({ slug: 'a', by: 'Noa', body: { conversations: 10 }, publicBase: base }));
  check('over the cap → refused, and nothing is created', st === 400 && rows.length === before);
  check('no public address → refused', await refused(() => loadTests.releaseRun({ slug: 'a', by: 'Noa', body: { conversations: 1 }, publicBase: null })) === 400);

  // ── a run that fits, then the cap while running ──
  usageRows = [{ model: UNPRICED, inputTokens: 1000, outputTokens: 0 }]; historyTurns = 10;
  const run = await loadTests.releaseRun({ slug: 'a', by: 'Noa', body: { conversations: 2, lines: ['a'] }, publicBase: base });
  check('a run under the cap is released', run.status === 'running' && run.estimate && !run.estimate.overCap);
  check('the gate lets turns go while under the cap', await gate(run.id) === null);
  usageRows = [{ model: UNPRICED, inputTokens: 4e6, outputTokens: 1e6 }]; // $40 + $50 at the top rate
  await new Promise(r => setTimeout(r, 2100)); // past the gate's 2 s cache
  const why = await gate(run.id);
  check('…and stops every conversation once the real spend reaches the cap', /cost cap/.test(why || ''), why);

  // ── manual stop ──
  usageRows = [];
  const run2 = await loadTests.releaseRun({ slug: 'a', by: 'Noa', body: { conversations: 2, lines: ['a'] }, publicBase: base });
  await loadTests.stopRun(run2.id, 'Hila');
  check('Stop → the gate says who stopped it', /stopped by Hila/.test((await gate(run2.id)) || ''));

  // ── verdict ──
  check('verdict: slower', verdictOf({ conversations: 10, baseline: { timing: { medianMs: 5000 } }, load: { timing: { medianMs: 9000 }, errors: 0 } }) === '10 at once: turns 1.8× slower, no errors');
  check('verdict: as fast, with errors', verdictOf({ conversations: 5, baseline: { timing: { medianMs: 5000 } }, load: { timing: { medianMs: 5200 }, errors: 2 } }) === '5 at once: turns as fast as one alone, 2 errors');
  check('verdict: every turn failed', verdictOf({ conversations: 3, baseline: null, load: { timing: null, errors: 3 } }) === '3 at once: every turn failed');

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
