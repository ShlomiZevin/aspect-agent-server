require('dotenv').config();
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  try {
    console.log('🔄 Starting migration: add_prompt_fields');

    await db.initialize();
    const drizzle = db.getDrizzle();

    const sqlPath = path.join(__dirname, '014_add_prompt_fields.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const cleanSql = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    const statements = cleanSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s !== '');

    console.log(`📝 Executing ${statements.length} SQL statements...`);

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.toLowerCase().includes('select')) {
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
