/**
 * Builder V2 — export one conversation as JSON (task #861).
 *
 * Built for handing a conversation to ANOTHER AI for analysis, so the
 * output is self-describing: a header with a one-line `format` sentence,
 * then the messages in order with each assistant turn's addon runs
 * nested under it — the same grouping the Builder Chat history view
 * shows (UserChat loads messages, then `addon_runs` by message id).
 *
 * One function, three callers: the Builder Chat "Export" modal (via
 * builder/routes/conversationExportRoute.js), the MCP door
 * (GET /builder/mcp/conversations/:id/export) and anything server-side.
 * Keeping it in one place is the point — an export that differs by
 * surface would make "the AI saw something else" impossible to debug.
 *
 * Levels (`include`):
 *   messages — role, text, timestamp, crew (when known)
 *   outputs  — + per assistant turn, its addon runs: output, field
 *              writes, rejected writes, transition, skip reason
 *   full     — + each run's assembled prompt (large; lowest priority)
 */

const db = require('../../services/db.pg');
const { eq, asc } = require('drizzle-orm');
const { conversations, messages, addonRuns, agents } = require('../../db/schema');
const builderProjects = require('./builderProjects');

const LEVELS = ['messages', 'outputs', 'full'];

function drizzle() {
  return db.getDrizzle();
}

function normalizeLevel(include) {
  return LEVELS.includes(include) ? include : 'outputs';
}

const FORMAT = {
  messages: 'messages[] in chronological order; each has role (user|assistant|system), text, at (ISO time) and crew when known.',
  outputs: 'messages[] in chronological order; each has role, text, at, crew when known. Assistant messages carry addonRuns[] — the addons that ran on that turn, in run order: label, pluginId, lane (main|offline), status, output (parsed, else raw), fieldWrites, rejectedWrites, transition, skipReason.',
  full: 'Same as the outputs level, plus each addon run carries prompt — the exact assembled prompt the addon\'s LLM received.',
};

/**
 * crewId → crew name, and addon instanceId → crew, from the agent's
 * working copy. Used to label turns with the crew that ran them: normal
 * turns don't store a crew on the message, but every run's instanceId
 * belongs to exactly one crew's chain. Best-effort — an addon deleted
 * since the conversation simply leaves the turn unlabelled.
 */
function crewIndex(agent) {
  const crewNames = new Map();
  const crewOfInstance = new Map();
  for (const c of (agent && agent.crews) || []) {
    crewNames.set(c.id, c.name || c.id);
    for (const a of c.addons || []) {
      if (a && a.instanceId) crewOfInstance.set(a.instanceId, c.id);
    }
  }
  return { crewNames, crewOfInstance };
}

function crewRef(crewId, crewNames) {
  if (!crewId) return null;
  return { id: crewId, name: crewNames.get(crewId) || null };
}

/** One addon_runs row → the export shape for this level. */
function exportRun(row, level) {
  const d = row.runData || {};
  const out = {
    runId: row.id,
    label: d.label || row.pluginId,
    pluginId: row.pluginId,
    instanceId: row.instanceId,
    lane: d.lane || null,
    status: row.status,
    durationMs: row.durationMs ?? d.durationMs ?? null,
  };
  if (row.status === 'skipped') {
    out.skipReason = d.reason || null;
    return out;
  }
  // Parsed output is what the platform acted on; raw is the fallback for
  // text-output addons (Talker) and for runs whose parse failed.
  const parsed = d.parsedOutput;
  out.output = parsed !== undefined && parsed !== null ? parsed : (d.rawOutput ?? null);
  if (d.parseError) {
    out.parseError = d.parseError;
    out.rawOutput = d.rawOutput ?? null;
  }
  if (Array.isArray(d.memoryWrites) && d.memoryWrites.length > 0) out.fieldWrites = d.memoryWrites;
  if (Array.isArray(d.rejectedWrites) && d.rejectedWrites.length > 0) out.rejectedWrites = d.rejectedWrites;
  if (d.transition) out.transition = d.transition;
  if (d.broke) out.brokeChain = true;
  // Non-LLM addons (router, text panels) store an empty prompt.
  if (level === 'full') out.prompt = d.prompt || null;
  return out;
}

/**
 * Build the export for one conversation.
 *
 * @param {object} args
 * @param {number|string} args.conversationId
 * @param {'messages'|'outputs'|'full'} [args.include='outputs']
 * @param {string} [args.agentSlug] when given, the conversation must
 *   belong to this agent — the HTTP route passes its :slug so a wrong
 *   pairing answers 404 instead of exporting someone else's chat.
 * @returns {Promise<object|null>} null when the conversation doesn't exist
 *   (or doesn't belong to `agentSlug`).
 */
async function exportConversation({ conversationId, include, agentSlug }) {
  const level = normalizeLevel(include);
  const convId = Number(conversationId);
  if (!Number.isFinite(convId)) return null;
  const d = drizzle();

  const [row] = await d.select({ conv: conversations, agent: agents })
    .from(conversations)
    .leftJoin(agents, eq(conversations.agentId, agents.id))
    .where(eq(conversations.id, convId))
    .limit(1);
  if (!row) return null;
  const slug = (row.agent && row.agent.urlSlug) || null;
  if (agentSlug && slug !== agentSlug) return null;

  const msgs = await d.select().from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  // One query for every run of the conversation, grouped in memory —
  // not one per message like the history view's lazy expand. Fetched
  // even at the `messages` level: the runs are how a turn's crew is
  // known (see crewIndex).
  const runsByMessage = new Map();
  const runRows = await d.select().from(addonRuns)
    .where(eq(addonRuns.conversationId, convId))
    .orderBy(asc(addonRuns.startedAt));
  for (const r of runRows) {
    // Unattached rows are silent proactive attempts — no message to
    // hang them on. Hidden rows are brain/profiler text panels that
    // resolved to nothing; the Builder doesn't show them either.
    if (r.messageId == null || (r.runData && r.runData.hidden)) continue;
    if (!runsByMessage.has(r.messageId)) runsByMessage.set(r.messageId, []);
    runsByMessage.get(r.messageId).push(r);
  }

  let project = null;
  if (slug) {
    try { project = await builderProjects.hydrateProject({ agentSlug: slug }); }
    catch (err) { console.warn('[conversationExport] hydrate failed:', err.message); }
  }
  const agent = project && project.agents && project.agents[0];
  const { crewNames, crewOfInstance } = crewIndex(agent);

  const out = [];
  for (const m of msgs) {
    // The placeholder of a turn that produced no text (stopped, or still
    // streaming) is not something the user saw.
    if (m.role === 'assistant' && !m.content && !runsByMessage.has(m.id)) continue;
    const meta = m.metadata || {};
    const runs = runsByMessage.get(m.id) || [];
    // Crew: proactive turns record it; otherwise the first addon that
    // ran belongs to the crew whose chain ran.
    let crewId = meta.crewId || null;
    if (!crewId) {
      const owned = runs.find(r => crewOfInstance.has(r.instanceId));
      if (owned) crewId = crewOfInstance.get(owned.instanceId);
    }
    const entry = {
      id: m.id,
      role: m.role,
      text: m.content || '',
      at: m.createdAt,
    };
    const crew = crewRef(crewId, crewNames);
    if (crew) entry.crew = crew;
    if (meta.proactive) entry.proactive = true;
    if (level !== 'messages' && m.role === 'assistant') {
      entry.addonRuns = runs.map(r => exportRun(r, level));
    }
    out.push(entry);
  }

  return {
    export: {
      kind: 'lybi-builder-conversation',
      format: FORMAT[level],
      include: level,
      exportedAt: new Date().toISOString(),
      agent: {
        slug,
        name: (agent && agent.name) || (row.agent && row.agent.name) || null,
      },
      conversation: {
        id: convId,
        name: (row.conv.metadata && row.conv.metadata.name) || null,
        createdAt: row.conv.createdAt,
        currentCrew: crewRef(row.conv.metadata && row.conv.metadata.currentCrewId, crewNames),
      },
      messageCount: out.length,
    },
    messages: out,
  };
}

module.exports = { exportConversation, LEVELS };
