/**
 * Migration 016: Add Zer4U dedicated agent to DB
 *
 * Requires Cloud SQL Proxy running:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *
 * Usage:
 *   node db/migrations/run-016-add-zer4u-agent.js
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
    console.log('Running migration 016: Add Zer4U agent...');

    const existing = await client.query(
      "SELECT id FROM agents WHERE name = 'Zer4U' LIMIT 1"
    );
    if (existing.rows.length > 0) {
      console.log(`✅ Zer4U agent already exists (id=${existing.rows[0].id})`);
      return;
    }

    const result = await client.query(`
      INSERT INTO agents (name, url_slug, domain, description, config, is_active)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING id, name
    `, [
      'Zer4U',
      'zer4u',
      'retail',
      'Dedicated business intelligence agent for Zer4U flower shop — queries real sales, inventory, and customer data',
      JSON.stringify({
        model: 'gpt-4o',
        provider: 'openai'
      })
    ]);

    const agent = result.rows[0];
    console.log(`✅ Migration 016 complete — Zer4U agent created (id=${agent.id})`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Deploy server (crew auto-loaded from agents/zer4u/crew/)');
    console.log('  2. Deploy client (firebase deploy --only hosting --project aspect-agents)');
    console.log('  3. Open /zer4u in browser to test');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
