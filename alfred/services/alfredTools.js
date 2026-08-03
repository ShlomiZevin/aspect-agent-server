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
 */

const { eq, and, desc } = require('drizzle-orm');
const db = require('../../services/db.pg');
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
    return `- conversation ${c.id} · started ${fmtTime(c.createdAt)} · last activity ${fmtTime(c.updatedAt)}${crew}`;
  });
  return [`Recent chats (builder preview + customer /live), newest first (times in ${TZ}):`, ...lines].join('\n');
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

module.exports = {
  listAgents,
  readAgent,
  listConversations,
  readConversation,
  readRun,
  changeLogText,
};
