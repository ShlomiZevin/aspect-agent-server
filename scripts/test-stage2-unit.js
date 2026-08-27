/**
 * Stage-2 offline unit battery — capability gate, vocabulary, annotations,
 * answer contract. No DB, no LLM: pure logic against the frozen customer
 * corpus plus canned fixtures from the documented historical failures.
 *
 * Covers verification tasks 2-V (gate behavior incl. the false-refusal sweep
 * over ALL 74 real customer questions) and the offline half of 3-V (entity /
 * scope / basis fixtures). Coverage-service behavior needs a live DB and is
 * exercised by the T1 probe instead.
 *
 * Usage: node scripts/test-stage2-unit.js       (exit 1 on any failure)
 */

const path = require('path');
const manifestSvc = require('../services/dataset-manifest');
const gate = require('../services/capability-gate.service');
const { DataQueryService } = require('../services/data-query.service');
const tableFormat = require('../services/table-format.service');

const corpus = require(path.join(__dirname, '..', 'verification', 'representative-dataset', 'customer-corpus.json'));
const manifest = manifestSvc.get('zolstock');

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

// ── 1. Gate: the absent-dimension questions MUST refuse, deterministically ──
console.log('\n1 · Gate refusals (absent dimensions)');
const MUST_REFUSE = {
  18167: 'retail customer', 18239: 'retail customer',
  18241: 'payment type', 18243: 'customer city / demographics / age',
  18251: 'customer city / demographics / age',
  18314: 'agent / seller', 18316: 'agent / seller',
  18546: 'agent / seller', 22669: 'agent / seller',
  24125: 'agent / seller', 24167: 'agent / seller',
  // 26-08 production session (the agent-sales incident): these two name the
  // absent seller dimension unambiguously — the gate MUST refuse them.
  24939: 'agent / seller', 24941: 'agent / seller',
};
const allTurns = corpus.conversations.flatMap(c => c.turns.map(t => ({ ...t, conv: c.origConv })));
for (const [mid, expectedDim] of Object.entries(MUST_REFUSE)) {
  const turn = allTurns.find(t => String(t.mid) === mid);
  if (!turn) { check(false, `mid ${mid} present in corpus`); continue; }
  const r = gate.check(turn.text, manifest);
  check(r.action === 'refuse' && r.refusal.dimension === expectedDim,
    `mid ${mid} refuses as "${expectedDim}"`,
    r.action === 'refuse' ? `refused as "${r.refusal.dimension}"` : 'proceeded');
}
// Determinism: same input, 3 runs, identical output.
{
  const q = allTurns.find(t => String(t.mid) === '18241').text;
  const runs = [1, 2, 3].map(() => JSON.stringify(gate.check(q, manifest)));
  check(runs[0] === runs[1] && runs[1] === runs[2], 'refusal is byte-identical across 3 runs');
}

// ── 2. Gate: EVERY other corpus question must proceed (false-refusal sweep) ──
console.log('\n2 · False-refusal sweep (all remaining corpus questions must proceed)');
const falseRefusals = [];
for (const t of allTurns) {
  if (MUST_REFUSE[String(t.mid)]) continue;
  const r = gate.check(t.text, manifest);
  if (r.action === 'refuse') falseRefusals.push(`mid ${t.mid} "${String(t.text).slice(0, 60)}" → refused as "${r.refusal.dimension}"`);
}
check(falseRefusals.length === 0,
  `0 false refusals across ${allTurns.length - Object.keys(MUST_REFUSE).length} proceed-questions`,
  falseRefusals.join(' | '));

// Questions that LOOK like gated topics but are answerable — must proceed:
console.log('\n3 · Near-miss questions stay open');
for (const q of [
  'Which suppliers have the most products in our catalog?',           // supplier = available
  'הזמנות לקוח פתוחות לפי מק"ט',                                      // customer ORDERS = available
  'What is the total of credits, refunds, and discounts?',            // no gated dimension named
  'sales by store city',                                              // store geography ≠ customer cities
]) {
  const r = gate.check(q, manifest);
  check(r.action === 'proceed', `proceeds: "${q.slice(0, 48)}"`, r.action === 'refuse' ? `refused as "${r.refusal?.dimension}"` : '');
}

// ── 4. Vocabulary detection ──
console.log('\n4 · Unresolved vocabulary');
{
  const t24183 = allTurns.find(t => String(t.mid) === '24183');
  const r = gate.check(t24183.text, manifest);
  check(r.unresolvedTerms.length >= 1, 'mid 24183 (מכירות כולל מעמ + P) detects unresolved terms',
    `found ${r.unresolvedTerms.length}`);
  const r2 = gate.check('מה סך המכירות כולל מעמ של קצרין אתמול', manifest);
  check(r2.unresolvedTerms.length === 1 && r2.action === 'proceed',
    'מכירות כולל מעמ detected but question still proceeds (annotation, not block)');
}

// ── 5. Annotation builder fixtures (the documented historical failures) ──
console.log('\n5 · Annotations (entity / scope / basis)');
const svc = Object.create(DataQueryService.prototype); // _buildAnnotations uses no instance state except this.pool (coverage skipped w/o targetsLatest)
(async () => {
  // D3: category question answered by item grouping (the R21 case)
  const a1 = await svc._buildAnnotations({
    manifest, question: 'אילו קטגוריות מוצרים מניבות את הרווח הגבוה ביותר?',
    sql: 'SELECT item_name, SUM(profit_list_ex_vat) FROM zolstock.mv_sales_monthly_item GROUP BY item_name ORDER BY 2 DESC',
    dataThroughDate: '2026-08-19', unresolvedTerms: [],
  });
  check(!!a1?.entityMismatch, 'D3 fixture: category question grouped by item flags entityMismatch');
  check(!!a1?.basis, 'D3 fixture: profit_list SQL carries basis annotation');

  // Correct grouping must NOT flag:
  const a2 = await svc._buildAnnotations({
    manifest, question: 'רווח לפי קטגוריה',
    sql: 'SELECT category, SUM(profit_list_ex_vat) FROM zolstock.mv_sales_monthly_category GROUP BY category',
    dataThroughDate: '2026-08-19', unresolvedTerms: [],
  });
  check(!a2?.entityMismatch, 'correct category grouping does not flag entityMismatch');

  // D4: unscoped question, date-filtered SQL (the R23 case)
  const a3 = await svc._buildAnnotations({
    manifest, question: 'מהו הרווח הגולמי הכולל שלנו?',
    sql: "SELECT SUM(profit_list_ex_vat) FROM zolstock.mv_sales_daily WHERE row_date >= '2026-05-01' AND row_date < '2026-06-01'",
    dataThroughDate: '2026-08-19', unresolvedTerms: [],
  });
  check(!!a3?.scopeAdded, 'D4 fixture: unscoped question + date filter flags scopeAdded');

  // Explicit period must NOT flag:
  const a4 = await svc._buildAnnotations({
    manifest, question: 'מה הרווח במאי 2026?',
    sql: "SELECT SUM(profit_list_ex_vat) FROM zolstock.mv_sales_daily WHERE row_date >= '2026-05-01' AND row_date < '2026-06-01'",
    dataThroughDate: '2026-08-19', unresolvedTerms: [],
  });
  check(!a4?.scopeAdded, 'explicit period does not flag scopeAdded');

  // Units-only SQL carries no basis annotation:
  const a5 = await svc._buildAnnotations({
    manifest, question: 'כמה יחידות נמכרו השנה?',
    sql: "SELECT SUM(total_qty) FROM zolstock.mv_sales_daily WHERE row_date >= '2026-01-01'",
    dataThroughDate: '2026-08-19', unresolvedTerms: [],
  });
  check(!a5?.basis, 'units-only SQL carries no basis annotation');

  // ── 6. Answer contract rendering ──
  console.log('\n6 · Answer contract (table-format)');
  const refusedOut = tableFormat.buildFetchResult({
    question: 'top sellers', tableTitle: null, schema: 'zolstock',
    result: { refused: true, refusal: manifest.refusals['agent / seller'] === undefined ? null : { dimension: 'agent / seller', ...manifest.refusals['agent / seller'] }, data: [], rowCount: 0 },
  });
  check(refusedOut.refused === true && /CANNOT ANSWER/.test(refusedOut.summary) && /Do NOT attempt another data fetch/.test(refusedOut.summary),
    'refusal renders as structured CANNOT ANSWER instruction');

  const annotatedOut = tableFormat.buildFetchResult({
    question: 'revenue by store', tableTitle: null, schema: 'zolstock',
    result: {
      data: [{ store: 'A', revenue_list_ex_vat: 100 }], rowCount: 1, columns: ['store', 'revenue_list_ex_vat'],
      sql: 'SELECT ...', explanation: '', confidence: 90,
      annotations: {
        basis: { fidelity: 'estimate', detail: 'list price × qty', knownDelta: '+2.8% YTD' },
        partialLastDay: { date: '2026-08-19', volume: 100, medianVolume: 70000, pctOfNormal: 27 },
      },
    },
  });
  check(/DATA CONTRACT/.test(annotatedOut.summary) && /ESTIMATES/.test(annotatedOut.summary) && /PARTIAL/.test(annotatedOut.summary),
    'annotations render into the DATA CONTRACT block');

  const plainOut = tableFormat.buildFetchResult({
    question: 'q', tableTitle: null, schema: 'zer4u',
    result: { data: [{ a: 1 }], rowCount: 1, columns: ['a'], sql: 's', explanation: '', confidence: 90 },
  });
  check(!/DATA CONTRACT/.test(plainOut.summary), 'no annotations (other datasets) → output unchanged');

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
})();
