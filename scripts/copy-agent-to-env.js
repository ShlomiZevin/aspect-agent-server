#!/usr/bin/env node
/**
 * Copy one Builder agent's SETUP from one environment to another.
 * Skill: .claude/skills/copy-agent/SKILL.md · environments: scripts/environments.json
 *
 *   node scripts/copy-agent-to-env.js <agent-slug> --from origin --to staging --dry
 *   node scripts/copy-agent-to-env.js <agent-slug> --from origin --to staging
 *   node scripts/copy-agent-to-env.js <agent-slug> --from origin --to staging --replace
 *
 *   --dry             print what would be copied; write nothing
 *   --replace         the agent already exists on the target: replace its setup
 *                     with the source's (target conversations are kept)
 *   --yes-production  required to write INTO an environment marked isProduction
 *
 * Copied (the setup — what you see in the Builder):
 *   folders (the agent's folder + parents), project, agent, every agent version,
 *   every crew + crew version, knowledge-base links + their file records
 *   (library_files — vectors stay in Pinecone; same index/namespace), the change
 *   history (agent_log), and the legacy `agents` row its conversations hang off.
 * NOT copied (data): conversations, messages, add-on runs, memory, customer
 *   users, feedback, trigger runtime state.
 *
 * Builder rows keep their text ids (versions, crews, links line up). Auto-numbered
 * tables get fresh ids on the target. The source is only read. The target is
 * written in ONE transaction — all or nothing. Afterwards the agent is loaded
 * through BOTH environments' APIs and compared; any difference exits 1.
 *
 * Copying INTO production is possible but gated (--yes-production) and the
 * skill says to ask Shlomi first.
 */

const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const ENVS = JSON.parse(fs.readFileSync(path.join(__dirname, 'environments.json'), 'utf8'));
const args = process.argv.slice(2);
const slug = args.find(a => !a.startsWith('--') && !Object.keys(ENVS).includes(a));
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const flag = k => args.includes(k);
const DRY = flag('--dry');
const REPLACE = flag('--replace');

function fail(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
const names = Object.keys(ENVS).filter(k => !k.startsWith('_'));
const fromName = opt('--from');
const toName = opt('--to');
if (!slug || !fromName || !toName) fail(`usage: copy-agent-to-env.js <slug> --from <${names.join('|')}> --to <${names.join('|')}> [--dry] [--replace] [--yes-production]`);
if (!ENVS[fromName] || !ENVS[toName]) fail(`unknown environment — known: ${names.join(', ')} (scripts/environments.json)`);
if (fromName === toName) fail('--from and --to are the same environment');
const FROM = ENVS[fromName];
const TO = ENVS[toName];
if (TO.isProduction && !flag('--yes-production')) fail(`"${toName}" is live (customers use it) — writing into it needs --yes-production (ask Shlomi first)`);

function creds(env) {
  const file = path.join(ROOT, env.credentialsFrom);
  if (!fs.existsSync(file)) fail(`missing ${env.credentialsFrom} (credentials for ${env.label})`);
  const e = Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(l => /^[A-Z0-9_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { host: env.dbHost, port: 5432, database: e.DB_NAME, user: e.DB_USER, password: e.DB_PASSWORD, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 15000 };
}
const source = new Pool(creds(FROM));
const target = new Pool(creds(TO));
const q = (pool, sql, p = []) => pool.query(sql, p).then(r => r.rows);

const asParam = v => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v);

/**
 * mode: 'keep'   — ON CONFLICT DO NOTHING (keep what the target has)
 *       'update' — ON CONFLICT (id) DO UPDATE (the source wins)
 *       'fresh'  — drop the id, let the target number it
 */
async function insertRows(client, table, rows, mode = 'keep') {
  let n = 0;
  for (const row of rows) {
    const r = { ...row };
    if (mode === 'fresh') delete r.id;
    const cols = Object.keys(r);
    const conflict = mode === 'keep' ? ' ON CONFLICT DO NOTHING'
      : mode === 'update' ? ` ON CONFLICT (id) DO UPDATE SET ${cols.filter(c => c !== 'id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')}`
        : '';
    const res = await client.query(
      `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})${conflict}`,
      cols.map(c => asParam(r[c])),
    );
    n += res.rowCount;
  }
  return n;
}

/** The agent as each environment's own Builder API serves it — compared after the copy. */
async function verify() {
  const get = env => fetch(`${env.apiUrl}/api/builder/projects?agentSlug=${encodeURIComponent(slug)}&ownerUserId=copy-check`).then(r => r.json());
  const norm = o => JSON.stringify(o, (k, v) => (k === 'ownerUserId' || k === 'updatedAt' ? undefined : v));
  const [a, b] = await Promise.all([get(FROM), get(TO)]);
  if (!a.agents || !b.agents) return { ok: false, why: `could not load the agent from ${!a.agents ? fromName : toName}` };
  const crews = a.agents[0].crews.map(c => {
    const d = b.agents[0].crews.find(x => x.id === c.id);
    return { name: c.name, same: !!d && norm(c) === norm(d) };
  });
  return { ok: norm(a) === norm(b), crews };
}

(async () => {
  const [agent] = await q(source, 'SELECT * FROM builder_agents WHERE slug = $1', [slug]);
  if (!agent) fail(`no Builder agent "${slug}" in ${fromName}`);
  const [existing] = await q(target, 'SELECT id FROM builder_agents WHERE slug = $1', [slug]);
  if (existing && !REPLACE) fail(`"${slug}" already exists in ${toName} — use --replace to refresh its setup`);
  if (existing && existing.id !== agent.id) fail(`"${slug}" in ${toName} is a DIFFERENT agent (id ${existing.id} vs ${agent.id}) — not replacing it`);

  const folders = agent.workspace_id ? await q(source, `WITH RECURSIVE w AS (
      SELECT *, 1 AS lvl FROM builder_workspaces WHERE id = $1
      UNION ALL SELECT p.*, w.lvl + 1 FROM builder_workspaces p JOIN w ON p.id = w.parent_id)
    SELECT * FROM w ORDER BY lvl DESC`, [agent.workspace_id]) : [];
  folders.forEach(f => delete f.lvl);
  const project = await q(source, 'SELECT * FROM builder_projects WHERE id = $1', [agent.project_id]);
  const agentVersions = await q(source, 'SELECT * FROM builder_agent_versions WHERE agent_id = $1 ORDER BY created_at', [agent.id]);
  const crews = await q(source, 'SELECT * FROM builder_crews WHERE agent_id = $1', [agent.id]);
  const crewVersions = await q(source, 'SELECT * FROM builder_crew_versions WHERE crew_id = ANY($1) ORDER BY created_at', [crews.map(c => c.id)]);
  const kbLinks = await q(source, 'SELECT * FROM kb_links WHERE agent_id = $1', [agent.id]);
  const libraryFiles = kbLinks.length
    ? await q(source, `SELECT DISTINCT f.* FROM library_files f
        JOIN unnest($1::text[], $2::text[]) AS k(index_name, namespace)
          ON f.index_name = k.index_name AND f.namespace = k.namespace`,
      [kbLinks.map(k => k.index_name), kbLinks.map(k => k.namespace)])
    : [];
  const agentLog = await q(source, 'SELECT * FROM agent_log WHERE agent_id = $1 ORDER BY applied_at', [agent.id]);
  const legacy = await q(source, 'SELECT * FROM agents WHERE url_slug = $1', [slug]);

  const plan = {
    folders: folders.length, project: project.length, agent: 1, agentVersions: agentVersions.length,
    crews: crews.length, crewVersions: crewVersions.length, kbLinks: kbLinks.length,
    libraryFiles: libraryFiles.length, agentLog: agentLog.length, legacyAgentRow: legacy.length,
  };
  console.log(`${REPLACE && existing ? 'REPLACING' : 'copying'} "${slug}" (${agent.id}) ${fromName} → ${toName}:`, JSON.stringify(plan));
  if (DRY) { await source.end(); await target.end(); return; }

  const client = await target.connect();
  try {
    await client.query('BEGIN');
    if (existing) {
      // Clear the target's setup for this agent; its conversations stay.
      await client.query('DELETE FROM builder_crew_versions WHERE crew_id IN (SELECT id FROM builder_crews WHERE agent_id = $1)', [agent.id]);
      await client.query('DELETE FROM builder_crews WHERE agent_id = $1', [agent.id]);
      await client.query('DELETE FROM builder_agent_versions WHERE agent_id = $1', [agent.id]);
      await client.query('DELETE FROM kb_links WHERE agent_id = $1', [agent.id]);
      await client.query('DELETE FROM agent_log WHERE agent_id = $1', [agent.id]);
      await client.query('DELETE FROM builder_agents WHERE id = $1', [agent.id]);
    }
    const shell = existing ? 'update' : 'keep';
    const done = {
      folders: await insertRows(client, 'builder_workspaces', folders, shell),
      project: await insertRows(client, 'builder_projects', project, shell),
      agent: await insertRows(client, 'builder_agents', [agent], 'keep'),
      agentVersions: await insertRows(client, 'builder_agent_versions', agentVersions, 'keep'),
      crews: await insertRows(client, 'builder_crews', crews, 'keep'),
      crewVersions: await insertRows(client, 'builder_crew_versions', crewVersions, 'keep'),
      kbLinks: await insertRows(client, 'kb_links', kbLinks, 'fresh'),
      agentLog: await insertRows(client, 'agent_log', agentLog, 'fresh'),
      libraryFiles: 0,
      legacyAgentRow: 0,
    };
    // File records: only those the target doesn't have yet (several agents can share a namespace).
    for (const f of libraryFiles) {
      const [has] = (await client.query('SELECT 1 FROM library_files WHERE index_name = $1 AND namespace = $2 AND file_id = $3', [f.index_name, f.namespace, f.file_id])).rows;
      if (!has) done.libraryFiles += await insertRows(client, 'library_files', [f], 'fresh');
    }
    // The legacy agents row: only if the target has none (its conversations point at it).
    const [hasLegacy] = (await client.query('SELECT 1 FROM agents WHERE url_slug = $1', [slug])).rows;
    if (!hasLegacy) done.legacyAgentRow = await insertRows(client, 'agents', legacy, 'fresh');
    await client.query('COMMIT');
    console.log('written:', JSON.stringify(done));
  } catch (err) {
    await client.query('ROLLBACK');
    fail(`${err.message} (rolled back — the target is unchanged)`);
  } finally {
    client.release();
  }
  await source.end();
  await target.end();

  const v = await verify();
  if (v.crews) v.crews.forEach(c => console.log(`  ${c.same ? '✓' : '✗'} ${c.name}`));
  console.log(v.ok ? `VERIFIED — the agent loads identically from ${fromName} and ${toName}` : `NOT IDENTICAL — ${v.why || 'see crews above'}`);
  console.log(`open it: ${TO.siteUrl}/${slug}/builder`);
  process.exit(v.ok ? 0 : 1);
})().catch(err => fail(err.message));
