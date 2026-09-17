require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Runner for 054_alfred_apply_jobs.sql — Alfred Apply job + forensic log,
 * in the PLATFORM DB. Strictly additive (one new table); idempotent; run
 * through the Cloud SQL Proxy like every migration here.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 054_alfred_apply_jobs');
    await db.initialize();
    const drizzle = db.getDrizzle();

    const sql = fs.readFileSync(path.join(__dirname, '054_alfred_apply_jobs.sql'), 'utf8');
    const statements = sql
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean);

    console.log(`Executing ${statements.length} SQL statements...`);
    for (let i = 0; i < statements.length; i++) {
      console.log(`\n[${i + 1}/${statements.length}] ${statements[i].split('\n')[0].slice(0, 70)}...`);
      await drizzle.execute(statements[i]);
      console.log('   Done.');
    }

    const check = await drizzle.execute(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'alfred_apply_jobs'
       ORDER BY ordinal_position`);
    const rows = check.rows || check;
    console.log('\nColumns present:', rows.map(r => r.column_name).join(', ') || '(none — migration failed!)');

    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\nMigration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
