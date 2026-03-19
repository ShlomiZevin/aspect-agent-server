/**
 * Run migration 020: Add dynamic_kb_files and dynamic_kb_attachments tables
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
    console.log('Running migration 020: Add dynamic KB tables...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS dynamic_kb_files (
        id          SERIAL PRIMARY KEY,
        agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name        VARCHAR(255) NOT NULL,
        file_type   VARCHAR(20) NOT NULL CHECK (file_type IN ('text', 'table')),
        gcs_path    VARCHAR(1024),
        file_size   INTEGER DEFAULT 0,
        metadata    JSONB DEFAULT '{}',
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Created dynamic_kb_files');

    await client.query(`
      CREATE TABLE IF NOT EXISTS dynamic_kb_attachments (
        id                SERIAL PRIMARY KEY,
        dynamic_file_id   INTEGER NOT NULL REFERENCES dynamic_kb_files(id) ON DELETE CASCADE,
        knowledge_base_id INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        kb_file_id        INTEGER REFERENCES knowledge_base_files(id) ON DELETE SET NULL,
        created_at        TIMESTAMP DEFAULT NOW(),
        UNIQUE(dynamic_file_id, knowledge_base_id)
      );
    `);
    console.log('✅ Created dynamic_kb_attachments');

    console.log('✅ Migration 020 complete');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
