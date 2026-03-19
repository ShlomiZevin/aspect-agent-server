/**
 * Migration: Add deploy tracking columns to tasks table
 *
 * Adds:
 *   - deployed_at      TIMESTAMP   (when task was deployed to prod)
 *   - deployed_reviewed_by  JSONB  (names of users who dismissed from "What's New")
 *
 * Safe to re-run — uses IF NOT EXISTS checks.
 *
 * Usage:
 *   node scripts/migrate-deploy-tracking.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    // Add deployed_at column
    const col1 = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tasks' AND column_name = 'deployed_at'
    `);
    if (col1.rows.length === 0) {
      await client.query(`ALTER TABLE tasks ADD COLUMN deployed_at TIMESTAMP`);
      console.log('Added deployed_at column');
    } else {
      console.log('deployed_at column already exists');
    }

    // Add deployed_reviewed_by column
    const col2 = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tasks' AND column_name = 'deployed_reviewed_by'
    `);
    if (col2.rows.length === 0) {
      await client.query(`ALTER TABLE tasks ADD COLUMN deployed_reviewed_by JSONB DEFAULT '[]'`);
      console.log('Added deployed_reviewed_by column');
    } else {
      console.log('deployed_reviewed_by column already exists');
    }

    console.log('Migration complete');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
