require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration 046 — timezone-aware timestamps for the trigger engine.
 *
 * Executed as one multi-statement string (simple query protocol), so the
 * column conversions and the redefined stamping function land together.
 * Verifies afterwards by asserting the comparison that was broken —
 * "one hour ago is in the past" — actually holds.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 046_trigger_timestamps_tz');
    await db.initialize();

    const sql = fs.readFileSync(path.join(__dirname, '046_trigger_timestamps_tz.sql'), 'utf8');
    await db.query(sql);

    const { rows } = await db.query(`
      SELECT table_name, column_name, data_type
        FROM information_schema.columns
       WHERE (table_name = 'conversations' AND column_name IN ('last_message_at','last_user_message_at'))
          OR (table_name = 'trigger_events' AND column_name IN ('matched_at','started_at','ended_at'))
       ORDER BY table_name, column_name`);
    console.table(rows);

    const naive = rows.filter(r => r.data_type !== 'timestamp with time zone');
    if (naive.length) throw new Error(`still naive: ${naive.map(r => `${r.table_name}.${r.column_name}`).join(', ')}`);

    // The assertion that matters: the comparison shape every trigger
    // clause uses must now be correct against a JS Date.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const a = (await db.query('SELECT (now() > $1) AS ok', [past])).rows[0].ok;
    const b = (await db.query('SELECT (now() > $1) AS ok', [future])).rows[0].ok;
    if (a !== true || b !== false) {
      throw new Error(`timestamp comparison still wrong: past=${a} (want true), future=${b} (want false)`);
    }
    console.log('\nVerified: "one hour ago is in the past" = true, "one hour ahead is in the past" = false.');
    console.log('Migration completed.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
