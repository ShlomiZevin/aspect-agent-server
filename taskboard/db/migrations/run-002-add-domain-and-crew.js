require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const connection = require('../connection');

/** Applies 002_add_domain_and_crew.sql. Idempotent; needs the Cloud SQL Proxy. */
async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '002_add_domain_and_crew.sql'), 'utf8');
  console.log(`Applying 002_add_domain_and_crew.sql to ${connection.DB_NAME}`);

  await connection.query(sql);

  const { rows } = await connection.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks'
        AND column_name IN ('domain', 'crew_member')
      ORDER BY column_name`);
  for (const r of rows) {
    console.log(`  ${r.column_name.padEnd(12)} ${r.data_type} nullable=${r.is_nullable} default=${r.column_default}`);
  }

  await connection.close();
  console.log('Done.');
}

run().catch(async err => {
  console.error('Migration failed:', err.message);
  await connection.close().catch(() => {});
  process.exit(1);
});
