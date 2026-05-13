/**
 * Migration 026: Add contact_email to agents table
 * Run via Cloud SQL Proxy:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *   node db/migrations/run-026-add-contact-email.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST_PROXY || '127.0.0.1',
  port: process.env.DB_PORT_PROXY || 5432,
  database: process.env.DB_NAME || 'agents_platform_db',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: false,
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running migration 026: add contact_email to agents...');
    await client.query(`
      ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS contact_email text;
    `);
    console.log('Done. contact_email column added to agents table.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
