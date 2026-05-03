/**
 * Migration 025: Add schema_descriptions table
 *
 * Stores auto-generated schema descriptions (used by SQL generator)
 * in the DB instead of a local file, so they persist across Cloud Run deploys.
 *
 * Run via Cloud SQL Proxy:
 *   node db/migrations/run-025-add-schema-descriptions.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST_PROXY || process.env.DB_HOST,
  port: process.env.DB_PORT_PROXY || process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_descriptions (
        schema_name  TEXT PRIMARY KEY,
        description  TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✅ Created schema_descriptions table');

    // Seed from local cache file if it exists
    const cacheFile = path.join(__dirname, '../../data/zer4u-schema-description.txt');
    if (fs.existsSync(cacheFile)) {
      const description = fs.readFileSync(cacheFile, 'utf8').trim();
      if (description.length > 100) {
        await client.query(
          `INSERT INTO public.schema_descriptions (schema_name, description)
           VALUES ('zer4u', $1)
           ON CONFLICT (schema_name) DO UPDATE
             SET description = EXCLUDED.description, generated_at = NOW()`,
          [description]
        );
        console.log('✅ Seeded zer4u description from local cache file');
      }
    } else {
      console.log('ℹ️  No local cache file found — description will be generated on next Full Rebuild');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });
