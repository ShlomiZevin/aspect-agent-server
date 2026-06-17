require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  try {
    console.log('Starting migration: 032_add_workspaces_and_archive');

    await db.initialize();
    const drizzle = db.getDrizzle();

    const sqlPath = path.join(__dirname, '032_add_workspaces_and_archive.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const cleanSql = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    const statements = cleanSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s !== '');

    console.log(`Executing ${statements.length} SQL statements...`);

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      console.log(`\nExecuting statement ${i + 1}...`);
      await drizzle.execute(statement);
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
