require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const connection = require('../connection');

/** Applies 003_drop_domain_and_crew.sql. Idempotent; needs the Cloud SQL Proxy. */
async function run() {
  console.log(`Applying 003_drop_domain_and_crew.sql to ${connection.DB_NAME}`);
  await connection.query(fs.readFileSync(path.join(__dirname, '003_drop_domain_and_crew.sql'), 'utf8'));

  const { rows } = await connection.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks' ORDER BY ordinal_position`);
  console.log('  tasks columns:', rows.map(r => r.column_name).join(', '));

  await connection.close();
  console.log('Done.');
}

run().catch(async err => {
  console.error('Migration failed:', err.message);
  await connection.close().catch(() => {});
  process.exit(1);
});
