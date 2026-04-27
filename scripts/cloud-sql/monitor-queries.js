const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '35.240.73.50',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'agent_admin',
  password: process.env.DB_PASSWORD || 'mUywwyD7Td68PIsPZdPneih41',
  database: process.env.DB_NAME || 'agents_platform_db',
  max: 1,
  statement_timeout: 10000,
});

async function check() {
  try {
    const res = await pool.query(`
      SELECT pid, state, client_addr, now()-query_start as duration, left(query,120) as query
      FROM pg_stat_activity
      WHERE state='active' AND pid != pg_backend_pid()
    `);
    console.log(`\n=== ${new Date().toLocaleTimeString()} ===`);
    if (res.rows.length) console.table(res.rows);
    else console.log('All clear');
  } catch (e) {
    console.error('Error:', e.message);
  }
}

check();
setInterval(check, 30000);

process.on('SIGINT', async () => {
  await pool.end();
  process.exit();
});
