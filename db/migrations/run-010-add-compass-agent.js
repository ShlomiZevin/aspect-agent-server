/**
 * Migration 010: Add Compass demo agent to DB
 *
 * Requires Cloud SQL Proxy running:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *
 * Usage:
 *   node db/migrations/run-010-add-compass-agent.js
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
    console.log('Running migration 010: Add Compass agent...');

    // Check if already exists
    const existing = await client.query(
      "SELECT id FROM agents WHERE name = 'Compass' LIMIT 1"
    );
    if (existing.rows.length > 0) {
      console.log(`✅ Compass agent already exists (id=${existing.rows[0].id})`);
      return;
    }

    // Insert Compass agent
    const result = await client.query(`
      INSERT INTO agents (name, url_slug, domain, description, config, is_active)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING id, name
    `, [
      'Compass',
      'compass',
      'career',
      'Career change navigator demo agent — showcases tool calls, KB, crew transitions, context system, and field extraction',
      JSON.stringify({
        model: 'gpt-5-chat-latest',
        provider: 'openai'
      })
    ]);

    const agent = result.rows[0];
    console.log(`✅ Migration 010 complete — Compass agent created (id=${agent.id})`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Deploy server (crew files auto-loaded from agents/compass/crew/)');
    console.log('  2. Create "Compass Career KB" via dashboard (upload 3 markdown files from agents/compass/kb/)');
    console.log('  3. Open /compass in browser to test');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
