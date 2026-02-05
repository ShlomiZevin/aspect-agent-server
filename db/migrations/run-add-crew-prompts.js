require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration script to add crew_prompts table
 */

async function runMigration() {
  try {
    console.log('🔄 Starting migration: add_crew_prompts');

    // Initialize database connection
    await db.initialize();
    const drizzle = db.getDrizzle();

    // Read the SQL file
    const sqlPath = path.join(__dirname, '003_add_crew_prompts.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Remove comment lines, then split by semicolons
    const cleanSql = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    const statements = cleanSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s !== '');

    console.log(`📝 Executing ${statements.length} SQL statements...`);

    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.toLowerCase().includes('select')) {
        // For SELECT statements, show the results
        console.log(`\n📊 Query ${i + 1}:`);
        const result = await drizzle.execute(statement);
        console.table(result.rows);
      } else {
        console.log(`\n✅ Executing statement ${i + 1}...`);
        await drizzle.execute(statement);
        console.log(`   Done.`);
      }
    }

    // Verify table was created
    console.log('\n📊 Verifying table...');

    const tableCheck = await drizzle.execute(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'crew_prompts'
    `);
    console.log(`   crew_prompts: ${tableCheck.rows.length > 0 ? '✅ Created' : '❌ Not found'}`);

    console.log('\n🎉 Migration completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
