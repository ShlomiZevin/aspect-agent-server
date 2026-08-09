/**
 * Fast, offline, deterministic regression tests for the pure (no DB, no LLM,
 * no network) logic in insights/services/investigation.service.js —
 * complements scripts/test-insights-battery.js, which exercises the real
 * live pipeline end to end but is slow (30-100s per prompt, needs a running
 * server + real DB). These run in milliseconds and exist specifically to
 * lock in the real bugs found and fixed on 2026-08-07 so they can't
 * silently regress:
 *   1. detectSuspiciousResult missed a same-non-zero-value-everywhere column
 *      (only caught all-zero originally).
 *   2. detectSuspiciousResult false-positived on legitimate benchmark/
 *      percentile columns that are SUPPOSED to be identical on every row.
 *   3. toTrackedMetric's isRanking heuristic misclassified a genuine
 *      multi-month time trend as a "ranked snapshot".
 *   4. reconcileImpactValue: impactValue disagreeing with the sum/average of
 *      a block's own listed items — the single most common real failure
 *      the live battery caught VERIFY rejecting, now fixed with code
 *      arithmetic instead of hoping the model's retry gets it right.
 *
 * Usage: node scripts/test-insights-unit.js
 */

const { detectSuspiciousResult, looksLikeTimeSeries, reconcileImpactValue } = require('../insights/services/investigation.service');

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

console.log('\nreconcileImpactValue ────────────────────────────────────');

function rankedListInsight(impactValue, values) {
  return { impactValue, blocks: [{ type: 'ranked_list', items: values.map((v, i) => ({ label: `item${i}`, value: v, pct: 100 })) }] };
}

// The real bug shape caught by the live battery: "N stores... ₪X total"
// where X disagrees with what the individually-listed items actually sum
// to. Sign kept consistent on both sides (claimed AND items negative) —
// a sign DISAGREEMENT is deliberately treated as a different, more
// serious error and left untouched (see the dedicated test below).
check(
  'sum mismatch beyond rounding gets corrected to the real code-computed sum',
  reconcileImpactValue(rankedListInsight('-₪10.9M / mo', Array(20).fill('-₪500K'))).impactValue,
  '-₪10M / mo' // 20 * 500K = 10,000,000 -> "10M", original "-₪" prefix and "/ mo" suffix untouched
);

// The other real shape from the battery: an AVERAGE across items, not a
// sum ("Avg revenue of ₪X for N cashiers" not matching the real average).
// None of the raw items is within 5% of the claimed ₪95 — otherwise the
// matchesSingleItem guard below would (correctly) refuse to touch it.
check(
  'average mismatch beyond rounding gets corrected to the real code-computed average',
  reconcileImpactValue(rankedListInsight('₪95', ['70', '75', '80', '85', '78', '72', '80', '86.09'])).impactValue,
  '₪78.26' // real average of those 8 values (626.09 / 8), corrected in place — currency symbol preserved untouched
);

// REAL BUG caught live in prod the same day: impactValue naming ONE item's
// own value (the #1/top-ranked family in a "steepest decline" ranking,
// with the rest of the list shown as context/runners-up) must NOT be
// treated as "a total across every item" — summing the whole list
// overwrote an already-correct -9.89pp with a meaningless -15.44pp.
check(
  'impactValue matching a single ranked item (not a sum) is left completely alone',
  reconcileImpactValue(rankedListInsight('-9.89pp', ['-9.89pp', '-7.2pp', '-6.1pp', '-4.8pp', '-3.05pp'])).impactValue,
  '-9.89pp'
);

// Normal rounding (< 2% off) must NOT be "corrected" into a different-looking number.
check(
  'small rounding difference is left alone',
  reconcileImpactValue(rankedListInsight('₪293', ['₪150', '₪142.75'])).impactValue, // sum = 292.75, claim 293 is <1% off
  '₪293'
);

// A number that isn't plausibly the same figure (way off, both directions)
// is left for VERIFY, not guessed at. Also the specific regression case for
// a real bug found while building this: a one-sided relative-error check
// (|claimed-x|/|x|) is mathematically bounded below 1.0 as claimed shrinks
// toward 0, so "₪2" against ₪1M-scale items used to slip through a
// "reject if err > 1" cutoff and get "corrected" into ₪500K. A ratio check
// (|claimed|/|x|) has no such blind spot in either direction.
check(
  'wildly unrelated (much smaller) number is left alone, not force-corrected',
  reconcileImpactValue(rankedListInsight('₪2', ['₪500K', '₪500K'])).impactValue,
  '₪2'
);

// A genuine sign disagreement (claimed negative, items positive) is a
// different, more serious kind of error than a magnitude slip — must be
// left for VERIFY to judge, never spliced (risk of a double sign like
// "-₪-10M" if this guard were missing).
check(
  'sign disagreement between claim and items is left alone',
  reconcileImpactValue(rankedListInsight('-₪10.9M / mo', Array(20).fill('₪500K'))).impactValue,
  '-₪10.9M / mo'
);

// No ranked_list/comparison block at all -> nothing to reconcile against, untouched.
check(
  'insight with no itemized block is untouched',
  reconcileImpactValue({ impactValue: '₪999K', blocks: [{ type: 'stat_callout', value: '₪999K' }] }).impactValue,
  '₪999K'
);

console.log(`\n════════ ${pass}/${pass + fail} PASS ════════`);
process.exit(fail ? 1 : 0);
