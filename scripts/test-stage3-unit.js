/**
 * Stage-3 offline unit battery — asked-beyond-data, validated suggestions,
 * unconditional data-through, crew discipline block, freshness assertion,
 * contract rendering. No DB, no LLM.
 *
 * Companion to test-stage2-unit.js (which must stay green — run both).
 * Usage: node scripts/test-stage3-unit.js       (exit 1 on any failure)
 */

const manifestSvc = require('../services/dataset-manifest');
const { DataQueryService } = require('../services/data-query.service');
const tableFormat = require('../services/table-format.service');
const freshness = require('../services/reload-freshness.service');
const CrewMember = require('../crew/base/CrewMember');

const manifest = manifestSvc.get('zolstock');
const svc = Object.create(DataQueryService.prototype);

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const DT = '2026-08-21'; // pretend data-through

  // ── 1. askedBeyondData (A1) ──
  console.log('\n1 · askedBeyondData');
  const ann = (q, sql = "SELECT SUM(revenue_list_ex_vat) FROM zolstock.mv_sales_daily WHERE row_date >= '2026-08-01'") =>
    svc._buildAnnotations({ manifest, question: q, sql, dataThroughDate: DT, unresolvedTerms: [] });

  let a = await ann('מה הרווח היום?');
  check(!!a?.askedBeyondData, 'היום beyond data flags', JSON.stringify(a?.askedBeyondData));
  check(Array.isArray(a?.suggestedRequests) && a.suggestedRequests.length === 2, 'suggestions attached (2)');
  a = await ann('What was the profit today?');
  check(!!a?.askedBeyondData, 'EN today flags');
  a = await ann('נתוני מכירות של 25.8.2026');
  check(a?.askedBeyondData?.asked === '2026-08-25', 'explicit dd.mm.yyyy beyond data flags with parsed date');
  a = await ann('מה הרווח במאי 2026?');
  check(!a?.askedBeyondData, 'past month does not flag');
  a = await ann('מכירות 15.7.2026');
  check(!a?.askedBeyondData, 'explicit past date does not flag');
  a = await ann('סה"כ רווח מתחילת השנה');
  check(!a?.askedBeyondData, 'YTD does not flag');

  // ── 2. Validated suggestions (A3) — property: never beyond data ──
  console.log('\n2 · suggestion validity');
  const cases = ['2026-08-21', '2026-08-31', '2026-01-01', '2026-12-31', '2025-06-04'];
  let allValid = true, monthOk = true;
  for (const dt of cases) {
    const s = svc._buildSuggestions(dt);
    if (s[0].date > dt) allValid = false;
    if (s[1].month > dt.slice(0, 7)) monthOk = false;
  }
  check(allValid, 'reanchor_date never exceeds data-through');
  check(monthOk, 'reanchor_month never exceeds data-through month');
  check(svc._buildSuggestions('2026-08-21')[1].month === '2026-07', 'mid-month → previous month suggested');
  check(svc._buildSuggestions('2026-08-31')[1].month === '2026-08', 'month-end → same month suggested');
  check(svc._buildSuggestions('2026-01-15')[1].month === '2025-12', 'january mid-month → december prior year');

  // ── 3. A4e: money answers always carry dataThrough ──
  console.log('\n3 · unconditional data-through on money answers');
  a = await ann('מה הרווח במאי 2026?', "SELECT SUM(profit_list_ex_vat) FROM zolstock.mv_sales_daily WHERE row_date >= '2026-05-01' AND row_date < '2026-06-01'");
  check(a?.dataThrough === DT, 'period-scoped money answer carries dataThrough');
  a = await ann('כמה יחידות נמכרו במאי?', "SELECT SUM(total_qty) FROM zolstock.mv_sales_daily WHERE row_date >= '2026-05-01'");
  check(!a?.dataThrough, 'units-only answer does not force dataThrough');

  // ── 4. Contract rendering ──
  console.log('\n4 · contract rendering');
  const out = tableFormat.buildFetchResult({
    question: 'q', tableTitle: null, schema: 'zolstock',
    result: {
      data: [], rowCount: 0, columns: [], sql: 's', explanation: '', confidence: 90,
      manifestActive: true,
      annotations: {
        askedBeyondData: { asked: 'today', dataThrough: DT },
        suggestedRequests: svc._buildSuggestions(DT),
      },
    },
  });
  check(/FIRST sentence must state plainly/.test(out.summary), 'askedBeyondData renders as first-line mandate');
  check(/guaranteed to have data/.test(out.summary) && out.summary.includes('2026-08-21'), 'suggestions render with real dates');
  check(/do NOT invent other suggestions/i.test(out.summary), 'suggestion exclusivity stated');
  check(/PRESENTATION: begin your reply with ONE direct sentence/.test(out.summary), 'answer-first line renders (manifest gate)');

  const plain = tableFormat.buildFetchResult({
    question: 'q', tableTitle: null, schema: 'zer4u',
    result: { data: [{ a: 1 }], rowCount: 1, columns: ['a'], sql: 's', explanation: '', confidence: 90 },
  });
  check(!/PRESENTATION:/.test(plain.summary) && !/DATA CONTRACT/.test(plain.summary),
    'no-manifest dataset output unchanged (byte-level gate)');

  const partial = tableFormat.buildFetchResult({
    question: 'q', tableTitle: null, schema: 'zolstock',
    result: {
      data: [{ a: 1 }], rowCount: 1, columns: ['a'], sql: 's', explanation: '', confidence: 90,
      annotations: { partialLastDay: { date: DT, volume: 100, medianVolume: 70000, pctOfNormal: 27 } },
    },
  });
  check(/NEVER use it silently in a trend/.test(partial.summary), 'partial-day comparison ban renders');

  // ── 5. Crew discipline block (A4a–d) ──
  console.log('\n5 · crew discipline block');
  const block = manifestSvc.renderForCrew(manifest);
  check(/ONE direct sentence/.test(block), 'answer-first in block');
  check(/NEVER arithmetically combine/.test(block), 'user-figure discipline in block');
  check(/VAT is 18%/.test(block) && block.includes('1.18'), 'VAT basis rule with rate');
  check(/top sellers/.test(block) && /clarifying question/.test(block), 'ambiguity entry renders');
  check(Math.ceil(block.length / 3.5) <= 500, `block within 500-token budget (~${Math.ceil(block.length / 3.5)})`);
  check(manifestSvc.renderForCrew(null) === '', 'null manifest renders empty');

  const crew = new CrewMember({ name: 'x', description: 'd', guidance: 'g', datasetSchema: 'zolstock' });
  const ctx = await crew.buildContext({ collectedData: {} });
  check(typeof ctx.dataDiscipline === 'string' && ctx.dataDiscipline.length > 100, 'buildContext injects dataDiscipline for zolstock');
  const crew2 = new CrewMember({ name: 'y', description: 'd', guidance: 'g' });
  const ctx2 = await crew2.buildContext({ collectedData: {} });
  check(ctx2.dataDiscipline === undefined, 'no datasetSchema → no injection');
  const crew3 = new CrewMember({ name: 'z', description: 'd', guidance: 'g', datasetSchema: 'zer4u' });
  const ctx3 = await crew3.buildContext({ collectedData: {} });
  check(ctx3.dataDiscipline === undefined, 'datasetSchema without manifest → no injection');

  // ── 6. Freshness assertion (mocked pools) ──
  console.log('\n6 · freshness assertion');
  const mkPool = (baseMax, viewMax) => ({
    query: async (sql) => {
      if (/FROM zolstock\.facts/.test(sql)) return { rows: [{ max_date: baseMax }] };
      if (/pg_matviews/.test(sql)) return { rows: [{ name: 'mv_sales_daily' }, { name: 'mv_sales_daily_store' }] };
      return { rows: [{ max_date: viewMax }] };
    },
  });
  let logs = [];
  const emit = (s, m) => logs.push(m);
  let r = await freshness.assertFreshness('zolstock', mkPool('2026-08-21', '2026-08-21'), emit);
  check(r?.ok === true && r.details.length === 2, 'matching dates → ok');
  r = await freshness.assertFreshness('zolstock', mkPool('2026-08-21', '2026-08-19'), emit);
  check(r?.ok === false, 'stale view → not ok');
  check(logs.some(m => /FRESHNESS MISMATCH/.test(m)), 'mismatch logged loudly');
  check(freshness.lastResult('zolstock')?.ok === false, 'lastResult surfaces for data-health');
  r = await freshness.assertFreshness('zer4u', mkPool('x', 'y'), emit);
  check(r === null, 'no manifest → silent skip');
  r = await freshness.assertFreshness('zolstock', { query: async () => { throw new Error('boom'); } }, emit);
  check(r === null, 'pool error → swallowed, never throws');

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('❌', e); process.exit(1); });
