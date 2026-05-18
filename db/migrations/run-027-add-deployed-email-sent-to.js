/**
 * Migration 027: Add deployed_email_sent_to column to tasks
 *
 * Tracks which recipients have already received this task in their "What's New"
 * digest email. Names are stored as a JSONB string array (e.g. ["Shlomi","Noa"]).
 * Anti-spam: each task is included in a recipient's digest only once.
 *
 * Requires Cloud SQL Proxy running:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *
 * Run:
 *   node db/migrations/run-027-add-deployed-email-sent-to.js
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
    console.log('Running migration 027: add tasks.deployed_email_sent_to ...');

    await pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS deployed_email_sent_to JSONB DEFAULT '[]'::jsonb
    `);

    console.log('Done: tasks.deployed_email_sent_to column added (or already existed).');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
