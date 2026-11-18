#!/usr/bin/env node
// Data protection blocks (task #986) — see 071_protection_events.sql.
// Safe to run twice. Run it per environment BEFORE deploying the server that
// writes the table (staging first; Origin is frozen and does not get it).
// A server deployed without it still BLOCKS — only the record is lost.
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

  const sql = fs.readFileSync(path.join(__dirname, '071_protection_events.sql'), 'utf8');

  try {
    await pool.query(sql);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM protection_events');
    console.log(`✅ Migration 071 applied: protection_events (data protection blocks, #986) — ${rows[0].n} rows`);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
