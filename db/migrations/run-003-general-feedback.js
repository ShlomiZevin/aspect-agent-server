require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Runs 003_general_feedback.sql — makes message_feedback usable for feedback
 * that is not attached to a specific message.
 *
 * Idempotent: every statement is IF NOT EXISTS / DROP-then-ADD, and the
 * backfill only touches rows whose agent_id is still NULL, so re-running is
 * safe. Executed as ONE transaction — a half-applied schema change here would
 * leave the constraint referring to a column that does not exist yet.
 */
async function runMigration() {
  await db.initialize();
  const pool = db.getPool ? db.getPool() : null;
  const sqlPath = path.join(__dirname, '003_general_feedback.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('🔄 Migration 003_general_feedback');

  const client = pool ? await pool.connect() : null;
  try {
    if (client) {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } else {
      // Fall back to the shared query helper when no raw pool is exposed.
      await db.query(sql);
    }

    const { rows } = await (client ? client.query.bind(client) : db.query.bind(db))(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE source = 'general')::int AS general,
             count(*) FILTER (WHERE agent_id IS NULL)::int AS unattributed
        FROM message_feedback`);
    const r = rows[0];
    console.log(`✅ Applied. feedback rows: ${r.total} (general: ${r.general}, without agent_id: ${r.unattributed})`);
    if (r.unattributed > 0) {
      console.log('   Note: rows without agent_id are message-scoped rows whose message or conversation no longer exists.');
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
  }
  process.exit(process.exitCode || 0);
}

runMigration();
