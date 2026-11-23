#!/usr/bin/env node
/**
 * Copy one Builder agent's SETUP from one environment to another, reading
 * the SOURCE DATABASE directly (Shlomi's machine).
 * Skill: .claude/skills/copy-agent/SKILL.md · environments: builder/environments.js
 *
 *   node scripts/copy-agent-to-env.js <agent-slug> --from origin --to staging --dry
 *   node scripts/copy-agent-to-env.js <agent-slug> --from origin --to staging
 *   node scripts/copy-agent-to-env.js <agent-slug> --from origin --to staging --replace
 *
 *   --dry               print what would be copied; write nothing
 *   --replace           the agent already exists on the target (a copy — same
 *                       id): replace its setup with the source's (target
 *                       conversations are kept)
 *   --workspace <id>    put the agent in this target folder instead of
 *                       mirroring the source's folder chain
 *   --yes-production    required to write INTO an environment marked isProduction
 *
 * The engine is builder/services/agentCopy.js — the SAME one the Builder MCP
 * uses (`POST /builder/mcp/environments/<env>/agents/<slug>/copy`, which
 * reads the source through its API instead, no DB credentials). What is and
 * isn't copied is documented there.
 *
 * The source is only read. The target is written in ONE transaction — all
 * or nothing. Afterwards the agent is loaded through BOTH environments' APIs
 * and compared; any difference exits 1.
 */

const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { ENVIRONMENTS } = require('../builder/environments');
const agentCopy = require('../builder/services/agentCopy');

const ROOT = path.join(__dirname, '..');
const ids = ENVIRONMENTS.map(e => e.id);
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const flag = k => args.includes(k);
const optionValues = new Set(['--from', '--to', '--workspace'].map(opt).filter(Boolean));
const slug = args.find(a => !a.startsWith('--') && !optionValues.has(a));
const DRY = flag('--dry');
const REPLACE = flag('--replace');
const WORKSPACE = opt('--workspace');

function fail(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
const fromName = opt('--from');
const toName = opt('--to');
if (!slug || !fromName || !toName) fail(`usage: copy-agent-to-env.js <slug> --from <${ids.join('|')}> --to <${ids.join('|')}> [--dry] [--replace] [--workspace <id>] [--yes-production]`);
const FROM = ENVIRONMENTS.find(e => e.id === fromName);
const TO = ENVIRONMENTS.find(e => e.id === toName);
if (!FROM || !TO) fail(`unknown environment — known: ${ids.join(', ')} (builder/environments.js)`);
if (fromName === toName) fail('--from and --to are the same environment');
if (!FROM.db || !TO.db) fail(`no database entry for ${!FROM.db ? fromName : toName} in builder/environments.js`);
if (TO.isProduction && !flag('--yes-production')) fail(`"${toName}" is live (customers use it) — writing into it needs --yes-production (ask Shlomi first)`);

function creds(env) {
  const file = path.join(ROOT, env.db.credentialsFrom);
  if (!fs.existsSync(file)) fail(`missing ${env.db.credentialsFrom} (credentials for ${env.name})`);
  const e = Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { host: env.db.host, port: 5432, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 15000 };
}
const source = new Pool(creds(FROM));
const target = new Pool(creds(TO));
const rowsOf = pool => (sql, p = []) => pool.query(sql, p).then(r => r.rows);

(async () => {
  const bundle = await agentCopy.readFromDb(rowsOf(source), slug, { from: fromName });
  if (!bundle) fail(`no Builder agent "${slug}" in ${fromName}`);
  const { agent } = bundle;
  const t = await agentCopy.inspectTarget(rowsOf(target), bundle);
  if (t.state === 'different') fail(`"${slug}" in ${toName} is a DIFFERENT agent (id ${t.here.id} vs ${agent.id}) — not replacing it`);
  if (t.state === 'renamed') fail(`this agent is already in ${toName} under the slug "${t.here.slug}" — rename it back first`);
  if (t.state === 'copy' && !REPLACE) fail(`"${slug}" already exists in ${toName} — use --replace to refresh its setup`);
  if (t.state === 'copy' && t.hasLocalChanges) {
    console.log(`WARNING — --replace discards what was made in ${toName}:`);
    agentCopy.localChangesText(t.local).forEach(l => console.log(`  - ${l}`));
  }

  console.log(`${t.state === 'copy' ? 'REPLACING' : 'copying'} "${slug}" (${agent.id}) ${fromName} → ${toName}:`, JSON.stringify(agentCopy.planOf(bundle)));
  if (DRY) { await source.end(); await target.end(); return; }

  try {
    const { written } = await agentCopy.copyBundle({
      connect: () => target.connect(),
      bundle,
      existing: t.state === 'copy' ? t.here : null,
      placement: WORKSPACE ? { mode: 'workspace', workspaceId: WORKSPACE } : { mode: 'mirror' },
    });
    console.log('written:', JSON.stringify(written));
  } catch (err) {
    fail(err.message);
  }
  await source.end();
  await target.end();

  const [a, b] = await Promise.all([agentCopy.loadDocViaApi(FROM.server, slug), agentCopy.loadDocViaApi(TO.server, slug)]);
  const v = agentCopy.compareDocs(a, b, { fromName, toName });
  v.crews.forEach(c => console.log(`  ${c.same ? '✓' : '✗'} ${c.name}`));
  console.log(v.ok ? `VERIFIED — the agent loads identically from ${fromName} and ${toName}` : `NOT IDENTICAL — ${v.why || 'see crews above'}`);
  console.log(`open it: ${TO.app}/${slug}/builder`);
  process.exit(v.ok ? 0 : 1);
})().catch(err => fail(err.message));
