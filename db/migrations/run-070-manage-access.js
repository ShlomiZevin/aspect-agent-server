#!/usr/bin/env node
// Management center access (task #985) — see 070_manage_access.sql.
// Safe to run twice. Run it per environment BEFORE deploying the server that
// reads the table (staging first; Origin is frozen and does not get it).
const path = require('path');
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: path.join(__dirname, '../../', envFile) });

const { Pool } = require('pg');
const fs = require('fs');

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST_PROXY || process.env.DB_HOST,
    port: process.env.DB_PORT_PROXY || process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const sql = fs.readFileSync(path.join(__dirname, '070_manage_access.sql'), 'utf8');

  try {
    await pool.query(sql);
    const { rows } = await pool.query(
      `SELECT email, agent_id FROM manage_access ORDER BY email, agent_id NULLS FIRST`,
    );
    console.log('✅ Migration 070 applied: manage_access (management center sign-in, #985)');
    for (const r of rows) console.log(`   ${r.email} → ${r.agent_id || 'every agent'}`);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
