/**
 * Smart Replenishment — supplier settings battery (C3).
 *
 * Two halves:
 *   1. the resolution chain (offline, pure): supplier override → dataset
 *      default → code constant, with the source tag every surface depends on
 *   2. storage round-trip against the real platform DB, plus the structural
 *      proof of the storage rule
 *
 * ON THE RELOAD-SURVIVAL CHECK: the plan's C3 clause is "upsert a lead time,
 * run a full zolstock reload, confirm it survived". Triggering the data
 * loader is not this session's to do — Phase 1/2 are run by hand by whoever
 * owns the infra — so what is proven here instead is the structural fact the
 * reload check exists to confirm: the row lives in the PLATFORM database
 * (agents_platform_db), which a dataset reload never touches, and NOT in the
 * dataset schema that gets dropped and rebuilt behind the atomic swap. The
 * check is asserted directly below (§3) and the live reload remains an
 * outstanding confirmation.
 *
 * Run: node scripts/test-supplier-settings.js
 */

require('dotenv').config();
const db = require('../services/db.pg');
const svc = require('../modules/replenishment/services/supplier-settings.service');

const DS = '__probe_dataset__';
const SUP = 'ב.א. זול סטוק והפצה בע"מ';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

const moduleSettings = {
  defaultLeadTimeDays: 90, defaultReviewDays: 30, defaultSafetyDays: 14,
  velocityWindowDays: 90, horizonDays: 14, cartonRounding: true, includeStoreStock: false,
};

(async () => {
  await db.initialize();
  const drizzle = db.getDrizzle();
  await drizzle.execute(`DELETE FROM supplier_settings WHERE dataset_id = '${DS}'`);

  console.log('\n1 · Resolution chain — supplier > dataset default > code');
  {
    const r = svc.resolveForSupplier(moduleSettings, null);
    ok('no override ⇒ the dataset default applies', r.leadTimeDays === 90, r.leadTimeDays);
    ok('…and is tagged dataset_default', r.leadTimeSource === 'dataset_default', r.leadTimeSource);
  }
  {
    const r = svc.resolveForSupplier(moduleSettings, { leadTimeDays: 21 });
    ok('a supplier override wins', r.leadTimeDays === 21, r.leadTimeDays);
    ok('…and is tagged supplier', r.leadTimeSource === 'supplier', r.leadTimeSource);
    ok('untouched fields still come from the dataset default',
      r.reviewDays === 30 && r.sources.reviewDays === 'dataset_default',
      `${r.reviewDays}/${r.sources.reviewDays}`);
  }
  {
    // A cleared field must FALL BACK, not pin to null — that is how a buyer
    // un-sets a lead time.
    const r = svc.resolveForSupplier(moduleSettings, { leadTimeDays: null });
    ok('a cleared override falls back to the default', r.leadTimeDays === 90, r.leadTimeDays);
    ok('…and stops claiming the buyer set it', r.leadTimeSource === 'dataset_default', r.leadTimeSource);
  }
  {
    const r = svc.resolveForSupplier(moduleSettings, { leadTimeDays: 0 });
    ok('a deliberate 0 is a real value, not "unset"',
      r.leadTimeDays === 0 && r.leadTimeSource === 'supplier',
      `${r.leadTimeDays}/${r.leadTimeSource}`);
  }
  {
    const r = svc.resolveForSupplier({}, null);
    ok('nothing anywhere ⇒ null, tagged code', r.leadTimeDays === null && r.leadTimeSource === 'code',
      `${r.leadTimeDays}/${r.leadTimeSource}`);
  }
  {
    const r = svc.resolveForSupplier(moduleSettings, { leadTimeDays: 21 });
    ok('dataset-wide settings pass straight through',
      r.velocityWindowDays === 90 && r.horizonDays === 14 && r.cartonRounding === true);
  }

  console.log('\n2 · Storage round-trip (real platform DB)');
  {
    await svc.upsertOverride(DS, SUP, { leadTimeDays: 21, supplierLabel: SUP }, 'c3-test');
    const row = await svc.getOverride(DS, SUP);
    ok('an override is stored', row?.leadTimeDays === 21, JSON.stringify(row?.leadTimeDays));
    ok('a Hebrew supplier key round-trips intact', row?.supplierKey === SUP, row?.supplierKey);

    await svc.upsertOverride(DS, SUP, { leadTimeDays: 45 }, 'c3-test');
    const rows = await svc.listOverrides(DS);
    ok('a second save updates in place rather than duplicating',
      rows.length === 1 && rows[0].leadTimeDays === 45, `${rows.length} rows`);
    ok('a field absent from the patch is left alone',
      rows[0].supplierLabel === SUP, rows[0].supplierLabel);

    await svc.upsertOverride(DS, SUP, { leadTimeDays: null }, 'c3-test');
    const cleared = await svc.getOverride(DS, SUP);
    ok('an explicit null clears the override', cleared.leadTimeDays === null,
      JSON.stringify(cleared.leadTimeDays));

    await svc.deleteOverride(DS, SUP);
    ok('delete removes the row', (await svc.listOverrides(DS)).length === 0);
  }
  {
    let rejected = false;
    try {
      await svc.upsertOverride(DS, 'x', { leadTimeDays: -5 }, 'c3-test');
    } catch { rejected = true; }
    ok('a nonsensical lead time is rejected by the CHECK', rejected);
    await drizzle.execute(`DELETE FROM supplier_settings WHERE dataset_id = '${DS}'`);
  }

  console.log('\n3 · The storage rule — what the reload check exists to prove');
  {
    // The row must live in the platform DB. A dataset reload drops and
    // recreates the dataset SCHEMA in a different database entirely, so a
    // setting stored here cannot be touched by one.
    const [where] = (await drizzle.execute(`SELECT current_database() AS db`)).rows
      || (await drizzle.execute(`SELECT current_database() AS db`));
    ok('supplier_settings lives in the platform database',
      where.db === (process.env.DB_NAME || 'agents_platform_db'), where.db);

    const inDataset = await drizzle.execute(`
      SELECT COUNT(*)::int AS n FROM information_schema.tables
       WHERE table_name = 'supplier_settings' AND table_schema <> 'public'`);
    const n = ((inDataset.rows || inDataset)[0]).n;
    ok('…and nowhere inside a dataset schema', Number(n) === 0, String(n));
  }

  const left = await drizzle.execute(
    `SELECT COUNT(*)::int AS n FROM supplier_settings WHERE dataset_id = '${DS}'`);
  const remaining = Number(((left.rows || left)[0]).n);
  console.log(`\ncleanup: ${remaining} test rows remaining (expected 0)`);
  ok('test state removed', remaining === 0);

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  console.log('\nOUTSTANDING: the live reload-survival confirmation (C3) still needs a');
  console.log('full zolstock reload, which is run by hand by whoever owns the infra.');
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('Battery failed:', err.message); console.error(err); process.exit(1); });
