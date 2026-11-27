/**
 * The Builder MCP's copy door: list another environment's agents and copy
 * one INTO this environment (`/builder/mcp/environments/...`).
 *
 * The engine is `agentCopy.js` — the same one `scripts/copy-agent-to-env.js`
 * runs. This file only adds what the door needs:
 *
 *   - the SOURCE is read through its public Builder API (the server URL in
 *     `builder/environments.js`) — no database credentials of another
 *     environment ever live on this server;
 *   - the TARGET is always this server's own database;
 *   - the guards: never into an environment marked isProduction, never
 *     from itself, never on a server that does not know which environment
 *     it is (a local server sets LYBI_ENV);
 *   - placement: the folder the caller names, else the environment's
 *     `copyInto` folder (staging: the "Shlomi" domain); a refresh keeps
 *     the copy where it already is;
 *   - slug clashes: the same agent (a copy) is refreshed — automatically
 *     when nothing made here would be lost, only with `refresh: true`
 *     otherwise; a different agent with the slug is never touched;
 *   - the answer in words, ending with VERIFIED / NOT IDENTICAL.
 */

const environments = require('../environments');
const agentCopy = require('./agentCopy');
const builderProjects = require('./builderProjects');
const db = require('../../services/db.pg');

const q = (sql, params = []) => db.query(sql, params).then(r => r.rows);

/** A refusal with its HTTP status and a sentence saying what to do next. */
class CopyRefused extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const known = () => environments.ENVIRONMENTS.map(e => `${e.id} (${e.name})`).join(', ');

/** The source environment, refused when unknown or when it is this one. */
function sourceOf(envId, origin) {
  const env = environments.findEnvironment(envId);
  if (!env) throw new CopyRefused(404, `No environment "${envId}". Known: ${known()} — GET ../environments for the list.`);
  const here = environments.currentEnvironment(origin);
  if (here && here.id === env.id) {
    throw new CopyRefused(400, `"${env.id}" is this environment — its agents are at /agents here. Name another environment.`);
  }
  return { env, here };
}

/** Folder id → "Banking / Credit cards". */
function folderPaths(rows) {
  const byId = new Map(rows.map(w => [w.id, w]));
  const pathOf = id => {
    const parts = [];
    for (let w = byId.get(id); w && parts.length < 10; w = byId.get(w.parentId ?? w.parent_id)) parts.unshift(w.name);
    return parts.join(' / ');
  };
  return { byId, pathOf };
}

async function localFolders() {
  return q('SELECT id, name, kind, parent_id FROM builder_workspaces');
}

/** Resolve a folder given by id or exact name (any case) on THIS environment. */
async function resolveWorkspace(given) {
  const rows = await localFolders();
  const { pathOf } = folderPaths(rows);
  const g = String(given).trim();
  const byId = rows.find(w => w.id === g);
  if (byId) return { id: byId.id, path: pathOf(byId.id) };
  const byName = rows.filter(w => (w.name || '').toLowerCase() === g.toLowerCase());
  if (byName.length === 1) return { id: byName[0].id, path: pathOf(byName[0].id) };
  const list = rows.filter(w => w.kind === 'domain' || w.kind === 'project')
    .map(w => `${pathOf(w.id)} (${w.id})`).sort().join('; ');
  throw new CopyRefused(byName.length ? 409 : 404, byName.length
    ? `More than one folder here is called "${g}": ${byName.map(w => `${pathOf(w.id)} (${w.id})`).join('; ')}. Pass the id.`
    : `No folder "${g}" on this environment. Folders: ${list || 'none'}. Pass a name or an id, or leave "workspace" out for the default.`);
}

/** Where a NEW copy lands when the caller names no folder. */
async function defaultPlacement(here) {
  const want = here && here.copyInto && here.copyInto.workspaceId;
  if (!want) return { id: null, path: 'the top level' };
  const rows = await localFolders();
  if (!rows.some(w => w.id === want)) return { id: null, path: `the top level (the "${here.copyInto.workspaceName}" folder is missing here)` };
  return { id: want, path: folderPaths(rows).pathOf(want) };
}

async function readSource(env, slug) {
  let bundle;
  try {
    bundle = await agentCopy.readFromApi(env.server, slug, { from: env.id });
  } catch (err) {
    throw new CopyRefused(502, `Could not read "${slug}" from ${env.name}: ${err.message}. Try again; if it persists, ${env.name}'s server may be down.`);
  }
  if (!bundle) {
    throw new CopyRefused(404, `No agent "${slug}" on ${env.name}. Its agents: GET ../environments/${env.id}/agents (slugs are stored, not derived from the name).`);
  }
  return bundle;
}

/** Every model id the agent's switched-on add-ons use (active bodies) — keys differ per environment. */
function modelsOf(doc) {
  const a = doc.agents[0];
  const seen = new Set();
  const idOf = m => (typeof m === 'string' ? m : m && m.modelId);
  const walk = list => (list || []).forEach(x => {
    const id = x && x.enabled !== false && x.config && idOf(x.config.model);
    if (id) seen.add(id);
  });
  walk(a.cortex);
  a.crews.forEach(c => walk(c.addons));
  return [...seen].sort();
}

const n = (k, word) => `${k} ${k === 1 ? word : word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`}`;

function carriedLine(plan, b) {
  const kbs = b.kbLinks.map(k => k.namespace);
  return [
    n(plan.agentVersions, 'agent version'),
    n(plan.crews, 'crew'),
    n(plan.crewVersions, 'crew version'),
    `${n(plan.kbLinks, 'knowledge-base link')}${kbs.length ? ` (${kbs.join(', ')})` : ''}`,
    n(plan.libraryFiles, 'KB file record'),
    `${n(plan.kbVectors, 'KB chunk')}${plan.kbVectors ? ' (with their embeddings — nothing re-uploaded or re-embedded)' : ''}`,
    n(plan.agentLog, 'change-history entry'),
  ].join(', ');
}

const NOT_CARRIED = 'Not carried (data, per environment): conversations, messages, add-on runs, memory, customer users, feedback, trigger state, Spec files.';

// ─── GET /environments/:env/agents ─────────────────────────────────

async function listAgentsText({ envId, origin, base }) {
  const { env } = sourceOf(envId, origin);
  let list; let ws;
  try {
    [list, ws] = await Promise.all([
      fetch(`${env.server}/api/builder/projects/list?ownerUserId=copy`, { signal: AbortSignal.timeout(30000) }).then(r => r.json()),
      fetch(`${env.server}/api/builder/workspaces`, { signal: AbortSignal.timeout(30000) }).then(r => r.json()),
    ]);
  } catch (err) {
    throw new CopyRefused(502, `Could not read ${env.name}'s agent list: ${err.message}.`);
  }
  const { pathOf } = folderPaths(ws.workspaces || []);
  const hereRows = await q('SELECT id, slug FROM builder_agents');
  const hereBySlug = new Map(hereRows.map(r => [r.slug, r.id]));
  const hereIds = new Map(hereRows.map(r => [r.id, r.slug]));
  const status = p => {
    if (hereBySlug.get(p.agentSlug) === p.agentId) return 'here: a copy (same agent)';
    if (hereBySlug.has(p.agentSlug)) return 'here: a DIFFERENT agent has this slug';
    if (hereIds.has(p.agentId)) return `here as "${hereIds.get(p.agentId)}" (a renamed copy)`;
    return 'not here';
  };
  // By folder, top-level agents last; then by slug.
  const key = p => pathOf(p.workspaceId);
  const rows = (list.projects || []).slice()
    .sort((a, b) => (!key(a) - !key(b)) || key(a).localeCompare(key(b)) || a.agentSlug.localeCompare(b.agentSlug));
  const lines = rows.map(p => `- ${p.agentName} (\`${p.agentSlug}\`) · ${pathOf(p.workspaceId) || 'top level'}${p.archivedAt ? ' · archived' : ''} · ${status(p)}`);
  return [
    `# Agents on ${env.name} (${rows.length})`,
    '',
    `Read from ${env.name}'s own server (${env.server}). "here" = this environment.`,
    '',
    ...lines,
    '',
    '---',
    `What a copy of one would carry and do (changes nothing): ${base}/environments/${env.id}/agents/<slug>`,
    `Copy one here (ask the person first): POST ${base}/environments/${env.id}/agents/<slug>/copy`,
    '',
  ].join('\n');
}

// ─── The decision both the plan and the copy make ──────────────────

async function decide({ env, here, slug, workspace, refresh }) {
  const bundle = await readSource(env, slug);
  const target = await agentCopy.inspectTarget(q, bundle);
  const hereName = here ? here.name : 'this server';
  if (target.state === 'different') {
    throw new CopyRefused(409, `A different agent already uses the slug "${slug}" on ${hereName} (made here, not a copy of ${env.name}'s). It is never overwritten. Ask the person: rename that one here first, or leave it.`);
  }
  if (target.state === 'renamed') {
    throw new CopyRefused(409, `This agent is already here under the slug "${target.here.slug}" (a copy that was renamed). Refresh that one by renaming it back to "${slug}" first, or work on it as it is.`);
  }
  let action = 'create';
  if (target.state === 'copy') {
    if (target.hasLocalChanges && !refresh) {
      const lost = agentCopy.localChangesText(target.local).map(l => `- ${l}`).join('\n');
      throw new CopyRefused(409, [
        `"${slug}" is already here — a copy of ${env.name}'s — and it has changes made here that a refresh would discard:`,
        lost,
        '',
        'Nothing was changed. Tell the person exactly this list; only if they agree, send the same call with "refresh": true. Conversations here are kept either way.',
      ].join('\n'));
    }
    action = 'refresh';
  }
  let placement; let where;
  if (workspace !== undefined && workspace !== null && String(workspace).trim() !== '') {
    const w = await resolveWorkspace(workspace);
    placement = { mode: 'workspace', workspaceId: w.id };
    where = w.path;
  } else if (action === 'refresh') {
    placement = { mode: 'keep' };
    const rows = await localFolders();
    where = target.here.workspace_id ? `${folderPaths(rows).pathOf(target.here.workspace_id) || target.here.workspace_id} (where the copy already is)` : 'the top level (where the copy already is)';
  } else {
    const d = await defaultPlacement(here);
    placement = { mode: 'workspace', workspaceId: d.id };
    where = d.path;
  }
  return { bundle, target, action, placement, where };
}

// ─── GET /environments/:env/agents/:slug — the plan ───────────────

async function planText({ envId, slug, workspace, origin, base }) {
  const { env, here } = sourceOf(envId, origin);
  const hereName = here ? here.name : 'this server';
  let d;
  try {
    d = await decide({ env, here, slug, workspace, refresh: true });
  } catch (err) {
    if (err instanceof CopyRefused && err.status === 409) return `# Copying "${slug}" from ${env.name}: NOT POSSIBLE as it stands\n\n${err.message}\n`;
    throw err;
  }
  const { bundle, target, action, where } = d;
  const plan = agentCopy.planOf(bundle);
  const doc = bundle.sourceDoc;
  const blocked = !here ? 'This server does not know which environment it is (a local server without LYBI_ENV), so it cannot copy.'
    : here.isProduction ? `${here.name} is production: copies into it are not made through this door — ask Shlomi.` : null;
  const lines = [
    `# Copying "${doc.agents[0].name}" (\`${slug}\`) from ${env.name} into ${hereName}`,
    '',
    action === 'create' ? '**A new agent here.**'
      : target.hasLocalChanges ? `**Already here as a copy — and it has changes made here.** A refresh replaces its setup with ${env.name}'s and DISCARDS:\n${agentCopy.localChangesText(target.local).map(l => `- ${l}`).join('\n')}\nIt needs "refresh": true, and only after the person agreed.`
        : `**Already here as a copy, with nothing made here since** — copying again refreshes it to ${env.name}'s current setup (no "refresh" flag needed). Conversations here are kept.`,
    '',
    `Would carry: ${carriedLine(plan, bundle)}.`,
    `Would land in: ${where}.`,
    NOT_CARRIED,
    ...(bundle.notes.length ? ['', ...bundle.notes.map(x => `Note: ${x}.`)] : []),
    '',
    `Models its add-ons use: ${modelsOf(doc).join(', ') || 'none named'} — ${hereName} has its own model keys; the copy never changes a model, so one this environment cannot run fails there.`,
    '',
    blocked || `Copy it (ask the person first): POST ${base}/environments/${env.id}/agents/${slug}/copy  { "workspace": "<folder name or id — optional>" }`,
    '',
  ];
  return lines.join('\n');
}

// ─── POST /environments/:env/agents/:slug/copy ────────────────────

async function copyHere({ envId, slug, workspace, refresh, origin, base }) {
  const { env, here } = sourceOf(envId, origin);
  if (!here) {
    throw new CopyRefused(409, 'This server does not know which environment it is (a local server?), so it cannot tell what it would be writing into. Set LYBI_ENV to the environment whose database it uses.');
  }
  if (here.isProduction) {
    throw new CopyRefused(403, `${here.name} is production — customers use it. Copies into it are not made through this door; ask Shlomi.`);
  }
  const { bundle, target, action, placement, where } = await decide({ env, here, slug, workspace, refresh: refresh === true });
  const plan = agentCopy.planOf(bundle);
  const { written } = await agentCopy.copyBundle({
    connect: () => db.getClient(),
    bundle,
    existing: action === 'refresh' ? target.here : null,
    placement,
  });
  const mine = await builderProjects.hydrateProject({ agentSlug: slug });
  const check = agentCopy.compareDocs(bundle.sourceDoc, mine && JSON.parse(JSON.stringify(mine)), { fromName: env.name, toName: here.name });
  const doc = bundle.sourceDoc;
  return [
    action === 'create'
      ? `Copied "${doc.agents[0].name}" (\`${slug}\`) from ${env.name} into ${here.name} — a new agent here.`
      : `Refreshed the copy of "${doc.agents[0].name}" (\`${slug}\`) on ${here.name} from ${env.name}. Its conversations here are kept.`,
    check.ok
      ? `VERIFIED — it loads here exactly as it does on ${env.name} (${check.crews.map(c => `✓ ${c.name || c.id}`).join(', ')}).`
      : `NOT IDENTICAL — ${check.why || `crews: ${check.crews.map(c => `${c.same ? '✓' : '✗'} ${c.name || c.id}`).join(', ')}`}. Tell the person; the copy is saved, compare ${base}/agents/${slug} with ${env.server}/api/builder/projects?agentSlug=${slug}&ownerUserId=x.`,
    `Placed in: ${where}.`,
    `Carried: ${carriedLine(plan, bundle)}${written.libraryFiles < plan.libraryFiles ? ` (${plan.libraryFiles - written.libraryFiles} file record(s) were already here)` : ''}${written.kbVectors < plan.kbVectors ? ` (${plan.kbVectors - written.kbVectors} KB chunk(s) were already here)` : ''}.`,
    `Published: ${doc.agents[0].publishedVersionId ? `the same version as on ${env.name} — nothing new reaches a customer, but this agent's customer chat here serves that version` : 'nothing (not published on the source either)'}.`,
    NOT_CARRIED,
    ...bundle.notes.map(x => `Note: ${x}.`),
    `Models its add-ons use: ${modelsOf(doc).join(', ') || 'none named'} — ${here.name} has its own model keys; the copy never changes a model. Tell the person which ones this environment may not run.`,
    '',
    `Read it: ${base}/agents/${slug}   ·   open it in the Builder: ${here.app}/${slug}/builder`,
    '',
  ].join('\n');
}

module.exports = { CopyRefused, listAgentsText, planText, copyHere };
