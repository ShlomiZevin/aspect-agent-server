require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/** Runner for 045. Idempotent; needs the Cloud SQL Proxy. */
async function runMigration() {
  try {
    console.log('Starting migration: 045_one_running_module_run');
    await db.initialize();
    const drizzle = db.getDrizzle();

    // A duplicate left by an earlier race would block the index; report it
    // rather than failing with a bare constraint error.
    const dupes = await drizzle.execute(`
      SELECT dataset_id, module_id, count(*)::int AS n FROM module_runs
       WHERE status = 'running' GROUP BY dataset_id, module_id HAVING count(*) > 1`);
    const rows = dupes.rows || dupes;
    if (rows.length) {
      console.error('Cannot add the index — these already have more than one running run:');
      for (const r of rows) console.error(`  ${r.dataset_id}/${r.module_id}: ${r.n}`);
      console.error('Resolve them (they are stuck, not live) and re-run.');
      process.exit(1);
    }

    const sql = fs.readFileSync(path.join(__dirname, '045_one_running_module_run.sql'), 'utf8');
    for (const st of sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean)) {
      await drizzle.execute(st);
    }

    const idx = await drizzle.execute(
      `SELECT indexname FROM pg_indexes WHERE tablename='module_runs' AND indexname='module_runs_one_running_idx'`);
    console.log('index:', (idx.rows || idx).map(r => r.indexname).join(', ') || '(missing!)');
    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
