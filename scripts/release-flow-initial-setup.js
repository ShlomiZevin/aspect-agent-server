#!/usr/bin/env node
/**
 * One-time setup for the task board release flow (task #837). Run once, after migration 053.
 *
 *   1. Noa, Hila and Shlomi get a What's New watermark ("seen until") = now, so their popup
 *      starts empty. People without a watermark never get the popup.
 *   2. Every task that is Done and was never deployed is marked Not for release, so the
 *      Release list starts empty. Moving one out of Done and back puts it on the list again.
 *
 * Dry by default. Pass --apply to write. Refuses to run a second time (a watermark is
 * already set) unless --force.
 *
 *   node scripts/release-flow-initial-setup.js
 *   node scripts/release-flow-initial-setup.js --apply
 */
const path = require('path');
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: path.join(__dirname, '..', envFile) });

const { Pool } = require('pg');

const PEOPLE = ['Noa', 'Hila', 'Shlomi'];

async function run() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const lowerPeople = PEOPLE.map(p => p.toLowerCase());

  const pool = new Pool({
    host: process.env.DB_HOST_PROXY || process.env.DB_HOST,
    port: process.env.DB_PORT_PROXY || process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  const client = await pool.connect();
  try {
    const people = await client.query(
      `SELECT name, seen_until FROM task_assignees WHERE lower(name) = ANY($1::text[]) ORDER BY name`,
      [lowerPeople]
    );
    console.log('People:');
    for (const r of people.rows) console.log(`  ${r.name}: seen_until = ${r.seen_until ?? '(none)'}`);
    const missing = PEOPLE.filter(p => !people.rows.some(r => r.name.toLowerCase() === p.toLowerCase()));
    if (missing.length) console.log(`  not on the roster yet (will be added): ${missing.join(', ')}`);

    const backlog = await client.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'done' AND deployed_at IS NULL AND not_for_release = FALSE`
    );
    console.log(`Done tasks never deployed → Not for release: ${backlog.rows[0].n}`);

    if (!apply) {
      console.log('\nDry run. Pass --apply to write.');
      return;
    }

    const alreadySet = people.rows.filter(r => r.seen_until);
    if (alreadySet.length && !force) {
      console.error(`\nRefusing: ${alreadySet.map(r => r.name).join(', ')} already have a watermark, so setup already ran. Pass --force to run anyway.`);
      process.exitCode = 1;
      return;
    }

    await client.query('BEGIN');
    for (const name of missing) {
      await client.query(`INSERT INTO task_assignees (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
    }
    // Drizzle stores these (timezone-less) timestamps as UTC wall time, so the watermark must be too.
    const watermarks = await client.query(
      `UPDATE task_assignees SET seen_until = (NOW() AT TIME ZONE 'UTC')
       WHERE lower(name) = ANY($1::text[]) RETURNING name, seen_until`,
      [lowerPeople]
    );
    const flagged = await client.query(
      `UPDATE tasks SET not_for_release = TRUE
       WHERE status = 'done' AND deployed_at IS NULL AND not_for_release = FALSE`
    );
    await client.query('COMMIT');

    console.log('\n✅ Applied');
    for (const r of watermarks.rows) console.log(`  ${r.name}: seen_until = ${r.seen_until}`);
    console.log(`  ${flagged.rowCount} task(s) marked Not for release`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Setup failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
