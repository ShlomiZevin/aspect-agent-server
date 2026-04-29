require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  try {
    console.log('Migration 024: add quality_stats column to data_reload_runs');

    await db.initialize();
    const drizzle = db.getDrizzle();

    const sql = fs.readFileSync(path.join(__dirname, '024_add_quality_stats.sql'), 'utf8');
    const statements = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(s => s !== '');

    for (const statement of statements) {
      console.log(`Executing: ${statement.slice(0, 80)}...`);
      await drizzle.execute(statement);
      console.log('Done.');
    }

    console.log('\nMigration 024 completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
