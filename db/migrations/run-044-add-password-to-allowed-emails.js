require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/** Runner for 044. Idempotent; needs the Cloud SQL Proxy. */
async function runMigration() {
  try {
    console.log('Starting migration: 044_add_password_to_allowed_emails');
    await db.initialize();
    const drizzle = db.getDrizzle();

    const sql = fs.readFileSync(path.join(__dirname, '044_add_password_to_allowed_emails.sql'), 'utf8');
    for (const st of sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean)) {
      await drizzle.execute(st);
    }

    const cols = await drizzle.execute(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='allowed_emails' ORDER BY ordinal_position`);
    console.log('allowed_emails:', (cols.rows || cols).map(r => r.column_name).join(', '));
    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
