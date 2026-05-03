/**
 * Migration 025: Add schema_descriptions table to the zer4u DB
 *
 * Stores auto-generated schema descriptions in the zer4u dedicated DB
 * (not main DB) since this is zer4u-specific metadata.
 *
 * Run via Cloud SQL Proxy (zer4u DB must be proxied on ZER4U_DB_PORT):
 *   node db/migrations/run-025-add-schema-descriptions.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host:     process.env.ZER4U_DB_HOST     || process.env.DB_HOST,
  port:     parseInt(process.env.ZER4U_DB_PORT || process.env.DB_PORT || 5432),
  database: process.env.ZER4U_DB_NAME     || process.env.DB_NAME,
  user:     process.env.ZER4U_DB_USER     || process.env.DB_USER,
  password: process.env.ZER4U_DB_PASSWORD || process.env.DB_PASSWORD,
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
    console.log('✅ Created schema_descriptions table in zer4u DB');

    // Seed from local cache file if it exists (preserves manually-curated content)
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
      console.log('ℹ️  No local cache file — description will be generated on next Full Rebuild');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error('❌ Migration failed:', err.message); process.exit(1); });
