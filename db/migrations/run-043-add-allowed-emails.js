require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/** Runner for 043_add_allowed_emails.sql. Idempotent; needs the Cloud SQL Proxy. */
async function runMigration() {
  try {
    console.log('Starting migration: 043_add_allowed_emails');
    await db.initialize();
    const drizzle = db.getDrizzle();

    const sql = fs.readFileSync(path.join(__dirname, '043_add_allowed_emails.sql'), 'utf8');
    const statements = sql
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean);

    for (let i = 0; i < statements.length; i++) {
      console.log(`[${i + 1}/${statements.length}] ${statements[i].split('\n')[0].slice(0, 68)}...`);
      await drizzle.execute(statements[i]);
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
