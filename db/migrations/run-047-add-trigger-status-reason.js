require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration 047 — a reason line for zero-match sweeps.
 *
 * One nullable column, so no backfill and nothing to coordinate: existing
 * rows simply have no reason yet and gain one on their next evaluation.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 047_add_trigger_status_reason');
    await db.initialize();

    const sql = fs.readFileSync(path.join(__dirname, '047_add_trigger_status_reason.sql'), 'utf8');
    await db.query(sql);

    const { rows } = await db.query(
      "SELECT column_name FROM information_schema.columns " +
      "WHERE table_name = 'trigger_status' AND column_name = 'last_reason'");
    if (rows.length !== 1) throw new Error('last_reason column was not created');

    console.log('Migration completed — trigger_status.last_reason present.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
