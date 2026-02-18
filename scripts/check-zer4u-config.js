/**
 * Check Zer4U Crew Member Configuration
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

async function checkZer4uConfig() {
  try {
    // First, check table structure
    const schemaResult = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'crew_members'
      ORDER BY ordinal_position
    `);

    console.log('📊 crew_members table columns:');
    schemaResult.rows.forEach(r => console.log(`  - ${r.column_name}`));
    console.log('');

    // Now query crew members
    const result = await pool.query(`
      SELECT *
      FROM crew_members
      WHERE LOWER(name) LIKE '%zer4u%'
      OR LOWER(name) LIKE '%zer%'
    `);

    if (result.rows.length === 0) {
      console.log('❌ No Zer4U crew member found!\n');
      console.log('Checking all crew members...\n');

      const allCrew = await pool.query('SELECT * FROM crew_members ORDER BY name LIMIT 10');
      console.log('Available crew members:');
      allCrew.rows.forEach(c => {
        console.log(`  - ${c.name} (ID: ${c.id})`);
      });
    } else {
      result.rows.forEach(crew => {
        console.log('\n' + '═'.repeat(80));
        console.log(`📋 CREW MEMBER: ${crew.name}`);
        console.log('═'.repeat(80));
        console.log(`ID: ${crew.id}`);
        console.log(`Created: ${crew.created_at || 'N/A'}`);
        console.log('\n📝 ACTIVE PROMPT:');
        console.log('─'.repeat(80));

        const promptField = crew.active_version_prompt || crew.prompt || crew.system_prompt;
        if (promptField) {
          console.log(promptField);
        } else {
          console.log('❌ NO PROMPT CONFIGURED!');
          console.log('\nAvailable fields:', Object.keys(crew));
        }

        console.log('─'.repeat(80));
      });
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkZer4uConfig();
