require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration script to move prompt_id from column to config JSON
 */

async function runMigration() {
  try {
    console.log('🔄 Starting migration: move_prompt_id_to_config');

    // Initialize database connection
    await db.initialize();
    const drizzle = db.getDrizzle();

    // Read the SQL file
    const sqlPath = path.join(__dirname, 'move_prompt_id_to_config.sql');
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

    console.log('\n🎉 Migration completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
