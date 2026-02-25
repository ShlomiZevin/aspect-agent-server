#!/usr/bin/env node
/**
 * Migration 008: Add Google KB support
 * Run with: node db/migrations/run-008-add-google-kb.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '008_add_google_kb_support.sql'),
      'utf8'
    );

    console.log('🚀 Running migration 008: Add Google KB support...');
    await pool.query(sql);
    console.log('✅ Migration 008 completed successfully');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
