require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration script to add profiler crew and context tables (context_data, user_symptoms)
 */

async function runMigration() {
  try {
    console.log('🔄 Starting migration: add_profiler_crew_and_context_tables');

    // Initialize database connection
    await db.initialize();
    const drizzle = db.getDrizzle();

    // Read the SQL file
    const sqlPath = path.join(__dirname, '004_add_profiler_crew_and_context_tables.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Split by semicolons and filter out empty statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--') && s !== '');

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

    // Verify tables were created
    console.log('\n📊 Verifying tables...');

    const contextDataCheck = await drizzle.execute(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'context_data'
    `);
    console.log(`   context_data: ${contextDataCheck.rows.length > 0 ? '✅ Created' : '❌ Not found'}`);

    const userSymptomsCheck = await drizzle.execute(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'user_symptoms'
    `);
    console.log(`   user_symptoms: ${userSymptomsCheck.rows.length > 0 ? '✅ Created' : '❌ Not found'}`);

    console.log('\n🎉 Migration completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
