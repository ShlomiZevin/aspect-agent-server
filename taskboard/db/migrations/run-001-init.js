require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const connection = require('../connection');

/**
 * Creates the task board schema in `aspect_tasks_db`.
 *
 *   node taskboard/db/migrations/run-001-init.js
 *
 * Run it through the Cloud SQL Proxy like every other migration here. The
 * database itself must already exist (`CREATE DATABASE aspect_tasks_db`);
 * that cannot be done from inside a connection to the database it creates.
 *
 * The file is sent to Postgres WHOLE rather than split on semicolons, which is
 * what the platform's older runners do. It has to be: the `touch_updated_at`
 * function body is a $$-quoted block containing its own semicolons, and naive
 * splitting would tear it in half. Sending it whole also makes the migration
 * atomic -- pg wraps a multi-statement simple query in an implicit transaction,
 * so a failure half way leaves no partial schema behind.
 */
async function run() {
  const file = path.join(__dirname, '001_init.sql');
  const sql = fs.readFileSync(file, 'utf8');

  console.log(`Applying ${path.basename(file)} to ${connection.DB_NAME}`);

  const before = await connection.check();
  console.log(`  connected to ${before.db}, ${before.tables} table(s) present`);
  if (before.tables > 0) {
    console.log('  schema already exists - nothing to do (this migration is create-only)');
    await connection.close();
    return;
  }

  await connection.query(sql);

  const { rows } = await connection.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`);
  console.log(`  created: ${rows.map(r => r.table_name).join(', ')}`);

  const idx = await connection.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`);
  console.log(`  indexes: ${idx.rows.length}`);

  await connection.close();
  console.log('Done.');
}

run().catch(async err => {
  console.error('Migration failed:', err.message);
  await connection.close().catch(() => {});
  process.exit(1);
});
