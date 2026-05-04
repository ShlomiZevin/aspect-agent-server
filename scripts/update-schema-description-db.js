require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host:     process.env.ZER4U_DB_HOST,
  port:     parseInt(process.env.ZER4U_DB_PORT || 5432),
  database: process.env.ZER4U_DB_NAME,
  user:     process.env.ZER4U_DB_USER,
  password: process.env.ZER4U_DB_PASSWORD,
});

async function run() {
  const desc = fs.readFileSync(path.join(__dirname, '../data/zer4u-schema-description.txt'), 'utf8').trim();
  await pool.query(
    `INSERT INTO public.schema_descriptions (schema_name, description, generated_at)
     VALUES ('zer4u', $1, NOW())
     ON CONFLICT (schema_name) DO UPDATE SET description = EXCLUDED.description, generated_at = NOW()`,
    [desc]
  );
  console.log('Updated schema_descriptions in zer4u DB (' + desc.length + ' chars)');
  await pool.end();
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
