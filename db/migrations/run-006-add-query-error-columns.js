#!/usr/bin/env node
const path = require('path');
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: path.join(__dirname, '../../', envFile) });

const { Pool } = require('pg');
const fs = require('fs');

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  const sql = fs.readFileSync(path.join(__dirname, '006_add_query_error_columns.sql'), 'utf8');

  try {
    await pool.query(sql);
    console.log('✅ Migration 006 applied: query_type + error_message columns added to slow_queries');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
