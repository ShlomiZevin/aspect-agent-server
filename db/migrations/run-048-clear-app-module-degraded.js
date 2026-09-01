require('dotenv').config();
const db = require('../../services/db.pg');
const registry = require('../../modules/registry');

/**
 * 048 — clear the `degraded` status the nightly build wrote onto APP modules.
 *
 * Not a schema change, which is why there is no paired .sql: it repairs rows
 * that a bug in the host wrote, and only the module registry knows which rows
 * those are. An app module has no hooks and no binding, so the build loop threw
 * "module is ready but has no stored binding" on it and marked a module that was
 * working perfectly as broken, on every single reload.
 *
 * The build no longer walks app modules (see modules/registry.js runsHooks), so
 * nothing will write this again — but a status already stored stays stored, and
 * the client's Modules page reads it as an orange "Degraded" badge on a board
 * that is serving traffic normally.
 *
 * Safe to re-run: it only touches app modules whose status is exactly
 * 'degraded', and an app module has nothing that could legitimately degrade.
 *
 *   node db/migrations/run-048-clear-app-module-degraded.js
 */
async function run() {
  try {
    await db.initialize();
    const drizzle = db.getDrizzle();

    const appIds = registry.all()
      .filter(d => (d.kind || 'data') === 'app')
      .map(d => d.id);

    if (!appIds.length) {
      console.log('No app modules are registered — nothing to repair.');
      process.exit(0);
    }
    console.log(`App modules: ${appIds.join(', ')}`);

    const list = appIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
    const before = await drizzle.execute(
      `SELECT dataset_id, module_id, status FROM client_modules
        WHERE module_id IN (${list}) AND status = 'degraded'`);
    const rows = before.rows || before;

    if (!rows.length) {
      console.log('Nothing is degraded. Nothing to do.');
      process.exit(0);
    }
    for (const r of rows) console.log(`  repairing ${r.dataset_id}/${r.module_id}`);

    // Back to 'ready' rather than 'not_initialized': enabling an app module IS
    // its whole installation, so ready is the state it never actually left.
    await drizzle.execute(
      `UPDATE client_modules SET status = 'ready', updated_at = NOW()
        WHERE module_id IN (${list}) AND status = 'degraded'`);

    const after = await drizzle.execute(
      `SELECT dataset_id, module_id, enabled, status FROM client_modules
        WHERE module_id IN (${list}) ORDER BY dataset_id`);
    for (const r of (after.rows || after)) {
      console.log(`  ${r.dataset_id}/${r.module_id}: enabled=${r.enabled} status=${r.status}`);
    }
    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
