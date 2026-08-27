require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Runner for 041_add_supplier_settings.sql — the Smart Replenishment module's
 * own table, in the PLATFORM DB. Idempotent; run it through the Cloud SQL
 * Proxy like every other migration here.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 041_add_supplier_settings');
    await db.initialize();
    const drizzle = db.getDrizzle();

    const sql = fs.readFileSync(path.join(__dirname, '041_add_supplier_settings.sql'), 'utf8');
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
       WHERE table_schema = 'public' AND table_name = 'supplier_settings'
       ORDER BY ordinal_position`);
    const rows = check.rows || check;
    console.log('\nsupplier_settings columns:', rows.map(r => r.column_name).join(', ') || '(table missing!)');

    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
