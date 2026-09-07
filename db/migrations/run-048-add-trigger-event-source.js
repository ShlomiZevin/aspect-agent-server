require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration 048 — who started a trigger run.
 *
 * One nullable column plus an index, so no backfill and nothing to
 * coordinate: existing rows have no source and are read as the clock's,
 * which is what they are.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 048_add_trigger_event_source');
    await db.initialize();

    const sql = fs.readFileSync(path.join(__dirname, '048_add_trigger_event_source.sql'), 'utf8');
    await db.query(sql);

    const { rows } = await db.query(
      "SELECT column_name FROM information_schema.columns " +
      "WHERE table_name = 'trigger_events' AND column_name = 'source'");
    if (rows.length !== 1) throw new Error('source column was not created');

    const { rows: idx } = await db.query(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_trigger_events_source'");
    if (idx.length !== 1) throw new Error('idx_trigger_events_source was not created');

    console.log('Migration completed — trigger_events.source present.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
