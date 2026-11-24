/**
 * Seed the Ofek Development (real-estate demo) agent row in the main agents table.
 * Run: node scripts/seed-realestate-agent.js
 *
 * Requires cloud-sql-proxy on DB_PORT (5432) for the main DB.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

(async () => {
  try {
    const existing = await pool.query("SELECT id, name FROM agents WHERE url_slug = 'realestate'");
    if (existing.rows.length > 0) {
      console.log('Real estate agent already exists (id=' + existing.rows[0].id + ')');
      return;
    }

    const result = await pool.query(
      `INSERT INTO agents (name, url_slug, domain, description, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name`,
      ['Real Estate', 'realestate', 'real-estate', 'Ofek Development - residential developer sales intelligence (demo)', true]
    );
    console.log('Inserted real estate agent:', result.rows[0]);
  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
