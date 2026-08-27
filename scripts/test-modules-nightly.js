/**
 * Aspect Modules — nightly build hook battery (E1) and outbox provider (E2).
 *
 * Run: node scripts/test-modules-nightly.js
 *
 * Needs the platform DB. Builds real module views into a throwaway shadow
 * schema on the data DB, dropped afterwards. Does NOT run a reload — the
 * loader is run by hand by whoever owns the infra — so what is exercised here
 * is the hook itself, in all three states the plan names:
 *
 *   1. module disabled  ⇒ the path is byte-identical to today: no query
 *                          issued, nothing touched
 *   2. module live      ⇒ its views are built into the shadow schema
 *   3. module build fails ⇒ the module degrades, a notification lands in the
 *                          outbox, and the caller is told the reload may
 *                          continue
 *
 * Self-cleaning: the shadow schema is dropped, and every row it writes under
 * the probe dataset is deleted.
 */

require('dotenv').config();
const db = require('../services/db.pg');
const datasetRegistry = require('../insights/datasets/registry');
const moduleService = require('../modules/services/module.service');
const buildService = require('../modules/services/module-build.service');
const notificationService = require('../modules/notification.service');

const DS = 'zolstock';
const MOD = 'replenishment';
const SHADOW = 'zolstock_e1_shadow';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

(async () => {
  await db.initialize();
  const drizzle = db.getDrizzle();
  const entry = datasetRegistry.get(DS);
  const pool = entry.getPool();

  const before = await moduleService.getForDataset(DS, MOD);
  if (!before?.binding) {
    console.error('This battery needs a converged binding — run scripts/run-module-init.js first.');
    process.exit(1);
  }
  const restoreEnabled = before.enabled;
  const restoreStatus = before.status;

  const logs = [];
  const emitLog = (step, msg) => logs.push(msg);

  console.log('\n1 · Module disabled ⇒ the reload path is untouched');
  {
    await moduleService.setEnabled(DS, MOD, false, 'e1-test');
    logs.length = 0;
    const r = await buildService.buildModulesInShadow(DS, SHADOW, pool, emitLog);
    ok('nothing is built', r.built.length === 0 && r.failed.length === 0, JSON.stringify(r));
    ok('the hook reports it skipped', r.skipped === true);
    ok('it emits no log lines into the reload output', logs.length === 0, JSON.stringify(logs));
    const exists = await pool.query(
      `SELECT COUNT(*)::int n FROM information_schema.schemata WHERE schema_name=$1`, [SHADOW]);
    ok('no schema was created or touched', exists.rows[0].n === 0);
  }

  console.log('\n2 · Module live ⇒ its views are built into the shadow schema');
  {
    // A shadow schema in a reload holds a full fresh COPY of the data. Here
    // that is simulated with views over the live tables, which is enough for
    // the module's SQL to resolve exactly as it would against a real shadow.
    await pool.query(`DROP SCHEMA IF EXISTS ${SHADOW} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SHADOW}`);
    await pool.query(`CREATE VIEW ${SHADOW}.facts AS SELECT * FROM ${DS}.facts`);
    await pool.query(`CREATE VIEW ${SHADOW}.items AS SELECT * FROM ${DS}.items`);

    await moduleService.setEnabled(DS, MOD, true, 'e1-test');
    await moduleService.setStatus(DS, MOD, 'ready', 'e1-test');
    logs.length = 0;

    const started = Date.now();
    const r = await buildService.buildModulesInShadow(DS, SHADOW, pool, emitLog);
    const secs = ((Date.now() - started) / 1000).toFixed(0);

    ok('the module built', r.built.length === 1 && r.failed.length === 0, JSON.stringify(r));
    ok('…and it took real work', Number(secs) > 0, `${secs}s`);

    const views = await pool.query(
      `SELECT matviewname AS n, ispopulated FROM pg_matviews WHERE schemaname=$1 ORDER BY 1`, [SHADOW]);
    const names = views.rows.map(v => v.n);
    ok('mv_replenishment_base landed in the shadow schema', names.includes('mv_replenishment_base'), names.join(','));
    ok('mv_suppliers landed too', names.includes('mv_suppliers'), names.join(','));
    ok('both are populated', views.rows.every(v => v.ispopulated));

    const rows = await pool.query(`SELECT COUNT(*)::int n FROM ${SHADOW}.mv_replenishment_base`);
    ok('the base view has the expected grain', rows.rows[0].n > 10000, String(rows.rows[0].n));
    console.log(`       (${rows.rows[0].n.toLocaleString('en-GB')} rows, built in ${secs}s)`);

    ok('the reload log names the module and its cost',
      logs.some(l => /replenishment: built \d+ statement/.test(l)), JSON.stringify(logs));
  }

  console.log('\n3 · A module build failure degrades the module, never the reload');
  {
    // Corrupt the stored binding so rendering succeeds but the SQL cannot run.
    const good = (await moduleService.getForDataset(DS, MOD)).binding;
    const broken = JSON.parse(JSON.stringify(good));
    broken.demand.table = 'no_such_table';
    await moduleService.setBinding(DS, MOD, broken, 'claude-sonnet-4-6', 'e1-test');

    await drizzle.execute(`DELETE FROM module_outbox WHERE dataset_id='${DS}' AND module_id='${MOD}'`);
    await moduleService.saveSettings(DS, MOD, {
      notificationEmails: ['ops@example.com', 'buyer@example.com'],
    }, 'e1-test');

    logs.length = 0;
    let threw = false;
    let r;
    try {
      r = await buildService.buildModulesInShadow(DS, SHADOW, pool, emitLog);
    } catch { threw = true; }

    ok('the hook does NOT throw — the reload must be able to continue', !threw);
    ok('the failure is reported to the caller', r?.failed?.length === 1, JSON.stringify(r?.failed));
    ok('…and named in the reload log',
      logs.some(l => /BUILD FAILED/.test(l) && /reload continues/.test(l)), JSON.stringify(logs));

    const after = await moduleService.getForDataset(DS, MOD);
    ok('the module is marked degraded', after.status === 'degraded', after.status);
    ok('…and is therefore no longer live', after.live === false, `enabled=${after.enabled} live=${after.live}`);

    const outbox = await notificationService.listOutbox(DS, MOD);
    ok('a notification landed in the outbox', outbox.length === 1, String(outbox.length));
    ok('…for the right event', outbox[0]?.event === 'nightly_build_failed', outbox[0]?.event);
    ok('…addressed to the configured emails',
      JSON.stringify(outbox[0]?.recipients) === JSON.stringify(['ops@example.com', 'buyer@example.com']),
      JSON.stringify(outbox[0]?.recipients));
    ok('…with the provider recorded as the mocked one', outbox[0]?.provider === 'outbox', outbox[0]?.provider);
    ok('…and no real mail was sent', notificationService.getProviderName() === 'outbox');

    console.log('\n4 · A degraded module recovers on the next good build');
    await moduleService.setBinding(DS, MOD, good, 'claude-sonnet-4-6', 'e1-test');
    // A degraded module is not live, so re-enable the gate for the retry —
    // exactly what the next successful reload does.
    await moduleService.setStatus(DS, MOD, 'ready', 'e1-test');
    logs.length = 0;
    const r2 = await buildService.buildModulesInShadow(DS, SHADOW, pool, emitLog);
    ok('it builds cleanly again', r2.built.length === 1 && r2.failed.length === 0, JSON.stringify(r2));
    ok('status is ready', (await moduleService.getForDataset(DS, MOD)).status === 'ready');
  }

  console.log('\n5 · Event plumbing');
  {
    await drizzle.execute(`DELETE FROM module_outbox WHERE dataset_id='${DS}' AND module_id='${MOD}'`);
    const undeclared = await notificationService.emit({
      datasetId: DS, moduleId: MOD, event: 'not_a_real_event', payload: {},
    });
    ok('an undeclared event is refused, not invented', undeclared.sent === false, JSON.stringify(undeclared));

    await moduleService.saveSettings(DS, MOD, { notificationEmails: [] }, 'e1-test');
    const noRecipients = await notificationService.emit({
      datasetId: DS, moduleId: MOD, event: 'init_completed', payload: {},
    });
    ok('no recipients ⇒ nothing sent, and it says why',
      noRecipients.sent === false && /recipients/.test(noRecipients.reason), JSON.stringify(noRecipients));

    await moduleService.saveSettings(DS, MOD, {
      notificationEmails: ['a@example.com'],
      notificationEvents: { init_completed: false },
    }, 'e1-test');
    const off = await notificationService.emit({
      datasetId: DS, moduleId: MOD, event: 'init_completed', payload: {},
    });
    ok('a toggled-off event produces nothing', off.sent === false && /switched off/.test(off.reason),
      JSON.stringify(off));

    const left = await notificationService.listOutbox(DS, MOD);
    ok('…and none of those wrote to the outbox', left.length === 0, String(left.length));
  }

  // ── restore + cleanup ──
  await pool.query(`DROP SCHEMA IF EXISTS ${SHADOW} CASCADE`);
  await drizzle.execute(`DELETE FROM module_outbox WHERE dataset_id='${DS}' AND module_id='${MOD}'`);
  await moduleService.saveSettings(DS, MOD, {
    notificationEmails: ['kosta@aspect.local'], notificationEvents: null,
  }, 'e1-test');
  await moduleService.setEnabled(DS, MOD, restoreEnabled, 'e1-test');
  await moduleService.setStatus(DS, MOD, restoreStatus, 'e1-test');

  const shadowGone = await pool.query(
    `SELECT COUNT(*)::int n FROM information_schema.schemata WHERE schema_name=$1`, [SHADOW]);
  ok('the test shadow schema is dropped', shadowGone.rows[0].n === 0);
  const restored = await moduleService.getForDataset(DS, MOD);
  ok('the module is restored to how it was found',
    restored.enabled === restoreEnabled && restored.status === restoreStatus,
    `enabled=${restored.enabled} status=${restored.status}`);

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  console.log('\nOUTSTANDING: a real end-to-end reload (Phase 1/2) is run by hand and');
  console.log('remains the final confirmation for E1, C2 and C3.');
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('Battery failed:', err.message); console.error(err); process.exit(1); });
