/**
 * Seed the Social Supermarket agent row in the main agents table.
 *
 * The `url_slug` is what routes the whole product: the folder under agents/,
 * the schema in the data DB, the chat URL and the Intelligence dataset all
 * carry it. It follows the client's own domain, super-hist.co.il.
 *
 * Run: node scripts/seed-superhist-agent.js
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
    const existing = await pool.query("SELECT id, name FROM agents WHERE url_slug = 'superhist'");
    if (existing.rows.length > 0) {
      console.log('The Social Supermarket agent already exists (id=' + existing.rows[0].id + ')');
      return;
    }

    const result = await pool.query(
      `INSERT INTO agents (name, url_slug, domain, description, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name`,
      ['SuperHist', 'superhist', 'retail', 'The Social Supermarket (הסופר החברתי) — the Histadrut members-only online grocery', true]
    );
    console.log('Inserted The Social Supermarket agent:', result.rows[0]);
  } catch (err) {
    console.error('Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
