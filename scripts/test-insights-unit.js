/**
 * Fast, offline, deterministic regression tests for the pure (no DB, no LLM,
 * no network) logic in insights/services/investigation.service.js —
 * complements scripts/test-insights-battery.js, which exercises the real
 * live pipeline end to end but is slow (30-100s per prompt, needs a running
 * server + real DB). These run in milliseconds and exist specifically to
 * lock in the three real bugs found and fixed on 2026-08-07 so they can't
 * silently regress:
 *   1. detectSuspiciousResult missed a same-non-zero-value-everywhere column
 *      (only caught all-zero originally).
 *   2. detectSuspiciousResult false-positived on legitimate benchmark/
 *      percentile columns that are SUPPOSED to be identical on every row.
 *   3. toTrackedMetric's isRanking heuristic misclassified a genuine
 *      multi-month time trend as a "ranked snapshot".
 *
 * Usage: node scripts/test-insights-unit.js
 */

const { detectSuspiciousResult, looksLikeTimeSeries } = require('../insights/services/investigation.service');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`); }
}

console.log('detectSuspiciousResult ─────────────────────────────────');

// The original bug: every row pinned to exactly 0.
check(
  'all-zero column across 3+ rows is flagged',
  detectSuspiciousResult([{ store: 'a', attainment: 0 }, { store: 'b', attainment: 0 }, { store: 'c', attainment: 0 }]),
  { flagged: true, reason: 'all-zero', columns: ['attainment'] }
);

// Bug #1 (found 2026-08-07): every row pinned to the same NON-zero value.
check(
  'all-same-nonzero-value column across 3+ rows is flagged',
  detectSuspiciousResult([{ family: 'a', inventory: -16413 }, { family: 'b', inventory: -16413 }, { family: 'c', inventory: -16413 }]),
  { flagged: true, reason: 'all-same-value', columns: ['inventory'] }
);

// Bug #2 (found 2026-08-07, same day): a legitimately-constant percentile/
// average/threshold column (CROSS JOIN to a single-row CTE) must NOT be
// flagged just because it's identical everywhere — that's how it's
// supposed to look.
check(
  'benchmark/threshold-named column is NOT flagged even though identical everywhere',
  detectSuspiciousResult([
    { family: 'a', revenue: 1000, revenue_p75_threshold: 500 },
    { family: 'b', revenue: 2000, revenue_p75_threshold: 500 },
    { family: 'c', revenue: 3000, revenue_p75_threshold: 500 },
  ]),
  { flagged: false, reason: null, columns: [] }
);

// The check this whole function exists for must still fire on "target" —
// a real per-store target column pinned to the same value on every row IS
// a real bug, and "target" deliberately does NOT match the benchmark-name
// exclusion regex.
check(
  'a genuine "target" column pinned to one value is STILL flagged (not excluded like benchmarks)',
  detectSuspiciousResult([{ store: 'a', target_attainment_pct: 0 }, { store: 'b', target_attainment_pct: 0 }, { store: 'c', target_attainment_pct: 0 }]),
  { flagged: true, reason: 'all-zero', columns: ['target_attainment_pct'] }
);

// Real, varying business data must never be flagged.
check(
  'genuinely varying data is not flagged',
  detectSuspiciousResult([{ store: 'a', revenue: 1200 }, { store: 'b', revenue: 3400 }, { store: 'c', revenue: 800 }]),
  { flagged: false, reason: null, columns: [] }
);

// Fewer than 3 rows: too little evidence either way, deliberately not flagged.
check(
  '< 3 rows is never flagged regardless of values',
  detectSuspiciousResult([{ store: 'a', revenue: 0 }, { store: 'b', revenue: 0 }]),
  { flagged: false, reason: null, columns: [] }
);

// All-null (column genuinely unused) is a different, benign case — not "all zero".
check(
  'all-null column (not all-zero) is not flagged',
  detectSuspiciousResult([{ store: 'a', discount: null }, { store: 'b', discount: null }, { store: 'c', discount: null }]),
  { flagged: false, reason: null, columns: [] }
);

console.log('\nlooksLikeTimeSeries ─────────────────────────────────────');

// Bug #3 (found 2026-08-07): calendar categories must read as a time trend, not a ranking.
check('month abbreviations are a time series', looksLikeTimeSeries(['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul']), true);
check('quarters are a time series', looksLikeTimeSeries(['Q1', 'Q2', 'Q3', 'Q4']), true);
check('bare years are a time series', looksLikeTimeSeries(['2024', '2025', '2026']), true);
check('week labels are a time series', looksLikeTimeSeries(['Week 1', 'Week 2', 'Week 3']), true);
check('store/entity names are NOT a time series', looksLikeTimeSeries(['גן-שמואל', 'תל אביב', 'חיפה']), false);
check('product family names are NOT a time series', looksLikeTimeSeries(['Lego', 'Whiteboards', 'Pencil Cases']), false);
check('empty categories is NOT a time series', looksLikeTimeSeries([]), false);

console.log(`\n════════ ${pass}/${pass + fail} PASS ════════`);
process.exit(fail ? 1 : 0);
