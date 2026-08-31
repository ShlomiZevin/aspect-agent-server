require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/** Runner for 046. Idempotent; needs the Cloud SQL Proxy. */
async function runMigration() {
  try {
    console.log('Starting migration: 046_supplier_exclude_flag');
    await db.initialize();
    const drizzle = db.getDrizzle();

    const sql = fs.readFileSync(path.join(__dirname, '046_supplier_exclude_flag.sql'), 'utf8');
    for (const st of sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean)) {
      await drizzle.execute(st);
    }

    const cols = await drizzle.execute(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='supplier_settings' AND column_name='excluded'`);
    const rows = cols.rows || cols;
    console.log(rows.length ? `excluded: default ${rows[0].column_default}` : 'MISSING!');
    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
