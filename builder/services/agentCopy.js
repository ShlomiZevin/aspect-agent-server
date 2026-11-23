/**
 * Copy one Builder agent's SETUP from one environment into another — the
 * ONE implementation, used by both:
 *
 *   scripts/copy-agent-to-env.js   Shlomi's machine: reads the source
 *                                   database directly (readFromDb).
 *   builder/services/mcpCopy.js    the Builder MCP of the TARGET server:
 *                                   reads the source through its public
 *                                   Builder API (readFromApi) and writes
 *                                   into its own database. No database
 *                                   credentials of the source needed.
 *
 * Both readers return the same BUNDLE (rows shaped as the tables, snake
 * case), so planning, the slug-clash rules, the write and the check are
 * shared:
 *
 *   readFromDb / readFromApi  → bundle
 *   planOf(bundle)            → counts per part
 *   inspectTarget(q, bundle)  → new | copy (same agent; what a refresh
 *                               would discard) | different | renamed
 *   copyBundle(...)           → one transaction on the target
 *   compareDocs(a, b)         → is the agent the same through both APIs
 *
 * Copied (what you see in the Builder): the project, the agent and EVERY
 * agent version (active / viewing / published pointers as they are), every
 * crew and crew version, knowledge-base links + their file records
 * (library_files — vectors stay in Pinecone, which every environment
 * shares), the change history (agent_log), the agent's folder (mirrored, or
 * a folder the caller picks) and the legacy `agents` row conversations hang
 * off (DB reader only — the runtime makes it on the first chat otherwise).
 * NOT copied (data): conversations, messages, add-on runs, memory, customer
 * users, feedback, trigger runtime state, Spec files.
 *
 * Builder rows keep their text ids, so versions, crews and links line up —
 * and the same agent id on both sides is how a COPY is recognised later.
 *
 * The API reader sees what the Builder sees: version bodies come through
 * `hydrateProject`'s read normalisation (legacy persona seeded as a
 * persona, add-on shapes migrated, empty crew keys filled) — the same
 * normalisation the runtime and the Builder apply to the stored row, so
 * the agent runs and opens identically. Through the API, crew `position`
 * becomes the crew order, the change history is the newest 100 entries
 * (the source API's limit), and the KB links are those of the active
 * Pinecone index.
 *
 * Nothing here opens a database or reads env: callers pass `q` (sql,
 * params → rows) and `connect` (→ a pg client).
 */

const SKIP_IN_COMPARE = new Set(['ownerUserId', 'updatedAt']);

// ─── Readers ───────────────────────────────────────────────────────

/** Straight from the source database (the script). Null if no such agent. */
async function readFromDb(q, slug, { from } = {}) {
  const [agent] = await q('SELECT * FROM builder_agents WHERE slug = $1', [slug]);
  if (!agent) return null;
  const folders = agent.workspace_id ? await q(`WITH RECURSIVE w AS (
      SELECT *, 1 AS lvl FROM builder_workspaces WHERE id = $1
      UNION ALL SELECT p.*, w.lvl + 1 FROM builder_workspaces p JOIN w ON p.id = w.parent_id)
    SELECT * FROM w ORDER BY lvl DESC`, [agent.workspace_id]) : [];
  folders.forEach(f => delete f.lvl);
  const project = await q('SELECT * FROM builder_projects WHERE id = $1', [agent.project_id]);
  const agentVersions = await q('SELECT * FROM builder_agent_versions WHERE agent_id = $1 ORDER BY created_at', [agent.id]);
  const crews = await q('SELECT * FROM builder_crews WHERE agent_id = $1', [agent.id]);
  const crewVersions = await q('SELECT * FROM builder_crew_versions WHERE crew_id = ANY($1) ORDER BY created_at', [crews.map(c => c.id)]);
  const kbLinks = await q('SELECT * FROM kb_links WHERE agent_id = $1', [agent.id]);
  const libraryFiles = kbLinks.length
    ? await q(`SELECT DISTINCT f.* FROM library_files f
        JOIN unnest($1::text[], $2::text[]) AS k(index_name, namespace)
          ON f.index_name = k.index_name AND f.namespace = k.namespace`,
      [kbLinks.map(k => k.index_name), kbLinks.map(k => k.namespace)])
    : [];
  const agentLog = await q('SELECT * FROM agent_log WHERE agent_id = $1 ORDER BY applied_at', [agent.id]);
  const legacy = await q('SELECT * FROM agents WHERE url_slug = $1', [slug]);
  return {
    from, via: 'db', slug, agent, folders, project, agentVersions, crews, crewVersions,
    kbLinks, libraryFiles, agentLog, legacy, sourceDoc: null, notes: [],
  };
}

const enc = encodeURIComponent;
const snake = k => k.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
const snakeRow = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v]));
// Timestamps travel as ISO strings; written back as Dates, node-pg's own
// convention — the same one the DB reader round-trips.
const asDate = iso => (iso ? new Date(iso) : undefined);
const earliest = versions => asDate((versions || []).map(v => v.createdAt).filter(Boolean).sort()[0]);

/** GET one JSON document from an environment's server; null on 404. */
async function getJson(apiUrl, pathAndQuery) {
  let r;
  try {
    r = await fetch(`${apiUrl}${pathAndQuery}`, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new Error(`could not reach ${apiUrl} (${err.message})`);
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${apiUrl}${pathAndQuery.split('?')[0]} answered ${r.status}`);
  return r.json();
}

/** The agent exactly as an environment's Builder API serves it (null if absent). */
async function loadDocViaApi(apiUrl, slug) {
  return getJson(apiUrl, `/api/builder/projects?agentSlug=${enc(slug)}&ownerUserId=copy-check`);
}

/**
 * Through the source environment's public Builder API — the same calls
 * its own Builder makes. Every endpoint used here exists on Origin
 * (frozen 2026-10-26), so any environment can be a source.
 */
async function readFromApi(apiUrl, slug, { from } = {}) {
  const doc = await loadDocViaApi(apiUrl, slug);
  const a = doc && doc.agents && doc.agents[0];
  if (!a) return null;
  const need = async p => {
    const j = await getJson(apiUrl, p);
    if (!j) throw new Error(`${apiUrl} has no ${p.split('?')[0]} — it cannot be copied from through its API`);
    return j;
  };
  const [list, ws, kbs, log] = await Promise.all([
    need('/api/builder/projects/list?ownerUserId=copy'),
    need('/api/builder/workspaces'),
    need(`/api/library/kbs?agentId=${enc(a.id)}`),
    need(`/api/builder/alfred/agents/${enc(a.id)}/log`),
  ]);
  const listed = (list.projects || []).find(p => p.agentId === a.id) || {};

  // The agent's folder and its parents, top first.
  const byId = new Map((ws.workspaces || []).map(w => [w.id, w]));
  const folders = [];
  for (let w = byId.get(listed.workspaceId); w && !folders.some(f => f.id === w.id); w = byId.get(w.parentId)) {
    folders.unshift({ id: w.id, name: w.name || '', parent_id: w.parentId || null, kind: w.kind || null, created_at: asDate(w.createdAt) });
  }

  const agent = {
    id: a.id,
    project_id: doc.id,
    slug: a.slug,
    workspace_id: listed.workspaceId || null,
    archived_at: listed.archivedAt ? new Date(listed.archivedAt) : null,
    active_version_id: a.activeVersionId ?? null,
    viewing_version_id: a.viewingVersionId ?? null,
    published_version_id: a.publishedVersionId ?? null,
    created_at: earliest(a.versions),
  };
  const byCreated = (x, y) => String(x.createdAt).localeCompare(String(y.createdAt));
  const agentVersions = [...a.versions].sort(byCreated).map(v => ({
    id: v.id, agent_id: a.id, number: v.number, description: v.description ?? null, body: v.body, created_at: asDate(v.createdAt),
  }));
  const crews = a.crews.map((c, i) => ({
    id: c.id,
    agent_id: a.id,
    active_version_id: c.activeVersionId ?? null,
    viewing_version_id: c.viewingVersionId ?? null,
    published_version_id: c.publishedVersionId ?? null,
    position: i, // the order the source shows them in
    created_at: earliest(c.versions),
  }));
  const crewVersions = a.crews.flatMap(c => [...c.versions].sort(byCreated).map(v => ({
    id: v.id, crew_id: c.id, number: v.number, description: v.description ?? null, body: v.body, created_at: asDate(v.createdAt),
  })));

  const kbLinks = (kbs.kbs || []).filter(k => k.linked)
    .map(k => ({ index_name: kbs.indexName, namespace: k.namespace, agent_id: a.id }));
  const libraryFiles = [];
  for (const k of kbLinks) {
    const files = await need(`/api/library/files?namespace=${enc(k.namespace)}&indexName=${enc(k.index_name)}`);
    for (const f of files.files || []) libraryFiles.push({ ...snakeRow(f), created_at: asDate(f.createdAt) });
  }
  const entries = log.entries || [];
  const agentLog = [...entries].reverse()
    .map(e => ({ ...snakeRow(e), applied_at: asDate(e.appliedAt) }));

  const notes = [];
  if (!listed.agentId) notes.push('it is not on the source agent list (delisted), so its folder and archive state are not known — placed at the top level unless a folder is given');
  if (entries.length >= 100) notes.push('only the newest 100 change-history entries come through the source API');
  return {
    from, via: 'api', slug, agent, folders,
    project: [{ id: doc.id, owner_user_id: `copy:${from || 'api'}`.slice(0, 64), name: doc.name || '', spec: doc.spec || '' }],
    agentVersions, crews, crewVersions, kbLinks, libraryFiles, agentLog,
    legacy: [], // made by the runtime on the agent's first chat here
    sourceDoc: doc,
    notes,
  };
}

/** Counts per part — the plan both the script and the MCP print. */
function planOf(b) {
  return {
    folders: b.folders.length, project: b.project.length, agent: 1, agentVersions: b.agentVersions.length,
    crews: b.crews.length, crewVersions: b.crewVersions.length, kbLinks: b.kbLinks.length,
    libraryFiles: b.libraryFiles.length, agentLog: b.agentLog.length, legacyAgentRow: b.legacy.length,
  };
}

// ─── The target: what is already there ─────────────────────────────

/**
 * What the target holds under this slug / this agent id.
 *   new        nothing — a plain copy
 *   copy       the SAME agent (same id: it was copied before). `local`
 *              lists what a refresh would discard: versions and crews made
 *              on the target, and published pointers that differ (a
 *              refresh resets them to the source's).
 *   different  another agent uses this slug here — never overwritten
 *   renamed    this agent is here under another slug
 */
async function inspectTarget(q, b) {
  const { agent } = b;
  const [bySlug] = await q('SELECT id, slug, workspace_id, published_version_id FROM builder_agents WHERE slug = $1', [agent.slug]);
  const [byId] = await q('SELECT id, slug, workspace_id, published_version_id FROM builder_agents WHERE id = $1', [agent.id]);
  if (bySlug && bySlug.id !== agent.id) return { state: 'different', here: bySlug };
  if (!bySlug && byId) return { state: 'renamed', here: byId };
  if (!bySlug) return { state: 'new', here: null };

  const srcAV = new Set(b.agentVersions.map(v => v.id));
  const srcCrews = new Map(b.crews.map(c => [c.id, c]));
  const srcCV = new Set(b.crewVersions.map(v => v.id));
  const tAV = await q('SELECT id, number, description FROM builder_agent_versions WHERE agent_id = $1 ORDER BY number', [agent.id]);
  const tCrews = await q(`SELECT c.id, c.published_version_id, v.body->>'name' AS name
      FROM builder_crews c LEFT JOIN builder_crew_versions v ON v.id = COALESCE(c.active_version_id, c.viewing_version_id)
      WHERE c.agent_id = $1`, [agent.id]);
  const tCV = await q(`SELECT v.id, v.number, v.crew_id, v.description FROM builder_crew_versions v
      JOIN builder_crews c ON c.id = v.crew_id WHERE c.agent_id = $1 ORDER BY v.number`, [agent.id]);
  const crewName = id => tCrews.find(c => c.id === id)?.name || id;

  const published = [];
  if ((bySlug.published_version_id ?? null) !== (agent.published_version_id ?? null)) {
    published.push({ what: 'the agent', here: bySlug.published_version_id, source: agent.published_version_id });
  }
  for (const c of tCrews) {
    const s = srcCrews.get(c.id);
    if (s && (c.published_version_id ?? null) !== (s.published_version_id ?? null)) {
      published.push({ what: `crew "${c.name || c.id}"`, here: c.published_version_id, source: s.published_version_id });
    }
  }
  const local = {
    agentVersions: tAV.filter(v => !srcAV.has(v.id)),
    crews: tCrews.filter(c => !srcCrews.has(c.id)),
    crewVersions: tCV.filter(v => !srcCV.has(v.id) && srcCrews.has(v.crew_id)).map(v => ({ ...v, crew: crewName(v.crew_id) })),
    published,
  };
  const hasLocalChanges = Object.values(local).some(list => list.length > 0);
  return { state: 'copy', here: bySlug, local, hasLocalChanges };
}

/** "2 agent versions (v7, v8), crew "Intro" …" — for a refusal or a warning. */
function localChangesText(local) {
  const out = [];
  const few = (list, fmt) => list.slice(0, 12).map(fmt).join(', ') + (list.length > 12 ? ` and ${list.length - 12} more` : '');
  if (local.agentVersions.length) out.push(`${local.agentVersions.length} agent version(s) made here: ${few(local.agentVersions, v => `v${v.number}${v.description ? ` "${v.description}"` : ''}`)}`);
  if (local.crews.length) out.push(`${local.crews.length} crew(s) made here: ${few(local.crews, c => `"${c.name || c.id}"`)}`);
  if (local.crewVersions.length) out.push(`${local.crewVersions.length} crew version(s) made here: ${few(local.crewVersions, v => `"${v.crew}" v${v.number}`)}`);
  for (const p of local.published) out.push(`${p.what} is published here at ${p.here || 'nothing'}; the source has ${p.source || 'nothing'}`);
  return out;
}

// ─── The write ─────────────────────────────────────────────────────

const asParam = v => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v);

/**
 * mode: 'keep'   — ON CONFLICT DO NOTHING (keep what the target has)
 *       'update' — ON CONFLICT (id) DO UPDATE (the source wins)
 *       'fresh'  — drop the id, let the target number it
 * An undefined value is left out, so the column's default applies.
 */
async function insertRows(client, table, rows, mode = 'keep') {
  let n = 0;
  for (const row of rows) {
    const r = { ...row };
    if (mode === 'fresh') delete r.id;
    const cols = Object.keys(r).filter(c => r[c] !== undefined);
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

/**
 * Write the bundle into the target in ONE transaction — all or nothing.
 *
 * existing   the target's row for this agent when it is a copy being
 *            refreshed (inspectTarget's `here`), else null. Its setup is
 *            cleared first; its conversations stay.
 * placement  { mode: 'mirror' }                — the source's folder chain, ids kept
 *            { mode: 'workspace', workspaceId } — into that target folder (null = top level)
 *            { mode: 'keep' }                  — where the existing copy already is
 */
async function copyBundle({ connect, bundle: b, existing = null, placement = { mode: 'mirror' } }) {
  const { agent } = b;
  const workspaceId = placement.mode === 'workspace' ? (placement.workspaceId || null)
    : placement.mode === 'keep' ? (existing ? existing.workspace_id : null) ?? null
      : agent.workspace_id ?? null;
  const client = await connect();
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
      folders: placement.mode === 'mirror' ? await insertRows(client, 'builder_workspaces', b.folders, shell) : 0,
      project: await insertRows(client, 'builder_projects', b.project, shell),
      agent: await insertRows(client, 'builder_agents', [{ ...agent, workspace_id: workspaceId }], 'keep'),
      agentVersions: await insertRows(client, 'builder_agent_versions', b.agentVersions, 'keep'),
      crews: await insertRows(client, 'builder_crews', b.crews, 'keep'),
      crewVersions: await insertRows(client, 'builder_crew_versions', b.crewVersions, 'keep'),
      kbLinks: await insertRows(client, 'kb_links', b.kbLinks, 'fresh'),
      agentLog: await insertRows(client, 'agent_log', b.agentLog, 'fresh'),
      libraryFiles: 0,
      legacyAgentRow: 0,
    };
    // File records: only those the target doesn't have yet (several agents can share a namespace).
    for (const f of b.libraryFiles) {
      const [has] = (await client.query('SELECT 1 FROM library_files WHERE index_name = $1 AND namespace = $2 AND file_id = $3', [f.index_name, f.namespace, f.file_id])).rows;
      if (!has) done.libraryFiles += await insertRows(client, 'library_files', [f], 'fresh');
    }
    // The legacy agents row: only if the target has none (its conversations point at it).
    if (b.legacy.length) {
      const [hasLegacy] = (await client.query('SELECT 1 FROM agents WHERE url_slug = $1', [b.slug])).rows;
      if (!hasLegacy) done.legacyAgentRow = await insertRows(client, 'agents', b.legacy, 'fresh');
    }
    await client.query('COMMIT');
    return { written: done, workspaceId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    err.message = `${err.message} (rolled back — the target is unchanged)`;
    throw err;
  } finally {
    client.release();
  }
}

// ─── The check ─────────────────────────────────────────────────────

/** Key-order independent (jsonb reorders keys); ignores owner and updatedAt. */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : stable(x))).join(',')}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined && !SKIP_IN_COMPARE.has(k))
    .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/**
 * The agent as the source's and the target's Builder APIs serve it
 * (ProjectDocs, JSON-shaped). ok = identical; crews = per-crew verdict.
 */
function compareDocs(source, target, { fromName = 'the source', toName = 'the target' } = {}) {
  if (!source?.agents?.[0]) return { ok: false, crews: [], why: `could not load the agent from ${fromName}` };
  if (!target?.agents?.[0]) return { ok: false, crews: [], why: `could not load the agent from ${toName}` };
  const crews = source.agents[0].crews.map(c => {
    const d = target.agents[0].crews.find(x => x.id === c.id);
    return { id: c.id, name: c.name, same: !!d && stable(c) === stable(d) };
  });
  return { ok: stable(source) === stable(target), crews };
}

module.exports = {
  readFromDb, readFromApi, loadDocViaApi, planOf,
  inspectTarget, localChangesText, copyBundle, compareDocs,
};
