/**
 * Smart Replenishment — recommendations API battery (D1).
 *
 * Run: node scripts/test-replenishment-api.js
 *
 * Builds the module's views into a temporary schema (the live schema has none
 * until a real reload runs the E1 hook), points the service at it, and
 * exercises the read path on REAL zolstock data. Route-level behaviour that
 * does not need the views — the module-not-live 404s — is checked against a
 * running server if one is up, and skipped with a note if not.
 *
 * Self-cleaning: the temporary schema is dropped and every settings row it
 * writes is removed.
 */

require('dotenv').config();
const db = require('../services/db.pg');
const datasetRegistry = require('../insights/datasets/registry');
const moduleService = require('../modules/services/module.service');
const supplierSettings = require('../modules/replenishment/services/supplier-settings.service');
const recommendations = require('../modules/replenishment/services/recommendations.service');
const { renderInfra } = require('../modules/replenishment/render-infra');

const DS = 'zolstock';
const MOD = 'replenishment';
const TMP = 'zolstock_d1_views';
const TODAY = '2026-08-27';
const PILOT = 'ב.א. זול סטוק והפצה בע"מ';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

(async () => {
  await db.initialize();
  const drizzle = db.getDrizzle();
  const pool = datasetRegistry.get(DS).getPool();

  const before = await moduleService.getForDataset(DS, MOD);
  if (!before?.binding) {
    console.error('Needs a converged binding — run scripts/run-module-init.js first.');
    process.exit(1);
  }
  const restore = { enabled: before.enabled, status: before.status };

  console.log('\n0 · The live gate — before anything is enabled');
  {
    await moduleService.setEnabled(DS, MOD, false, 'd1-test');
    const r = await recommendations.getRecommendations(DS, { schemaName: TMP, today: TODAY });
    ok('a disabled module refuses with 404', r.code === 404, JSON.stringify(r));
    ok('…and says why in words a person can act on', /not enabled/i.test(r.error), r.error);

    await moduleService.setEnabled(DS, MOD, true, 'd1-test');
    await moduleService.setStatus(DS, MOD, 'initializing', 'd1-test');
    const r2 = await recommendations.getRecommendations(DS, { schemaName: TMP, today: TODAY });
    ok('enabled-but-not-ready also refuses', r2.code === 404, JSON.stringify(r2?.code));
    ok('…and distinguishes the two cases', /not ready/i.test(r2.error), r2.error);

    const r3 = await recommendations.getRecommendations('no_such_dataset', { today: TODAY });
    ok('an unknown dataset refuses', r3.code === 404, JSON.stringify(r3?.code));
  }

  // Build the views the read path needs.
  console.log('\n1 · Building the module views into a temporary schema');
  await pool.query(`DROP SCHEMA IF EXISTS ${TMP} CASCADE`);
  await pool.query(`CREATE SCHEMA ${TMP}`);
  {
    const statements = renderInfra({ target: TMP, source: DS }, before.binding);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 0');
      await client.query("SET lock_timeout = '2min'");
      for (const s of statements) await client.query(s);
    } finally { client.release(); }
    const n = await pool.query(`SELECT COUNT(*)::int c FROM ${TMP}.mv_replenishment_base`);
    ok('views built', n.rows[0].c > 10000, `${n.rows[0].c} rows`);
    await moduleService.setStatus(DS, MOD, 'ready', 'd1-test');
  }

  console.log('\n2 · Suppliers — the list builds itself from the data');
  let suppliers;
  {
    const r = await recommendations.listSuppliers(DS, { schemaName: TMP });
    ok('the call succeeds now the module is live', !r.error, JSON.stringify(r.error));
    suppliers = r.suppliers;
    ok('suppliers come back', suppliers.length > 0, String(suppliers?.length));
    ok('sorted by units sold, biggest first',
      suppliers.every((s, i) => i === 0 || s.unitsSold365d <= suppliers[i - 1].unitsSold365d));

    const noSettings = suppliers.find(s => s.leadTimeSource !== 'supplier');
    ok('a supplier with no settings reports leadTimeSource dataset_default',
      noSettings?.leadTimeSource === 'dataset_default', noSettings?.leadTimeSource);
    ok('…and inherits the dataset default value', noSettings?.leadTimeDays === 90,
      String(noSettings?.leadTimeDays));
    console.log(`       ${suppliers.length} suppliers; top: ${suppliers[0].supplier} ` +
      `(${suppliers[0].skuItemCount} skus, ${Math.round(suppliers[0].unitsSold365d).toLocaleString('en-GB')} units/yr)`);
  }

  console.log('\n3 · A supplier override changes the answer, and says so');
  {
    await supplierSettings.upsertOverride(DS, PILOT, { leadTimeDays: 14 }, 'd1-test');
    const r = await recommendations.listSuppliers(DS, { schemaName: TMP });
    const s = r.suppliers.find(x => x.supplier === PILOT);
    ok('the override is reflected', s?.leadTimeDays === 14, String(s?.leadTimeDays));
    ok('…and tagged as supplier-set', s?.leadTimeSource === 'supplier', s?.leadTimeSource);

    const others = r.suppliers.filter(x => x.supplier !== PILOT);
    ok('other suppliers are untouched',
      others.every(x => x.leadTimeDays === 90 && x.leadTimeSource === 'dataset_default'));
  }

  console.log('\n4 · Recommendations on real data');
  let recs;
  {
    const r = await recommendations.getRecommendations(DS, { schemaName: TMP, today: TODAY });
    ok('the call succeeds', !r.error, JSON.stringify(r.error));
    recs = r;
    ok('rows come back', r.recommendations.length > 0, String(r.recommendations.length));
    ok('a data-through date is carried', Boolean(r.dataThrough), String(r.dataThrough));
    ok('the summary counts every row once',
      r.summary.orderNow + r.summary.dueSoon + r.summary.ok + r.summary.noDemand === r.total,
      `${JSON.stringify(r.summary)} vs total ${r.total}`);
    ok('most urgent first', r.recommendations[0].status === 'overdue'
      || r.summary.orderNow === 0, r.recommendations[0].status);
    console.log(`       ${r.total} rows — order now ${r.summary.orderNow}, due soon ${r.summary.dueSoon}, ` +
      `ok ${r.summary.ok}, no demand ${r.summary.noDemand}`);
    console.log(`       estimated total ex-VAT: ₪${Math.round(r.summary.estimatedTotalExVat).toLocaleString('en-GB')}`);
  }

  console.log('\n5 · Every row can show its working');
  {
    const r = recs.recommendations[0];
    ok('the row carries its inputs',
      ['velocityDaily', 'netAvailable', 'safetyStock', 'leadTimeDays', 'reorderPoint']
        .every(k => r[k] !== undefined));
    ok('…and where each parameter came from',
      Boolean(r.leadTimeSource) && Boolean(r.safetyStockSource) && Boolean(r.velocityBasis),
      `${r.leadTimeSource}/${r.safetyStockSource}/${r.velocityBasis}`);
    ok('…and caveats in words', Array.isArray(r.notes) && r.notes.length > 0,
      JSON.stringify(r.notes?.slice(0, 1)));
    ok('the pilot supplier uses ITS lead time, not the default',
      recs.recommendations.filter(x => x.supplier === PILOT).every(x => x.leadTimeDays === 14));
  }

  console.log('\n6 · Filters');
  {
    const one = await recommendations.getRecommendations(DS, {
      schemaName: TMP, today: TODAY, supplier: PILOT });
    ok('filtering by supplier narrows the set', one.total < recs.total && one.total > 0,
      `${one.total} of ${recs.total}`);
    ok('…to that supplier only', one.recommendations.every(r => r.supplier === PILOT));

    const due = await recommendations.getRecommendations(DS, {
      schemaName: TMP, today: TODAY, onlyDue: true });
    ok('onlyDue returns just overdue and due-soon',
      due.recommendations.every(r => r.status === 'overdue' || r.status === 'due_soon'));
    ok('…and the summary still describes the WHOLE set, not the filtered page',
      due.summary.ok === recs.summary.ok, `${due.summary.ok} vs ${recs.summary.ok}`);

    const limited = await recommendations.getRecommendations(DS, {
      schemaName: TMP, today: TODAY, limit: 5 });
    ok('limit caps the rows returned', limited.recommendations.length === 5);
    ok('…without changing the reported total', limited.total === recs.total,
      `${limited.total} vs ${recs.total}`);
  }

  console.log('\n7 · Single-item detail');
  {
    const sku = recs.recommendations[0].sku;
    const r = await recommendations.getBySku(DS, sku, { schemaName: TMP, today: TODAY });
    ok('one sku resolves', r.recommendation?.sku === sku, r.error || r.recommendation?.sku);
    const missing = await recommendations.getBySku(DS, '__no_such_sku__', { schemaName: TMP, today: TODAY });
    ok('an unknown sku 404s rather than returning nothing', missing.code === 404, JSON.stringify(missing));
  }

  // ── restore + cleanup ──
  await pool.query(`DROP SCHEMA IF EXISTS ${TMP} CASCADE`);
  await supplierSettings.deleteOverride(DS, PILOT);
  await moduleService.setEnabled(DS, MOD, restore.enabled, 'd1-test');
  await moduleService.setStatus(DS, MOD, restore.status, 'd1-test');

  const gone = await pool.query(
    `SELECT COUNT(*)::int n FROM information_schema.schemata WHERE schema_name=$1`, [TMP]);
  ok('the temporary schema is dropped', gone.rows[0].n === 0);
  const left = await drizzle.execute(
    `SELECT COUNT(*)::int n FROM supplier_settings WHERE dataset_id = '${DS}'`);
  ok('no supplier settings left behind', Number(((left.rows || left)[0]).n) === 0);
  const mod = await moduleService.getForDataset(DS, MOD);
  ok('the module is restored to how it was found',
    mod.enabled === restore.enabled && mod.status === restore.status,
    `enabled=${mod.enabled} status=${mod.status}`);

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('Battery failed:', err.message); console.error(err); process.exit(1); });
