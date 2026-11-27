#!/usr/bin/env node
// pgvector becomes the knowledge-base store — see 075_kb_vectors_store.sql (board #1014).
//
//   node db/migrations/run-075-kb-vectors-store.js --env staging
//
// Safe to run twice; needs nothing before it (073 is folded in). The
// environment is named explicitly and resolved from builder/environments.js
// (Cloud SQL public IP + the git-ignored env file with its credentials), like
// scripts/copy-agent-to-env.js — never the local .env, which points at Origin.
// Frozen environments (Origin) are refused.
//
// Order per environment: this migration → scripts/kb-copy-from-pinecone.js
// (once, while the Pinecone key still works) → deploy the server that reads
// kb_vectors. A server without this table answers "the knowledge store is not
// set up" on every KB call instead of searching.
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { ENVIRONMENTS } = require('../../builder/environments');

const ROOT = path.join(__dirname, '../..');
const args = process.argv.slice(2);
const envId = args[args.indexOf('--env') + 1];
const env = args.includes('--env') ? ENVIRONMENTS.find(e => e.id === envId) : null;

function fail(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
if (!env) fail(`usage: run-075-kb-vectors-store.js --env <${ENVIRONMENTS.map(e => e.id).join('|')}>`);
if (env.frozen) fail(`${env.name} is frozen — it does not get new migrations`);
if (!env.db) fail(`no database entry for ${env.id} in builder/environments.js`);

const file = path.join(ROOT, env.db.credentialsFrom);
if (!fs.existsSync(file)) fail(`missing ${env.db.credentialsFrom} (credentials for ${env.name})`);
const e = Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const connect = () => new Pool({
  host: env.db.host, port: 5432, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 15000,
});

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '075_kb_vectors_store.sql'), 'utf8');
  const pool = connect();
  let ext, cols, idx, n, other;
  try {
    await pool.query('BEGIN');
    await pool.query(sql);
    await pool.query('COMMIT');
    ({ rows: [ext] } = await pool.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`));
    ({ rows: cols } = await pool.query(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'kb_vectors' ORDER BY ordinal_position`));
    ({ rows: idx } = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'kb_vectors' ORDER BY 1`));
    ({ rows: [n] } = await pool.query('SELECT count(*)::int AS n, count(DISTINCT namespace)::int AS kbs FROM kb_vectors'));
    ({ rows: [other] } = await pool.query(`SELECT
      (SELECT count(*) FROM kb_links WHERE index_name <> 'lybi')::int AS links,
      (SELECT count(*) FROM library_files WHERE index_name <> 'lybi')::int AS files`));
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    fail(`Migration failed (rolled back): ${err.message}`);
  } finally {
    await pool.end();
  }
  const names = cols.map(c => c.column_name);
  if (names.includes('index_name') || !names.includes('created_at')) fail(`kb_vectors is not in its final shape: ${names.join(', ')}`);
  if (cols.find(c => c.column_name === 'file_id').data_type !== 'character varying') fail('kb_vectors.file_id is not text');
  for (const want of ['kb_vectors_pkey', 'kb_vectors_namespace_file', 'kb_vectors_embedding_hnsw']) {
    if (!idx.some(i => i.indexname === want)) fail(`index ${want} is missing`);
  }
  if (other.links || other.files) fail(`rows outside the one library remain (kb_links ${other.links}, library_files ${other.files})`);
  // The database-level setting applies to NEW connections — check on a fresh one.
  const fresh = connect();
  const { rows: [s] } = await fresh.query(`SELECT current_setting('hnsw.iterative_scan', true) AS v`);
  await fresh.end();
  if (s.v !== 'strict_order') fail(`hnsw.iterative_scan is "${s.v}" on a new connection, expected strict_order`);
  console.log(`✅ Migration 075 applied on ${env.name}: vector ${ext.extversion}; kb_vectors (${n.n} rows in ${n.kbs} KBs) keyed (namespace, id), `
    + `indexes ${idx.map(i => i.indexname).join(', ')}; iterative scan on; kb_links / library_files all in library "lybi"`);
}

run();
