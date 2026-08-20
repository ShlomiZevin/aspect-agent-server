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

// Bug #5 (found 2026-08-10, on the FIRST run after the result digest landed):
// a ranked_list is capped at 10 items, so on a result with more entities than
// that it is a LEADERBOARD, not a list of addends. Summing it overwrote a
// correct "₪5.0M attributed campaign revenue" (28 campaigns) with ₪3.72M, the
// sum of the 10 shown — i.e. the guard introduced the exact class of error it
// exists to prevent, for the second time. The digest knows the true entity
// count, so this is now decided from data rather than guessed.
check(
  'top-N excerpt of a larger population is NOT summed into impactValue',
  reconcileImpactValue(
    rankedListInsight('₪5.0M', Array(10).fill('₪372K')),
    { regrouped: true, distinctGroups: 28 }
  ).impactValue,
  '₪5.0M'
);
check(
  'block that IS the whole population still reconciles normally',
  reconcileImpactValue(
    rankedListInsight('₪5.0M', Array(10).fill('₪372K')),
    { regrouped: true, distinctGroups: 10 }
  ).impactValue,
  '₪3.72M'
);

// Bug #6 (found 2026-08-10 by scripts/test-insights-accuracy.js): a sparse
// annotation column — populated on a handful of rows by a LEFT JOIN to a
// LIMIT-1 CTE, NULL everywhere else — was flagged as "identical on every row"
// because the check dropped NULLs before comparing. That downgraded a good
// "steepest margin decline" insight to DATA QUALITY at confidence 35.
check(
  'sparse column (few non-null rows) is NOT flagged as all-same-value',
  detectSuspiciousResult([
    { family: 'a', margin: 12, decline_from_pct: null },
    { family: 'b', margin: 15, decline_from_pct: null },
    { family: 'c', margin: 11, decline_from_pct: null },
    { family: 'd', margin: 18, decline_from_pct: null },
    { family: 'e', margin: 14, decline_from_pct: 9.9 },
    { family: 'f', margin: 13, decline_from_pct: 9.9 },
    { family: 'g', margin: 17, decline_from_pct: 9.9 },
  ]),
  { flagged: false, reason: null, columns: [] }
);
// ...but a DENSE identical column is still the original bug, still caught.
check(
  'dense all-same-value column is still flagged',
  detectSuspiciousResult([
    { store: 'a', target: 5000 }, { store: 'b', target: 5000 },
    { store: 'c', target: 5000 }, { store: 'd', target: 5000 },
  ]),
  { flagged: true, reason: 'all-same-value', columns: ['target'] }
);
check(
  'sparse all-zero column is NOT flagged',
  detectSuspiciousResult([
    { store: 'a', gap: null }, { store: 'b', gap: null }, { store: 'c', gap: null },
    { store: 'd', gap: null }, { store: 'e', gap: 0 }, { store: 'f', gap: 0 }, { store: 'g', gap: 0 },
  ]),
  { flagged: false, reason: null, columns: [] }
);

console.log('\nbuildResultDigest ──────────────────────────────────────');

const { buildResultDigest, classifyColumns } = require('../insights/services/result-digest.service');

// THE campaign bug, in miniature: the SQL grouped by (campaign, threshold),
// so each campaign is spread over several rows and no single row is that
// campaign's total. Re-aggregating to the declared "campaign" grain must
// recover the true totals — A=300, B=30 — and rank A first, even though the
// single largest ROW belongs to B.
const grainRows = [
  { campaign_code: 'A', campaign_value_threshold: '50', revenue: '100' },
  { campaign_code: 'A', campaign_value_threshold: '60', revenue: '100' },
  { campaign_code: 'A', campaign_value_threshold: '70', revenue: '100' },
  { campaign_code: 'B', campaign_value_threshold: '80', revenue: '30' },
];
const grainDigest = buildResultDigest(grainRows, { dimensions: ['campaign'], measures: ['revenue'] });
check('digest re-aggregates to the declared grain', grainDigest.groupBy, ['campaign_code']);
check('digest recovers true per-entity totals', grainDigest.groups.map(g => [g.key, g.values.revenue]), [['A', 300], ['B', 30]]);
check('digest grand total spans every row', grainDigest.grandTotals.revenue, 330);
check('digest counts distinct entities, not rows', grainDigest.distinctGroups, 2);

// The finer grain column must be recognised as non-summable, not totalled —
// "₪3,068,664 campaign value" (the sum of every discount threshold) was a real
// first-draft output of this module.
check(
  'threshold/price/pct columns are never summed',
  Object.keys(grainDigest.grandTotals),
  ['revenue']
);

// Numeric-looking IDENTIFIERS must not become measures — summing store_id
// produces a plausible-looking, meaningless number.
check(
  'numeric id/code columns classify as dimensions, not measures',
  classifyColumns([{ store_id: '10', campaign_code: '193', revenue: '5' }]).measures,
  ['revenue']
);

// Conservative fallback: when no declared dimension maps to a real column,
// do NOT invent a grouping — grand totals stay correct and the caller is told
// per-item claims aren't supported.
const noMap = buildResultDigest([{ widget: 'x', revenue: '5' }, { widget: 'y', revenue: '7' }], { dimensions: ['store'], measures: ['revenue'] });
check('unmappable dimension does not invent a grouping', noMap.regrouped, false);
check('grand totals still correct when regrouping is skipped', noMap.grandTotals.revenue, 12);

check('empty result is reported as empty, not as zeros', buildResultDigest([], { dimensions: ['store'] }).empty, true);

// Bug #7 (found 2026-08-10 by the accuracy harness on "steepest margin
// decline"): the real entity column lost the mapping to a DERIVED annotation
// that merely happened to contain the same word and had lower cardinality —
// so family_description got summed away and steepest_decline_family became
// the grouping key. Scored now by unexplained words in the column name.
const annotationRows = Array.from({ length: 10 }, (_, i) => ({
  family_description: `fam${i % 5}`,
  steepest_decline_family: i < 8 ? null : 'fam4',
  revenue: '10',
}));
check(
  'real entity column beats a derived annotation sharing the same word',
  buildResultDigest(annotationRows, { dimensions: ['product family'], measures: ['revenue'] }).groupBy,
  ['family_description']
);

// The campaign case, re-asserted through the new scoring rather than the old
// cardinality-only tie-break.
check(
  'entity code column beats a finer-grained qualifier column',
  buildResultDigest(
    [
      { campaign_code: 'A', campaign_value_threshold: 'x', revenue: '1' },
      { campaign_code: 'A', campaign_value_threshold: 'y', revenue: '1' },
      { campaign_code: 'B', campaign_value_threshold: 'z', revenue: '1' },
    ],
    { dimensions: ['campaign'], measures: ['revenue'] }
  ).groupBy,
  ['campaign_code']
);

// A single-valued column is never a breakdown dimension.
check(
  'constant column is not chosen as a grouping key',
  buildResultDigest(
    [{ store_name: 'only', revenue: '1' }, { store_name: 'only', revenue: '2' }],
    { dimensions: ['store'], measures: ['revenue'] }
  ).regrouped,
  false
);

// ─────────────────────────────────────────────────────────────────────────────
// Partial-period coverage (services/period-coverage.service.js)
//
// The failure being guarded: chat reported a store "down 87%" comparing a full
// month against a 4-day one. Completeness is arithmetic, so it is tested here
// rather than trusted to a prompt.
// ─────────────────────────────────────────────────────────────────────────────
const coverage = require('../services/period-coverage.service');

check('June 4 is a partial month', coverage.trailingPartialPeriod('2026-06-04').daysCovered, 4);
check('June has 30 expected days', coverage.trailingPartialPeriod('2026-06-04').daysExpected, 30);
check('data ending on a month end is complete', coverage.trailingPartialPeriod('2026-05-31'), null);
check('Feb 28 in a non-leap year is complete', coverage.trailingPartialPeriod('2025-02-28'), null);
check('Feb 28 in a leap year is partial', coverage.trailingPartialPeriod('2024-02-28').daysExpected, 29);
check('unparseable date yields no period', coverage.trailingPartialPeriod('not-a-date'), null);
check(
  'coverage fires when the result touches the partial month',
  coverage.computeCoverage({ dataThroughDate: '2026-06-04', rows: [{ month: '2026-06', revenue: 1 }] }).partial,
  true
);
check(
  'coverage stays silent for an unrelated period',
  coverage.computeCoverage({ dataThroughDate: '2026-06-04', rows: [{ month: '2024-01', revenue: 1 }] }),
  null
);
check(
  'coverage stays silent when the month is complete',
  coverage.computeCoverage({ dataThroughDate: '2026-05-31', rows: [{ month: '2026-05', revenue: 1 }] }),
  null
);

// ─────────────────────────────────────────────────────────────────────────────
// Empty-result diagnosis parsing (services/empty-result-diagnosis.service.js)
//
// Only the SQL parsing is unit-tested here; the probes need a live catalog.
// ─────────────────────────────────────────────────────────────────────────────
const diag = require('../services/empty-result-diagnosis.service');
const DIAG_SQL = `SELECT f.item_number, SUM(f.inventory_qty) q
                    FROM zolstock.facts f JOIN zolstock.items i ON i.item_number = f.item_number
                   WHERE f.record_type = 'stock' AND f.transaction_date = DATE '2026-06-04'
                   GROUP BY 1 ORDER BY q DESC LIMIT 10`;

check('both relations are found', diag.relationsIn(DIAG_SQL).map(r => r.schema + '.' + r.table).sort(), ['zolstock.facts', 'zolstock.items']);
check('the table alias is captured', diag.relationsIn(DIAG_SQL).find(r => r.table === 'facts').aliases.has('f'), true);
check('filtered columns are extracted', diag.filteredColumns(DIAG_SQL).map(c => c.column).sort(), ['record_type', 'transaction_date']);
check('the literal equality defines the subset', diag.literalEqualities(DIAG_SQL).map(e => e.column + '=' + e.value), ['record_type=stock']);
check('GROUP BY / ORDER BY columns are not treated as filters', diag.filteredColumns('SELECT a FROM s.t GROUP BY a ORDER BY a').length, 0);
check('SQL keywords are never mistaken for columns', diag.filteredColumns("SELECT 1 FROM s.t WHERE x IS NOT NULL AND y = 'z'").map(c => c.column), ['y']);

console.log(`\n════════ ${pass}/${pass + fail} PASS ════════`);
process.exit(fail ? 1 : 0);
