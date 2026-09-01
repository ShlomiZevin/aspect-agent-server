require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration 045 — trigger events + trigger status.
 *
 * Like 044, this runner does NOT split the file on ';' the way the older
 * runners in this folder do. `db.query()` with no params goes through
 * node-postgres' simple query protocol, which runs a multi-statement
 * string as one implicit transaction — so the two tables and their
 * indexes land together or not at all.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 045_add_trigger_events');

    await db.initialize();

    const sqlPath = path.join(__dirname, '045_add_trigger_events.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await db.query(sql);

    const [{ count: tables }] = (await db.query(
      "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name IN ('trigger_events','trigger_status')"
    )).rows;

    console.log(`
Migration completed. ${tables}/2 trigger tables present.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
