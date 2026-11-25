#!/usr/bin/env node
/**
 * Lybi Gate — a standalone local harness. NOT server.js: it boots only
 * express + the gate router (+ the mock bank), so no platform background
 * service (trigger clock, reloads, schedulers) ever starts against the
 * environment's database.
 *
 *   TZ=UTC node gate/harness.js --env staging [--port 3917]
 *
 * The environment is named explicitly (builder/environments.js → its Cloud SQL
 * public IP + its git-ignored env file). Never the local .env (Origin). The
 * management-center door is replaced by a fixed local identity
 * ("harness@local"); the inbound endpoint keeps its real key check.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { ENVIRONMENTS } = require('../builder/environments');

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }
const args = process.argv.slice(2);
const opt = n => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const env = ENVIRONMENTS.find(e => e.id === opt('--env'));
if (!env) fail(`usage: TZ=UTC node gate/harness.js --env <${ENVIRONMENTS.map(e => e.id).join('|')}> [--port N]`);
if (env.frozen) fail(`${env.name} is frozen`);
if (!env.db) fail(`no database entry for ${env.id}`);
if (process.env.TZ !== 'UTC') fail('run with TZ=UTC (our timestamps are without time zone)');
const port = Number(opt('--port') || 3917);
if (port === 3000) fail('use a port other than 3000');

const file = path.join(__dirname, '..', env.db.credentialsFrom);
if (!fs.existsSync(file)) fail(`missing ${env.db.credentialsFrom}`);
const vars = Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
for (const k of ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'GATE_TOKEN_KEY', 'GATE_SECRET_KEY', 'GATE_SIGNING_KEY']) {
  if (vars[k]) process.env[k] = vars[k];
}
// The environment's database over its public IP (the env file's DB_HOST is Cloud Run's socket).
Object.assign(process.env, { DB_HOST: env.db.host, DB_PORT: '5432', DB_SSL: 'true', DB_POOL_MAX: '3', DB_POOL_MIN: '0' });

(async () => {
  const db = require('../services/db.pg');
  await db.initialize();
  const { createGateRouter } = require('./routes');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/gate', createGateRouter({
    requireAdmin: (req, _res, next) => { req.gateActor = 'harness@local'; next(); },
  }));
  app.listen(port, '127.0.0.1', () => console.log(`Lybi Gate harness on http://127.0.0.1:${port}/api/gate — ${env.name} database (gate_* tables only)`));
})().catch(err => fail(err.message));
