require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Runner for 040_add_client_modules.sql — the Aspect Modules framework tables
 * (client_modules, module_runs, module_outbox) in the PLATFORM DB.
 *
 * Idempotent: every statement in the .sql is CREATE TABLE/INDEX IF NOT
 * EXISTS, so re-running is safe. Run it through the Cloud SQL Proxy like
 * every other migration in this folder — never against the live DB directly.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 040_add_client_modules');
    await db.initialize();
    const drizzle = db.getDrizzle();

    const sql = fs.readFileSync(path.join(__dirname, '040_add_client_modules.sql'), 'utf8');
    const statements = sql
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean);

    console.log(`Executing ${statements.length} SQL statements...`);
    for (let i = 0; i < statements.length; i++) {
      const preview = statements[i].split('\n')[0].slice(0, 70);
      console.log(`\n[${i + 1}/${statements.length}] ${preview}...`);
      await drizzle.execute(statements[i]);
      console.log('   Done.');
    }

    // Report what actually exists now, rather than trusting that the
    // statements above implied it — IF NOT EXISTS hides a pre-existing
    // table, and a silently-absent table would only surface much later.
    const check = await drizzle.execute(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('client_modules', 'module_runs', 'module_outbox')
       ORDER BY table_name
    `);
    const rows = check.rows || check;
    console.log('\nTables present:', rows.map(r => r.table_name).join(', ') || '(none)');

    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
