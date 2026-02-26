/**
 * Run migration 009: Add knowledge_base_sources to crew_members
 * Requires Cloud SQL Proxy running: cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Pool } = require('pg');

// Use proxy connection (DB_HOST_PROXY=127.0.0.1) if available, else fallback to direct DATABASE_URL
const poolConfig = process.env.DB_HOST_PROXY
  ? {
      host: process.env.DB_HOST_PROXY,
      port: parseInt(process.env.DB_PORT_PROXY || '5432', 10),
      database: process.env.DB_NAME || 'agents_platform_db',
      user: process.env.DB_USER || 'agent_admin',
      password: process.env.DB_PASSWORD,
    }
  : { connectionString: process.env.DATABASE_URL };

const pool = new Pool(poolConfig);

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running migration 009: Add knowledge_base_sources to crew_members...');
    await client.query(`
      ALTER TABLE crew_members
      ADD COLUMN IF NOT EXISTS knowledge_base_sources JSONB;
    `);
    console.log('✅ Migration 009 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
