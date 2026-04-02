/**
 * Migration 022: Add emailed_at column to task_notifications
 *
 * Tracks which notifications have been sent via email (for debounce batching).
 * NULL = not yet emailed. TIMESTAMP = when the batch email was sent.
 *
 * Requires Cloud SQL Proxy running:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *
 * Run:
 *   node db/migrations/run-022-add-emailed-at-to-notifications.js
 */

require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST_PROXY || '127.0.0.1',
    port: parseInt(process.env.DB_PORT_PROXY || '5432'),
    database: process.env.DB_NAME || 'agents_platform_db',
    user: process.env.DB_USER || 'agent_admin',
    password: process.env.DB_PASSWORD,
  });

  try {
    console.log('Running migration 022: add task_notifications.emailed_at ...');

    await pool.query(`
      ALTER TABLE task_notifications
      ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ
    `);

    console.log('Done: task_notifications.emailed_at column added (or already existed).');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
