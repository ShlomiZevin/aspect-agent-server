#!/usr/bin/env node
// pgvector + kb_vectors (proof of concept) — see 073_pgvector_kb_vectors.sql.
//
//   node db/migrations/run-073-pgvector-kb-vectors.js --env staging
//
// Safe to run twice. The environment is named explicitly and resolved from
// builder/environments.js (Cloud SQL public IP + the git-ignored env file with
// its credentials), like scripts/copy-agent-to-env.js — never the local .env,
// which points at Origin. Frozen environments (Origin) are refused.
// Run it per environment BEFORE deploying the server that reads the table.
// Superseded by 075 (board #1014), which puts kb_vectors in its final shape
// and needs nothing before it: a NEW environment runs run-075 only.
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { ENVIRONMENTS } = require('../../builder/environments');

const ROOT = path.join(__dirname, '../..');
const args = process.argv.slice(2);
const envId = args[args.indexOf('--env') + 1];
const env = args.includes('--env') ? ENVIRONMENTS.find(e => e.id === envId) : null;

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }
if (!env) fail(`usage: run-073-pgvector-kb-vectors.js --env <${ENVIRONMENTS.map(e => e.id).join('|')}>`);
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
  const sql = fs.readFileSync(path.join(__dirname, '073_pgvector_kb_vectors.sql'), 'utf8');
  const pool = connect();
  let ext, n;
  try {
    await pool.query(sql);
    ({ rows: [ext] } = await pool.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`));
    ({ rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM kb_vectors'));
  } catch (err) {
    fail(`Migration failed: ${err.message}`);
  } finally {
    await pool.end();
  }
  // The database-level setting applies to NEW connections — check on a fresh one.
  const fresh = connect();
  const { rows: [s] } = await fresh.query(`SELECT current_setting('hnsw.iterative_scan', true) AS v`);
  await fresh.end();
  if (s.v !== 'strict_order') fail(`hnsw.iterative_scan is "${s.v}" on a new connection, expected strict_order`);
  console.log(`✅ Migration 073 applied on ${env.name}: vector ${ext.extversion}, kb_vectors (${n.n} rows) + HNSW cosine index, iterative scan on`);
}

run();
