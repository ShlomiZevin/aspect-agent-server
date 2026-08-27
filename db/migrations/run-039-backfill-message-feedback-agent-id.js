/**
 * Migration 039 (data-only, no schema change): backfill agent_id on
 * message_feedback rows where it's NULL.
 *
 * Root cause: feedback.service.js's createFeedback() resolved agentId (via
 * message -> conversation -> agent) only to register the tag, and never
 * included it in the messageFeedback insert. Every message-scoped feedback
 * row landed with agent_id = NULL, invisible to the agent-scoped admin
 * Feedback page (filters WHERE agent_id = ...). Old rows were backfilled once
 * before; this fixes the same gap that reappeared for new rows (e.g. the
 * 2026-08-27 "Reject answer" submission, message_feedback.id 45). The insert
 * itself is now fixed at the source in feedback.service.js — this migration
 * only repairs rows already written before that fix landed.
 *
 * Run via Cloud SQL Proxy:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *   node db/migrations/run-039-backfill-message-feedback-agent-id.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST_PROXY || '127.0.0.1',
  port: process.env.DB_PORT_PROXY || 5432,
  database: process.env.DB_NAME || 'agents_platform_db',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: false,
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running migration 039: backfill message_feedback.agent_id where NULL...');

    const before = await client.query(`SELECT id FROM message_feedback WHERE agent_id IS NULL`);
    console.log(`Found ${before.rows.length} row(s) with NULL agent_id:`, before.rows.map(r => r.id));

    const result = await client.query(`
      UPDATE message_feedback mf
      SET agent_id = c.agent_id,
          updated_at = NOW()
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE mf.assistant_message_id = m.id
        AND mf.agent_id IS NULL
        AND c.agent_id IS NOT NULL
      RETURNING mf.id, mf.agent_id;
    `);

    console.log(`Backfilled ${result.rows.length} row(s):`, result.rows);

    const remaining = await client.query(`SELECT id, source FROM message_feedback WHERE agent_id IS NULL`);
    if (remaining.rows.length > 0) {
      console.log(`⚠️  ${remaining.rows.length} row(s) still NULL (no resolvable conversation/agent — likely 'general' source with a missing agentId, needs manual look):`, remaining.rows);
    } else {
      console.log('✅ No remaining NULL agent_id rows.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
