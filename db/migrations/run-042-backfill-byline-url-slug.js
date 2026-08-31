require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Runner for 042_backfill_byline_url_slug.sql. Idempotent; run it through the
 * Cloud SQL Proxy like every other migration here.
 */
async function runMigration() {
  try {
    console.log('Starting migration: 042_backfill_byline_url_slug');
    await db.initialize();
    const drizzle = db.getDrizzle();
    const rows = r => r.rows || r;

    const before = rows(await drizzle.execute(
      `SELECT count(*)::int AS n FROM agents WHERE url_slug IS NULL`))[0].n;
    console.log(`  agents with no url_slug before: ${before}`);

    const sql = fs.readFileSync(path.join(__dirname, '042_backfill_byline_url_slug.sql'), 'utf8');
    const statements = sql
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean);

    for (const statement of statements) await drizzle.execute(statement);

    const after = rows(await drizzle.execute(
      `SELECT id, name, url_slug FROM agents WHERE lower(name) = 'byline'`));
    for (const r of after) console.log(`  #${r.id} "${r.name}" -> url_slug=${r.url_slug}`);

    const stillNull = rows(await drizzle.execute(
      `SELECT count(*)::int AS n FROM agents WHERE url_slug IS NULL`))[0].n;
    console.log(`  agents with no url_slug after: ${stillNull}`);

    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
