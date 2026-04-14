/**
 * One-shot script: insert the OneZero agent row if missing.
 * Run from aspect-agent-server: `node scripts/seed-onezero-agent.js`
 */
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    const existing = await pool.query("SELECT id, name FROM agents WHERE name = 'OneZero'");
    if (existing.rows.length > 0) {
      console.log('✓ OneZero agent already exists:', existing.rows[0]);
      return;
    }

    const result = await pool.query(
      `INSERT INTO agents (name, url_slug, domain, description, is_active)
       VALUES ('OneZero', 'onezero', 'banking', 'ONE ZERO digital bank churn prediction demo', true)
       RETURNING id, name`
    );
    console.log('✓ Inserted OneZero agent:', result.rows[0]);
  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
