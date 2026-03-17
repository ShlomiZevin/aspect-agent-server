/**
 * Run migration 019: Add anthropic_file_id to knowledge_base_files
 * Requires Cloud SQL Proxy running: cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Pool } = require('pg');

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
    console.log('Running migration 019: Add anthropic_file_id to knowledge_base_files...');
    await client.query(`
      ALTER TABLE knowledge_base_files
      ADD COLUMN IF NOT EXISTS anthropic_file_id VARCHAR(255);
    `);
    console.log('✅ Migration 019 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
