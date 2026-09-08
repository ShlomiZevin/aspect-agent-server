require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Runner for 049_add_item_verdicts_and_proposals.sql — Procurement Groups +
 * Smart Tune storage, in the PLATFORM DB. Strictly additive (three new
 * tables); idempotent; run through the Cloud SQL Proxy like every migration
 * here.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 049_add_item_verdicts_and_proposals');
    await db.initialize();
    const drizzle = db.getDrizzle();

    const sql = fs.readFileSync(path.join(__dirname, '049_add_item_verdicts_and_proposals.sql'), 'utf8');
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
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('replenishment_item_verdicts', 'module_chat_proposals', 'module_bulk_operations')
       ORDER BY table_name`);
    const rows = check.rows || check;
    console.log('\nTables present:', rows.map(r => r.table_name).join(', ') || '(none — migration failed!)');

    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
