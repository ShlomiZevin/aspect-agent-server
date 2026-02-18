require('dotenv').config({ path: './aspect-agent-server/.env' });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '35.240.73.50',
  port: 5432,
  database: 'agents_platform_db',
  user: 'agent_admin',
  password: 'mUywwyD7Td68PIsPZdPneih41'
});

async function checkStatus() {
  try {
    // Check schema exists
    const schemaCheck = await pool.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'zer4u'"
    );
    console.log('Schema exists:', schemaCheck.rows.length > 0 ? 'YES' : 'NO');

    if (schemaCheck.rows.length > 0) {
      // Check tables
      const tablesCheck = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'zer4u' ORDER BY table_name"
      );
      console.log('Tables count:', tablesCheck.rows.length);
      console.log('\nTables:');
      tablesCheck.rows.forEach((row, idx) => {
        console.log(`  ${idx + 1}. ${row.table_name}`);
      });

      // Check row counts for key tables
      console.log('\nRow counts:');
      for (const table of ['sales', 'arkot', 'calendar', 'hesbonithiuvi']) {
        try {
          const countResult = await pool.query(`SELECT COUNT(*) as count FROM zer4u.${table}`);
          console.log(`  ${table}: ${countResult.rows[0].count}`);
        } catch (e) {
          console.log(`  ${table}: ERROR - ${e.message}`);
        }
      }
    }

    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    await pool.end();
  }
}

checkStatus();
