/**
 * Ultra-Alfred tool implementations — the read-only lenses behind
 * brainstorm Alfred's tool calls. Everything here READS; nothing ever
 * writes. Cross-agent writes don't exist by design: Apply only ever
 * targets the current agent.
 *
 * Tools:
 *   - listAgents()                 — every agent, one line each.
 *   - readAgent(slug)              — full agent JSON (version bodies stripped).
 *   - listConversations(...)       — recent user-facing chats for the current agent.
 *   - readConversation(convId)     — transcript + per-turn addon-run digest.
 *   - readRun(runId)               — one run in full (assembled prompt + raw output).
 *   - changeLogText(...)           — history rows (one agent or all), with
 *                                    changed-section summaries.
 *   - readPlatformFile(path)       — the platform's own source, within an
 *                                    allowlist. The reference material in
 *                                    Alfred's prompt is GENERATED from this
 *                                    code and can lag behind it, so the
 *                                    code is the only way to settle "does
 *                                    this actually exist".
 */

const { eq, and, desc } = require('drizzle-orm');
const db = require('../../services/db.pg');
const fs = require('fs');
const path = require('path');
const { conversations, messages, addonRuns } = require('../../db/schema');
const builderProjects = require('../../builder/services/builderProjects');
const { stripVersionBodies } = require('./alfredContext');
const alfredChats = require('./alfredChats');
const changeLog = require('./changeLog');

function drizzle() {
  return db.getDrizzle();
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + ` …[+${str.length - n} chars]` : str;
}

/** Human timestamps in the platform's local timezone (server clock may
 *  be UTC — e.g. Cloud Run). Override with ALFRED_TIMEZONE. */
const TZ = process.env.ALFRED_TIMEZONE || 'Asia/Jerusalem';
const timeFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});
function fmtTime(d) {
  try { return timeFmt.format(new Date(d)); } catch { return String(d); }
}

// ─── Agents ────────────────────────────────────────────────────────

async function listAgents() {
  const rows = await builderProjects.listProjects();
  if (rows.length === 0) return 'No agents exist yet.';
  const lines = rows.map(r => {
    const bits = [`- ${r.agentName} (slug: ${r.agentSlug})`];
    if (r.projectName) bits.push(`project: ${r.projectName}`);
    if (r.archivedAt)  bits.push('ARCHIVED');
    bits.push(`updated ${r.updatedAt.slice(0, 10)}`);
    return bits.join(' · ');
  });
  return ['Agents (newest activity first):', ...lines].join('\n');
}

async function readAgent(slug, ownerUserId) {
  const project = await builderProjects.hydrateProject({ agentSlug: slug, ownerUserId });
  if (!project || !project.agents[0]) {
    return `No agent found for slug "${slug}". Use list_agents to see valid slugs.`;
  }
  const agent = project.agents[0];
  const slim = stripVersionBodies(agent);
  if (Array.isArray(slim.crews)) slim.crews = slim.crews.map(stripVersionBodies);
  return [
    `Agent "${agent.name || agent.slug}" — full JSON (working copy; version bodies omitted).`,
    'READ-ONLY reference: Apply can never modify this agent — only the one currently open in the builder.',
    '```json',
    JSON.stringify(slim, null, 2),
    '```',
  ].join('\n');
}

// ─── Conversations + runs ──────────────────────────────────────────

async function listConversations({ agentSlug, limit = 10 }) {
  const legacyAgentId = await alfredChats.resolveLegacyAgentId(agentSlug);
  const rows = await drizzle().select()
    .from(conversations)
    .where(and(
      eq(conversations.agentId, legacyAgentId),
      eq(conversations.kind, 'user'),
    ))
    .orderBy(desc(conversations.updatedAt))
    .limit(Math.min(Math.max(Number(limit) || 10, 1), 30));
  if (rows.length === 0) return 'No chat conversations exist for this agent yet.';
  const lines = rows.map(c => {
    const crew = c.metadata?.currentCrewId ? ` · current crew: ${c.metadata.currentCrewId}` : '';
    // Which surface it was born in — a simulated conversation (an outside
    // AI testing the agent, task #894) must never be read as a customer's.
    const kind = c.metadata?.kind === 'live' ? ' · customer /live'
      : c.metadata?.kind === 'simulation' ? ` · SIMULATED (a test run by ${c.metadata?.simulation?.by || 'an AI'}'s assistant${c.metadata?.simulation?.label ? ` — "${c.metadata.simulation.label}"` : ''})`
        : c.metadata?.kind === 'builder-preview' ? ' · builder preview' : '';
    return `- conversation ${c.id} · started ${fmtTime(c.createdAt)} · last activity ${fmtTime(c.updatedAt)}${kind}${crew}`;
  });
  return [`Recent chats (builder preview, customer /live and simulated test runs), newest first (times in ${TZ}):`, ...lines].join('\n');
}

/** One run → a compact digest line-block. Full detail via read_run. */
function digestRun(run) {
  const d = run.runData || {};
  const bits = [
    `    ▸ run ${run.id} · ${d.label || run.pluginId} (${run.pluginId})`,
    `status: ${run.status}${d.hidden ? ' · hidden' : ''}${d.skipped ? ' · SKIPPED' : ''}`,
  ];
  if (d.modelLabel) bits.push(`model: ${d.modelLabel.modelName || d.modelLabel}`);
  if (run.durationMs != null) bits.push(`${run.durationMs}ms`);
  const head = bits.join(' · ');
  const lines = [head];
  if (d.filter)              lines.push(`      filter: ${JSON.stringify(d.filter)}`);
  if (d.parseError)          lines.push(`      PARSE ERROR: ${truncate(d.parseError, 200)}`);
  if (d.transition)          lines.push(`      transition: ${JSON.stringify(d.transition)}`);
  if (Array.isArray(d.memoryWrites) && d.memoryWrites.length > 0) {
    lines.push(`      writes: ${truncate(JSON.stringify(d.memoryWrites), 300)}`);
  }
  if (d.parsedOutput !== undefined && d.parsedOutput !== null) {
    lines.push(`      output: ${truncate(JSON.stringify(d.parsedOutput), 300)}`);
  } else if (d.rawOutput) {
    lines.push(`      output(raw): ${truncate(d.rawOutput, 300)}`);
  }
  return lines.join('\n');
}

async function readConversation({ conversationId }) {
  const convId = Number(conversationId);
  const [conv] = await drizzle().select().from(conversations)
    .where(eq(conversations.id, convId)).limit(1);
  if (!conv) return `Conversation ${conversationId} not found.`;

  const msgs = await drizzle().select().from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(messages.createdAt);

  const runsByMessage = new Map();
  for (const m of msgs) {
    if (m.role !== 'assistant') continue;
    const runs = await drizzle().select().from(addonRuns)
      .where(eq(addonRuns.messageId, m.id))
      .orderBy(addonRuns.startedAt);
    if (runs.length > 0) runsByMessage.set(m.id, runs);
  }

  const lines = [
    `Conversation ${convId} — transcript with per-turn addon runs.`,
    'Prompts/outputs are truncated in this digest — zoom into any run with read_run(runId) for the FULL assembled prompt and raw output.',
    '',
  ];
  for (const m of msgs) {
    lines.push(`[${m.role.toUpperCase()}] ${truncate(m.content, 500)}`);
    const runs = runsByMessage.get(m.id);
    if (runs) {
      for (const r of runs) lines.push(digestRun(r));
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function readRun({ runId }) {
  const [run] = await drizzle().select().from(addonRuns)
    .where(eq(addonRuns.id, String(runId))).limit(1);
  if (!run) return `Run ${runId} not found.`;
  const d = run.runData || {};
  return [
    `Run ${run.id} · ${d.label || run.pluginId} (${run.pluginId}) · status ${run.status} · ${run.durationMs ?? '?'}ms`,
    '',
    '## Assembled prompt (exactly what the LLM received as its prompt parameter)',
    '```text',
    String(d.prompt || '(no prompt — non-LLM addon)'),
    '```',
    '',
    '## Raw output',
    '```text',
    String(d.rawOutput || '(empty)'),
    '```',
    '',
    '## Parsed output',
    '```json',
    JSON.stringify(d.parsedOutput ?? null, null, 2),
    '```',
    ...(Array.isArray(d.memoryWrites) && d.memoryWrites.length > 0
      ? ['', '## Memory writes', '```json', JSON.stringify(d.memoryWrites, null, 2), '```']
      : []),
  ].join('\n');
}

// ─── Change log ────────────────────────────────────────────────────

/** Top-level sections whose value differs between before/after. */
function changedSections(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out;
}

async function changeLogText({ agentId, limit = 20 }) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = agentId
    ? await changeLog.listForAgent(agentId, capped)
    : await changeLog.listRecent(capped);
  if (rows.length === 0) return 'No log entries found.';
  return rows.map(r => {
    const when = fmtTime(r.appliedAt);
    const actor = r.actor === 'alfred' ? 'Alfred' : 'manual';
    const what = (r.whatChanged || '').trim() || '(no description)';
    const why = (r.reason || '').trim();
    const sections = changedSections(r.bodyBefore, r.bodyAfter);
    const head = `[${when}] ${r.agentName || r.agentId} · ${actor} · ${r.entity}: ${r.entityName}`;
    const parts = [head, `  ${what}`];
    if (sections.length > 0) parts.push(`  changed sections: ${sections.join(', ')}`);
    if (why) parts.push(`  why: ${why}`);
    return parts.join('\n');
  }).join('\n\n');
}

/**
 * The platform source Alfred may read.
 *
 * Allowlisted by prefix rather than opened wide: these are the folders
 * that explain how an agent BEHAVES — the assembler, the validator, the
 * runtime, the plugins, the type definitions and the guides. Everything
 * else (server routes, other products, hq/, anything holding a secret) is
 * refused. `.env` never appears under these prefixes.
 */
const READABLE_PREFIXES = ['builder/', 'alfred/', 'docs/guides/', 'docs/features/'];
const PLATFORM_ROOT = path.join(__dirname, '..', '..');
/** A whole file is better than a guess, but a 500KB one is neither. */
const MAX_FILE_CHARS = 120000;

/**
 * Read one platform file, or list a directory.
 *
 * Both in one tool on purpose: "show me promptAssembler.js" and "what is
 * in builder/runtime" are the same question asked at different zoom
 * levels, and making Alfred pick the right tool first is friction with no
 * upside.
 */
function readPlatformFile(relPath) {
  const rel = String(relPath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel) return 'read_platform_file needs a path, e.g. "builder/runtime/promptAssembler.js".';

  // Traversal and absolute paths are refused outright rather than
  // normalised — there is no legitimate caller that needs either.
  if (rel.includes('..') || path.isAbsolute(rel)) {
    return `Refused "${rel}": paths must be relative and inside ${READABLE_PREFIXES.join(', ')}.`;
  }
  if (!READABLE_PREFIXES.some(p => rel.startsWith(p))) {
    return `Refused "${rel}". You can read: ${READABLE_PREFIXES.join(', ')}. Everything else is out of bounds.`;
  }

  const abs = path.join(PLATFORM_ROOT, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return `No such file: ${rel}. Use a directory path to see what is there (e.g. "builder/runtime").`;
  }

  if (stat.isDirectory()) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (err) { return `Could not list ${rel}: ${err.message}`; }
    const lines = entries
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return `## ${rel} — ${lines.length} entries\n\n${lines.join('\n')}`;
  }

  let text;
  try { text = fs.readFileSync(abs, 'utf8'); }
  catch (err) { return `Could not read ${rel}: ${err.message}`; }

  let note = '';
  if (text.length > MAX_FILE_CHARS) {
    text = text.slice(0, MAX_FILE_CHARS);
    note = `\n\n_(truncated at ${MAX_FILE_CHARS} characters — ask for a specific part if you need more)_`;
  }
  const ext = path.extname(rel).slice(1) || 'text';
  return `## ${rel}\n\n\`\`\`${ext}\n${text.trim()}\n\`\`\`${note}`;
}

// ─── Knowledge bases (task #868) ───────────────────────────────────
//
// A KB is a Pinecone NAMESPACE in the shared index. Two separate things
// tie one to an agent, and outside assistants kept confusing them:
//   - CONNECTED (`kb_links`): the Builder only offers / shows the KB for
//     that agent. A KB Retriever naming an unconnected KB reads "MISSING"
//     in the Builder.
//   - SEARCHED: a KB Retriever addon lists it in `config.kbNamespaces`.
//     That is what actually makes the agent read it.
// Before these readers an assistant had no way to see either — it guessed
// URLs, got "Cannot GET", and asked the person for the admin link (which
// is a browser-only screen and shows it nothing).

const KB_INDEX = () => process.env.PINECONE_INDEX_NAME || 'lybi';
/** Lybi HQ keeps its own internal brain in the same index. It is not a KB
 *  any agent is built on, so it is never listed or offered to connect. */
const NOT_AN_AGENT_KB = new Set(['hq']);

function pinecone() {
  return require('../../services/kb.pinecone.service');
}

/** Every KB in the active index: chunks, files, connections, users. */
async function kbCatalog() {
  const idx = KB_INDEX();
  const stats = await pinecone().getIndexStats();
  const kbs = new Map();
  const kb = name => {
    if (!kbs.has(name)) kbs.set(name, { name, chunks: 0, files: 0, connected: [], searchedBy: [] });
    return kbs.get(name);
  };
  for (const n of stats.namespaces || []) {
    if (!NOT_AN_AGENT_KB.has(n.name) && n.name !== '__default__') kb(n.name).chunks = n.vectorCount || 0;
  }
  const files = await db.query(
    'select namespace, count(*)::int n from library_files where index_name = $1 group by namespace', [idx]);
  for (const r of files.rows) if (kbs.has(r.namespace)) kbs.get(r.namespace).files = r.n;

  const agents = await db.query(`
    select a.id, a.slug, v.body->>'name' as name, v.body->'cortex' as cortex
      from builder_agents a join builder_agent_versions v on v.id = a.active_version_id`);
  const agentById = new Map(agents.rows.map(r => [r.id, r]));
  const label = id => {
    const a = agentById.get(id);
    return a ? `${a.name || a.slug} (${a.slug})` : id;
  };

  const links = await db.query('select namespace, agent_id from kb_links where index_name = $1', [idx]);
  for (const l of links.rows) if (kbs.has(l.namespace)) kbs.get(l.namespace).connected.push(label(l.agent_id));

  // Who SEARCHES what — every KB Retriever on an active agent cortex or crew.
  const crews = await db.query(`
    select c.agent_id, v.body->>'name' as crew, v.body->'addons' as addons
      from builder_crews c join builder_crew_versions v on v.id = c.active_version_id
     where v.body::text like '%kb-retriever%'`);
  const uses = []; // { agentId, where, addon, namespace }
  const collect = (agentId, where, addons) => {
    for (const a of Array.isArray(addons) ? addons : []) {
      if (a?.pluginId !== 'kb-retriever') continue;
      for (const ns of a.config?.kbNamespaces || []) {
        uses.push({ agentId, where, addon: a.config?.name || 'KB Retriever', namespace: ns });
      }
    }
  };
  for (const a of agents.rows) collect(a.id, 'agent cortex', a.cortex);
  for (const c of crews.rows) collect(c.agent_id, `crew "${c.crew}"`, c.addons);
  for (const u of uses) {
    if (kbs.has(u.namespace)) kbs.get(u.namespace).searchedBy.push(`${label(u.agentId)} → ${u.where} / ${u.addon}`);
  }
  return { idx, kbs, uses, label, agentById };
}

async function listKnowledgeBases() {
  const { idx, kbs, uses, label } = await kbCatalog();
  const lines = [...kbs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(k => [
    `- ${k.name} · ${k.chunks} chunks · ${k.files} file${k.files === 1 ? '' : 's'}`,
    `    connected to: ${k.connected.length ? k.connected.join(', ') : '(no agent)'}`,
    `    searched by:  ${k.searchedBy.length ? k.searchedBy.join('; ') : '(no KB Retriever)'}`,
  ].join('\n'));
  const broken = uses.filter(u => !kbs.has(u.namespace));
  return [
    `Knowledge bases in the Pinecone index "${idx}". A KB is a namespace.`,
    'CONNECTED = the Builder shows it for that agent (otherwise its KB Retriever reads "MISSING").',
    'SEARCHED = a KB Retriever addon lists it in config.kbNamespaces — that is what the agent reads.',
    '',
    ...(lines.length ? lines : ['(no knowledge bases)']),
    ...(broken.length ? [
      '',
      `KB Retrievers naming a KB that does not exist in "${idx}" (they find nothing):`,
      ...broken.map(u => `- ${label(u.agentId)} → ${u.where} / ${u.addon} → "${u.namespace}"`),
    ] : []),
  ].join('\n');
}

async function agentKnowledgeBases(slug) {
  const { idx, kbs, uses, agentById } = await kbCatalog();
  const agent = [...agentById.values()].find(a => a.slug === slug);
  if (!agent) return `No agent with slug "${slug}".`;
  const links = await db.query(
    'select namespace from kb_links where index_name = $1 and agent_id = $2 order by namespace', [idx, agent.id]);
  const connected = new Set(links.rows.map(r => r.namespace));
  const mine = uses.filter(u => u.agentId === agent.id);
  const status = ns => !kbs.has(ns)
    ? `does NOT exist in "${idx}" — the retriever finds nothing`
    : connected.has(ns) ? 'ok' : 'exists but NOT connected — the Builder shows it as MISSING; connect it';
  return [
    `Knowledge bases of "${agent.name || slug}" (${slug}), Pinecone index "${idx}".`,
    '',
    'Connected (shown in the Builder for this agent):',
    ...(connected.size
      ? [...connected].map(ns => `- ${ns}${kbs.has(ns) ? ` · ${kbs.get(ns).chunks} chunks · ${kbs.get(ns).files} files` : ' · does NOT exist in this index'}`)
      : ['- (none)']),
    '',
    'KB Retriever addons (what the agent actually searches):',
    ...(mine.length ? mine.map(u => `- ${u.where} / ${u.addon} → "${u.namespace}": ${status(u.namespace)}`) : ['- (none)']),
  ].join('\n');
}

function refuseNotAgentKb(namespace) {
  return NOT_AN_AGENT_KB.has(namespace)
    ? `"${namespace}" is Lybi HQ's internal knowledge, not an agent knowledge base.`
    : null;
}

async function listKbFiles(namespace) {
  const refused = refuseNotAgentKb(namespace);
  if (refused) return refused;
  const idx = KB_INDEX();
  const r = await db.query(
    // `at time zone 'UTC'`: the column is naive UTC, and a raw pg read would
    // otherwise take it as server-local time — three hours off in Israel.
    `select file_id, file_name, chunk_count, file_size, (created_at at time zone 'UTC') as created_at
       from library_files where index_name = $1 and namespace = $2 order by created_at desc`, [idx, namespace]);
  if (r.rows.length === 0) {
    return `No files recorded for KB "${namespace}" in "${idx}". See the list of knowledge bases for valid names.`;
  }
  return [
    `Files in KB "${namespace}" (index "${idx}"). Read one with its file id.`,
    ...r.rows.map(f => `- file ${f.file_id} · ${f.file_name} · ${f.chunk_count} chunks${f.file_size ? ` · ${Math.round(f.file_size / 1024)} KB` : ''} · uploaded ${fmtTime(f.created_at)}`),
  ].join('\n');
}

/** One file's text, chunk by chunk in order. Chunks overlap slightly
 *  (the chunker repeats ~200 characters at each seam) — that is expected. */
async function readKbFile(namespace, fileId, { maxChars = 0 } = {}) {
  const refused = refuseNotAgentKb(namespace);
  if (refused) return refused;
  const idx = KB_INDEX();
  const r = await db.query(
    'select file_name, chunk_count from library_files where index_name = $1 and namespace = $2 and file_id = $3 limit 1',
    [idx, namespace, String(fileId)]);
  const file = r.rows[0];
  if (!file) return `No file ${fileId} in KB "${namespace}". List the KB's files for valid ids.`;
  // Pinecone stores fileId as a number; library_files as a string.
  const vectors = await pinecone().listVectors(namespace, {
    fileId: Number(fileId), limit: Math.max((file.chunk_count || 0) + 10, 50),
  });
  const chunks = vectors
    .map(v => ({ i: Number(v.metadata?.chunkIndex) || 0, text: String(v.metadata?.text || '') }))
    .sort((a, b) => a.i - b.i);
  if (chunks.length === 0) return `File ${fileId} ("${file.file_name}") has no chunks in "${idx}".`;
  const body = chunks.map(c => `--- chunk ${c.i} ---\n${c.text}`).join('\n\n');
  return [
    `"${file.file_name}" — KB "${namespace}", ${chunks.length} chunks (neighbouring chunks overlap a little).`,
    '',
    maxChars > 0 ? truncate(body, maxChars) : body,
  ].join('\n');
}

/** True when the KB exists in the active index with at least one chunk. */
async function kbExists(namespace) {
  if (NOT_AN_AGENT_KB.has(namespace)) return false;
  const stats = await pinecone().getIndexStats();
  return (stats.namespaces || []).some(n => n.name === namespace && (n.vectorCount || 0) > 0);
}

module.exports = {
  listKnowledgeBases,
  agentKnowledgeBases,
  listKbFiles,
  readKbFile,
  kbExists,
  KB_INDEX,
  listAgents,
  readAgent,
  listConversations,
  readConversation,
  readRun,
  changeLogText,
  readPlatformFile,
};
