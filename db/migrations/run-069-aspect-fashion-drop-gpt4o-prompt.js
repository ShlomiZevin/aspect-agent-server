#!/usr/bin/env node
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

  const sql = fs.readFileSync(path.join(__dirname, '069_aspect_fashion_drop_gpt4o_prompt.sql'), 'utf8');

  try {
    const r = await pool.query(sql);
    console.log(r.rowCount
      ? '✅ Migration 069 applied: Aspect fashion crew no longer pinned to gpt-4o (#117)'
      : '✅ Migration 069: nothing to do (version already inactive or changed since)');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
