/**
 * Migration 015: Add provider_config table
 *
 * Stores provider API keys and configuration settings.
 * Keys override environment variables at runtime (take effect immediately).
 *
 * Run via Cloud SQL Proxy:
 *   node db/migrations/run-015-add-provider-config.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST_PROXY || '127.0.0.1',
  port: parseInt(process.env.DB_PORT_PROXY || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const SQL = `
CREATE TABLE IF NOT EXISTS public.provider_config (
  id         SERIAL PRIMARY KEY,
  key        VARCHAR(100) NOT NULL UNIQUE,
  value      TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_config_key ON public.provider_config (key);
`;

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('Running migration 015: add provider_config table...');
    await client.query(SQL);
    console.log('Migration 015 completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
