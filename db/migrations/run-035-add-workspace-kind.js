require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  try {
    console.log('Starting migration: 035_add_workspace_kind');
    await db.initialize();
    const drizzle = db.getDrizzle();
    const sql = fs.readFileSync(path.join(__dirname, '035_add_workspace_kind.sql'), 'utf8');
    const statements = sql
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean);
    console.log(`Executing ${statements.length} SQL statements...`);
    for (let i = 0; i < statements.length; i++) {
      console.log(`\nExecuting statement ${i + 1}...`);
      await drizzle.execute(statements[i]);
      console.log('   Done.');
    }
    console.log('\nMigration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}
runMigration();
