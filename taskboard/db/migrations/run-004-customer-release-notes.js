require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const connection = require('../connection');

/** Applies 004_customer_release_notes.sql. Idempotent; needs the Cloud SQL Proxy. */
async function run() {
  console.log(`Applying 004_customer_release_notes.sql to ${connection.DB_NAME}`);
  await connection.query(fs.readFileSync(path.join(__dirname, '004_customer_release_notes.sql'), 'utf8'));

  const { rows } = await connection.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks' ORDER BY ordinal_position`);
  console.log('  tasks columns:', rows.map(r => r.column_name).join(', '));

  const { rows: seen } = await connection.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'customer_note_seen'`);
  console.log('  customer_note_seen table:', seen[0].n === 1 ? 'present' : 'MISSING');

  await connection.close();
  console.log('Done.');
}

run().catch(async err => {
  console.error('Migration failed:', err.message);
  await connection.close().catch(() => {});
  process.exit(1);
});
