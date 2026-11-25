#!/usr/bin/env node
// Lybi Gate (beta) tables — see 074_gate.sql and aspect-agent-server/gate/.
//
//   node db/migrations/run-074-gate.js --env staging
//
// Safe to run twice. The environment is named explicitly and resolved from
// builder/environments.js (Cloud SQL public IP + the git-ignored env file with
// its credentials) — never the local .env, which points at Origin. Frozen
// environments (Origin) are refused. Run it per environment BEFORE deploying
// a server that mounts /api/gate.
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { ENVIRONMENTS } = require('../../builder/environments');

const ROOT = path.join(__dirname, '../..');
const args = process.argv.slice(2);
const envId = args[args.indexOf('--env') + 1];
const env = args.includes('--env') ? ENVIRONMENTS.find(e => e.id === envId) : null;

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }
if (!env) fail(`usage: run-074-gate.js --env <${ENVIRONMENTS.map(e => e.id).join('|')}>`);
if (env.frozen) fail(`${env.name} is frozen — it does not get new migrations`);
if (!env.db) fail(`no database entry for ${env.id} in builder/environments.js`);

const file = path.join(ROOT, env.db.credentialsFrom);
if (!fs.existsSync(file)) fail(`missing ${env.db.credentialsFrom} (credentials for ${env.name})`);
const e = Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const TABLES = ['gate_policy_versions', 'gate_keys', 'gate_bank_keys', 'gate_connections', 'gate_records', 'gate_log', 'gate_mockbank_keys'];

async function run() {
  const pool = new Pool({
    host: env.db.host, port: 5432, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 15000,
  });
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, '074_gate.sql'), 'utf8'));
    const counts = [];
    for (const t of TABLES) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts.push(`${t} (${rows[0].n})`);
    }
    console.log(`✅ Migration 074 applied on ${env.name}: ${counts.join(', ')}`);
  } catch (err) {
    fail(`Migration failed: ${err.message}`);
  } finally {
    await pool.end();
  }
}

run();
