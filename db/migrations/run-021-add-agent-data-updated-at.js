/**
 * Migration 021: Add data_updated_at column to agents table
 *
 * Stores the date of the most recent data row for agents that have
 * a data schema (e.g. zer4u). Updated automatically after each
 * successful data reload by DataReloadService.
 *
 * Requires Cloud SQL Proxy running:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *
 * Run:
 *   node db/migrations/run-021-add-agent-data-updated-at.js
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
    console.log('Running migration 021: add agents.data_updated_at ...');

    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS data_updated_at TIMESTAMPTZ
    `);

    console.log('Done: agents.data_updated_at column added (or already existed).');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
