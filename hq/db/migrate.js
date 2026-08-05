/**
 * Lybi HQ — migration runner.
 *
 *   node hq/db/migrate.js
 *
 * Applies every .sql file in this folder in filename order. All statements are
 * idempotent (IF NOT EXISTS), so re-running is safe and is the normal way to
 * pick up a new migration file.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../../services/db.pg');

async function run() {
  await db.initialize();
  const drizzle = db.getDrizzle();

  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('No .sql files found in hq/db — nothing to do.');
    process.exit(0);
  }

  for (const file of files) {
    console.log(`\n▶ ${file}`);
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');

    // Strip comment-only lines, then split on `;`. Our migrations are plain
    // DDL — no functions or DO blocks — so this is safe here.
    const statements = sql
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean);

    for (let i = 0; i < statements.length; i++) {
      await drizzle.execute(statements[i]);
      process.stdout.write(`  ✓ ${i + 1}/${statements.length}\r`);
    }
    console.log(`  ✓ ${statements.length}/${statements.length} statements`);
  }

  console.log('\n✅ HQ migrations complete.');
  process.exit(0);
}

run().catch(err => {
  console.error('\n❌ HQ migration failed:', err.message);
  console.error(err);
  process.exit(1);
});
