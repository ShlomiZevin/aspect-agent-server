#!/usr/bin/env node
// Agenda line comments (action items) — see 072_agenda_line_comments.sql.
// Safe to run twice. Run it per environment BEFORE deploying the server that
// reads the table (staging only; Origin is frozen and does not get it).
// Without it the action-items comments fail to load / save; ticks and notes
// keep working.
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

  const sql = fs.readFileSync(path.join(__dirname, '072_agenda_line_comments.sql'), 'utf8');

  try {
    await pool.query(sql);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM agenda_line_comments');
    console.log(`✅ Migration 072 applied: agenda_line_comments (action items comments) — ${rows[0].n} rows`);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
