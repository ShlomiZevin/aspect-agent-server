/**
 * Migration 027b: Backfill tasks.deployed_email_sent_to
 *
 * Marks every already-deployed task as "already emailed" to all three current
 * recipients (Shlomi, Noa, Kosta). Prevents the anti-spam-equipped scheduler
 * from re-sending the long backlog that the pre-anti-spam revision already
 * delivered.
 *
 * Idempotent: only writes rows whose deployed_email_sent_to is currently
 * empty / NULL.
 *
 * Requires Cloud SQL Proxy running.
 *
 * Run:
 *   node db/migrations/run-027b-backfill-deployed-email-sent-to.js
 */

require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');

async function run() {
  const pool = new Pool({
    host: process.env.DB_HOST_PROXY || '127.0.0.1',
    port: parseInt(process.env.DB_PORT_PROXY || '5432'),
    database: process.env.DB_NAME || 'agents_platform_db',
    user: process.env.DB_USER || 'agent_admin',
    password: process.env.DB_PASSWORD,
  });

  try {
    console.log('Running migration 027b: backfill deployed_email_sent_to ...');

    const result = await pool.query(`
      UPDATE tasks
      SET deployed_email_sent_to = '["Shlomi","Noa","Kosta"]'::jsonb
      WHERE deployed_at IS NOT NULL
        AND COALESCE(deployed_email_sent_to, '[]'::jsonb) = '[]'::jsonb
      RETURNING id
    `);

    console.log(`Done: backfilled ${result.rowCount} task(s).`);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
