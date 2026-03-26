/**
 * Migration 020: Add data_reload_runs table
 *
 * Tracks history of data reload operations (per schema).
 * Used by DataReloadService for run history and log persistence.
 *
 * Requires Cloud SQL Proxy running:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *
 * Usage:
 *   node db/migrations/run-020-data-reload-runs.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DB_HOST_PROXY
    ? {
        host: process.env.DB_HOST_PROXY,
        port: parseInt(process.env.DB_PORT_PROXY || '5432', 10),
        database: process.env.DB_NAME || 'agents_platform_db',
        user: process.env.DB_USER || 'agent_admin',
        password: process.env.DB_PASSWORD,
      }
    : { connectionString: process.env.DATABASE_URL }
);

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running migration 020: Add data_reload_runs table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.data_reload_runs (
        id             SERIAL PRIMARY KEY,
        schema_name    TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'running',
        triggered_by   TEXT NOT NULL DEFAULT 'manual',
        step           TEXT,

        started_at     TIMESTAMP DEFAULT NOW(),
        completed_at   TIMESTAMP,

        total_files    INTEGER,
        files_loaded   INTEGER DEFAULT 0,
        total_rows     BIGINT DEFAULT 0,

        file_progress  JSONB DEFAULT '[]'::jsonb,
        log_entries    JSONB DEFAULT '[]'::jsonb,

        error_message  TEXT,
        error_step     TEXT
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_data_reload_runs_schema
      ON public.data_reload_runs (schema_name, started_at DESC);
    `);

    console.log('✅ Migration 020 complete: data_reload_runs table created');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
