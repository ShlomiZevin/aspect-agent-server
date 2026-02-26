require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST_PROXY,
  port: parseInt(process.env.DB_PORT_PROXY || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function run() {
  const client = await pool.connect();
  try {
    // Check agents
    const agents = await client.query("SELECT id, name FROM agents WHERE name ILIKE '%freeda%' LIMIT 5");
    console.log('Agents:', JSON.stringify(agents.rows));

    if (agents.rows.length > 0) {
      const agentId = agents.rows[0].id;
      // Check KBs
      const kbs = await client.query(
        'SELECT id, name, provider, vector_store_id, google_corpus_id, file_count FROM knowledge_bases WHERE agent_id = $1',
        [agentId]
      );
      console.log('KBs:', JSON.stringify(kbs.rows, null, 2));
    }
  } finally {
    client.release();
    await pool.end();
  }
}
run().catch(e => { console.error(e.message); process.exit(1); });
