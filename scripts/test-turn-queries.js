#!/usr/bin/env node
/**
 * Fewer database queries per turn (task #914) — offline battery.
 * No database, no model. The database is faked; what is checked is the
 * per-turn history memo (builder/runtime/historyService.js):
 *   - every history mode returns exactly what an uncached read returns
 *   - one query per (conversation, cutoff) per turn phase, not one per add-on
 *   - a new Map (the runner's reset after writing the reply) reads again
 *   - a different cutoff (a transition / summarizer watermark) reads again
 *   - a failed read is retried by the next caller, and still throws for this one
 *   - a Drizzle query that re-runs on every `.then` is executed once
 *
 *   node scripts/test-turn-queries.js
 *
 * The end-to-end proof (real conversations, record/replay, identical output) is
 * in verification/db-queries/README.md.
 */
const path = require('path');

// ── Fake database ───────────────────────────────────────────────────
const ROWS = [
  { id: 10, role: 'user', content: 'a' },
  { id: 11, role: 'assistant', content: 'b' },
  { id: 12, role: 'user', content: 'c' },
  { id: 13, role: 'assistant', content: 'd' },
  { id: 14, role: 'user', content: 'e' },
];
let executions = 0;
let failNext = false;
/** Like Drizzle: a builder whose `.then` RUNS the query, every time it's called. */
function query(resultFn) {
  const q = {
    from: () => q, where: () => q, orderBy: () => q, limit: () => q,
    then(res, rej) {
      executions++;
      if (failNext) { failNext = false; return Promise.reject(new Error('db down')).then(res, rej); }
      return Promise.resolve(resultFn()).then(res, rej);
    },
  };
  return q;
}
// Every read returns the same rows — the memo is under test, not the SQL filters.
const fakeDrizzle = { select: () => query(() => ROWS) };
const dbPath = require.resolve(path.join(__dirname, '..', 'services', 'db.pg'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDrizzle: () => fakeDrizzle } };

const historyService = require('../builder/runtime/historyService');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const modes = [
    { mode: 'none' },
    { mode: 'all' },
    { mode: 'full' },
    { mode: 'last_n', n: 2 },
    { mode: 'last_n', n: 0 },
    { mode: 'since_summarizer', summarizerName: 'sum' },
    { mode: 'since_summarizer', summarizerName: 'missing' },
    { mode: 'nonsense' },
  ];
  const brain = { summary: { sum: { watermark: 11 } } };

  console.log('every mode: cached answer = uncached answer');
  for (const hm of modes) {
    const plain = await historyService.loadHistory({ conversationId: 1, historyMode: hm, brain, excludeFromMessageId: 15 });
    const cached = await historyService.loadHistory({ conversationId: 1, historyMode: hm, brain, excludeFromMessageId: 15, cache: new Map() });
    check(`${hm.mode}${hm.n !== undefined ? ` n=${hm.n}` : ''}${hm.summarizerName ? ` ${hm.summarizerName}` : ''}`, same(plain, cached));
  }

  console.log('one read per turn phase');
  executions = 0;
  const cache = new Map();
  const results = await Promise.all([1, 2, 3, 4].map(() =>
    historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'all' }, brain, excludeFromMessageId: 15, cache })));
  check('4 parallel add-ons → 1 query', executions === 1, `(got ${executions})`);
  check('all 4 got the same messages', results.every(r => same(r, results[0])));
  await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'last_n', n: 2 }, brain, excludeFromMessageId: 15, cache });
  check('last_n after all, same cutoff → still 1 query', executions === 1, `(got ${executions})`);
  results[0].messages.push({ role: 'user', content: 'mutated by a caller' });
  const again = await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'all' }, brain, excludeFromMessageId: 15, cache });
  check('a caller changing its list does not change the next caller\'s', again.messages.length === ROWS.length);

  console.log('reads again when it must');
  executions = 0;
  await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'all' }, brain, excludeFromMessageId: undefined, cache });
  check('a different cutoff (offline phase) → new query', executions === 1, `(got ${executions})`);
  await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'all' }, brain, excludeFromMessageId: 15, cache: new Map() });
  check('a new Map (reply was written) → new query', executions === 2, `(got ${executions})`);
  await historyService.loadHistory({ conversationId: 2, historyMode: { mode: 'all' }, brain, excludeFromMessageId: 15, cache });
  check('another conversation → new query', executions === 3, `(got ${executions})`);
  const c2 = new Map();
  await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'since_summarizer', summarizerName: 'sum' }, brain, excludeFromMessageId: 15, cache: c2 });
  await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'since_summarizer', summarizerName: 'sum' }, brain: { summary: { sum: { watermark: 13 } } }, excludeFromMessageId: 15, cache: c2 });
  check('a moved watermark → new query', executions === 5, `(got ${executions})`);

  console.log('failures');
  executions = 0;
  const c3 = new Map();
  failNext = true;
  let threw = false;
  try { await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'all' }, brain, excludeFromMessageId: 15, cache: c3 }); } catch { threw = true; }
  check('a failed read still fails for its caller', threw);
  const after = await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'all' }, brain, excludeFromMessageId: 15, cache: c3 });
  check('the next caller reads again and succeeds', after.messages.length === ROWS.length && executions === 2, `(executions ${executions})`);

  console.log('no cache passed = the old behaviour');
  executions = 0;
  await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'all' }, brain, excludeFromMessageId: 15 });
  await historyService.loadHistory({ conversationId: 1, historyMode: { mode: 'all' }, brain, excludeFromMessageId: 15 });
  check('two calls → two queries', executions === 2, `(got ${executions})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
