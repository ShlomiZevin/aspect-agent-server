require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration 044 — conversation activity stamps.
 *
 * NOTE: unlike the earlier runners in this folder, this one does NOT
 * split the file on ';'. The migration defines a plpgsql function whose
 * body contains semicolons; splitting would shred it mid-statement.
 * `db.query()` with no params goes through node-postgres' simple query
 * protocol, which executes a multi-statement string as one implicit
 * transaction — which is also what we want here (the ALTERs, the
 * backfill and the trigger should land together or not at all).
 */
async function runMigration() {
  try {
    console.log('Starting migration: 044_add_conversation_activity_stamps');

    await db.initialize();

    const sqlPath = path.join(__dirname, '044_add_conversation_activity_stamps.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await db.query(sql);

    const [{ count: stamped }] = (await db.query(
      'SELECT COUNT(*)::int AS count FROM conversations WHERE last_user_message_at IS NOT NULL'
    )).rows;
    const [{ count: total }] = (await db.query(
      'SELECT COUNT(*)::int AS count FROM conversations'
    )).rows;

    console.log(`\nMigration completed. ${stamped}/${total} conversations have a customer stamp.`);
    console.log('(Conversations with no user message yet stay NULL — correct: nothing to be quiet about.)');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
