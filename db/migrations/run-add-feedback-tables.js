require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

/**
 * Migration script to add feedback tables (message_feedback, feedback_tags)
 */

async function runMigration() {
  try {
    console.log('🔄 Starting migration: add_feedback_tables');

    // Initialize database connection
    await db.initialize();
    const drizzle = db.getDrizzle();

    // Read the SQL file
    const sqlPath = path.join(__dirname, '002_add_feedback_tables.sql');
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

    const feedbackTagsCheck = await drizzle.execute(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'feedback_tags'
    `);
    console.log(`   feedback_tags: ${feedbackTagsCheck.rows.length > 0 ? '✅ Created' : '❌ Not found'}`);

    const messageFeedbackCheck = await drizzle.execute(`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'message_feedback'
    `);
    console.log(`   message_feedback: ${messageFeedbackCheck.rows.length > 0 ? '✅ Created' : '❌ Not found'}`);

    console.log('\n🎉 Migration completed successfully!');
    process.exit(0);

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

runMigration();
