/**
 * Admin → Conversations (tasks #922, #917, #924) — the list screen and the
 * conversation screen with its three tabs (Conversation · Profiler · Add-ons).
 * Mounted under /api/agents (see runtimeRoute.js). Read-only.
 *
 *   GET /:slug/admin/conversation-list   ?q &from &to &source &userId &limit &offset
 *       q      — a conversation id (#4707 or 4707), or part of a user's name / id
 *       from/to — ISO dates on LAST ACTIVITY (updatedAt), inclusive days
 *       source — live | builder | simulation
 *       → { conversations, total, counts: { all, live, builder, simulation }, agent }
 *
 *   GET /:slug/admin/conversations/:id/overview
 *       → { conversation, profile: { fields, panels }, runs }
 *       runs are summaries in turn order — the Add-ons tab lists them and
 *       fetches one in full on demand:
 *   GET /:slug/admin/runs/:runId          → { run }  (the full addon_runs row)
 *
 * Designed with Leonardo: lybi-website/art-source/ui/admin-conversations/.
 */

const express = require('express');
const { eq, and, desc, asc, inArray, sql } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { agents, conversations, messages, users, addonRuns } = require('../../db/schema');
const builderProjects = require('../services/builderProjects');
const builderMemory = require('../runtime/builderMemory');
const { resolveProfilerPanelsForClient } = require('../runtime/profilerDispatcher');

const router = express.Router({ mergeParams: true });
const drizzle = () => db.getDrizzle();

const KIND_OF_SOURCE = { live: 'live', builder: 'builder-preview', simulation: 'simulation' };
const sourceOf = meta => (meta?.kind === 'live' ? 'live'
  : meta?.kind === 'builder-preview' ? 'builder'
    : meta?.kind === 'simulation' ? 'simulation' : null);

/** Raw SQL returns `timestamp` (UTC, no zone) as text — make it ISO with Z. */
const iso = v => (v instanceof Date ? v.toISOString() : v ? `${String(v).replace(' ', 'T')}Z` : null);

/** The agent's Builder name (the legacy agents row says "Builder — <slug>"). */
async function builderNameOf(slug, fallback) {
  try {
    const p = await builderProjects.hydrateProject({ agentSlug: slug });
    return (p && p.agents[0] && p.agents[0].name) || fallback;
  } catch { return fallback; }
}

async function agentRowOf(slug) {
  const [row] = await drizzle().select().from(agents).where(eq(agents.urlSlug, slug)).limit(1);
  return row || null;
}

/** WHERE clauses shared by the list and its counts (all filters but `source`). */
function baseWhere(agentId, { q, from, to, userId }) {
  const w = [sql`c.agent_id = ${agentId}`, sql`c.kind = 'user'`];
  if (userId) w.push(sql`c.user_id = ${Number(userId)}`);
  if (from) w.push(sql`c.updated_at >= ${new Date(from)}`);
  if (to) { const t = new Date(to); t.setDate(t.getDate() + 1); w.push(sql`c.updated_at < ${t}`); }
  const text = String(q || '').trim().replace(/^#/, '');
  if (text) {
    const like = `%${text}%`;
    w.push(/^\d+$/.test(text)
      ? sql`(c.id = ${Number(text)} or u.name ilike ${like} or u.external_id ilike ${like})`
      : sql`(u.name ilike ${like} or u.external_id ilike ${like} or c.metadata->>'name' ilike ${like})`);
  }
  return w;
}

router.get('/:slug/admin/conversation-list', async (req, res) => {
  try {
    const agent = await agentRowOf(req.params.slug);
    if (!agent) return res.json({ conversations: [], total: 0, counts: { all: 0, live: 0, builder: 0, simulation: 0 }, agent: null });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = baseWhere(agent.id, req.query);
    const src = KIND_OF_SOURCE[req.query.source];
    const whereAll = sql.join(where, sql` and `);
    const whereShown = src ? sql`${whereAll} and c.metadata->>'kind' = ${src}` : whereAll;
    const from = sql`from conversations c left join users u on u.id = c.user_id`;

    const d = drizzle();
    const [countRes, totalRes, rowsRes] = await Promise.all([
      d.execute(sql`select c.metadata->>'kind' as kind, count(*) as n ${from} where ${whereAll} group by 1`),
      d.execute(sql`select count(*) as n ${from} where ${whereShown}`),
      d.execute(sql`select c.id, c.metadata, c.created_at, c.updated_at, c.user_id, u.external_id, u.name as user_name
        ${from} where ${whereShown} order by c.updated_at desc limit ${limit} offset ${offset}`),
    ]);
    const counts = { all: 0, live: 0, builder: 0, simulation: 0 };
    for (const r of countRes.rows) {
      const n = Number(r.n);
      counts.all += n;
      const s = sourceOf({ kind: r.kind });
      if (s) counts[s] += n;
    }
    const ids = rowsRes.rows.map(r => r.id);
    const msgCounts = {};
    if (ids.length) {
      const mc = await d.select({ id: messages.conversationId, n: sql`count(*)`.mapWith(Number) })
        .from(messages).where(inArray(messages.conversationId, ids)).groupBy(messages.conversationId);
      for (const m of mc) msgCounts[m.id] = m.n;
    }
    res.json({
      agent: { slug: agent.urlSlug, name: await builderNameOf(agent.urlSlug, agent.name) },
      total: Number(totalRes.rows[0]?.n || 0),
      counts,
      conversations: rowsRes.rows.map(r => ({
        id: r.id,
        name: r.metadata?.name || null,
        source: sourceOf(r.metadata),
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
        messageCount: msgCounts[r.id] || 0,
        userId: r.user_id,
        ownerUserId: r.external_id || null,
        ownerName: r.user_name || null,
        simulatedBy: r.metadata?.simulation?.by || null,
      })),
    });
  } catch (err) {
    console.error('[admin-conversations] list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

const clip = (v, n) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t && t.length > n ? `${t.slice(0, n - 1)}…` : (t ?? '');
};

/** A readable name for a nested judgement: its name/decision, else its first text. */
function headOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['product_name', 'name', 'title', 'decision', 'recommendation', 'label']) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k];
  }
  const first = Object.values(obj).find(v => typeof v === 'string' && v.trim());
  return first || null;
}

/**
 * One line that says what a step concluded — so the chain reads as a story
 * without opening anything (failure/skip reason, the reply, a crew move,
 * the main judgement, or what it wrote).
 */
function oneLineOf(run, crewNameOf) {
  const d = run.runData || {};
  if (run.status === 'skipped') return d.reason || d.skipReason || 'skipped';
  if (d.error?.message) return d.error.message;
  if (run.pluginId === 'talker') return 'wrote the reply';
  if (d.transition?.to) return `moved the conversation to ${crewNameOf(d.transition.to)}`;
  const p = d.parsedOutput;
  if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0) return 'found nothing new';
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const parts = [];
    for (const [k, v] of Object.entries(p)) {
      if (parts.length >= 3) break;
      if (v === null || v === '' || v === undefined) continue;
      if (typeof v === 'object' && !Array.isArray(v)) { const h = headOf(v); if (h) parts.push(`${k}: ${clip(h, 40)}`); }
      else if (typeof v !== 'object') parts.push(`${k}: ${clip(v, 40)}`);
    }
    if (parts.length) return parts.join(' · ');
  }
  const writes = (d.memoryWrites || []).filter(w => w && w.field && w.value !== undefined);
  if (writes.length) return `wrote ${writes.slice(0, 3).map(w => `${w.field} = ${clip(w.value, 24)}`).join(', ')}`;
  if (d.parseError) return d.parseError;
  const raw = String(d.rawOutput || '').replace(/\s+/g, ' ').trim();
  return raw ? clip(raw, 90) : '';
}

/** The value a field holds in the brain: its own domain first, then any. */
function valueOf(memory, field) {
  const own = memory?.[field.domain || '_general'];
  if (own && own[field.name] !== undefined) return own[field.name];
  for (const bucket of Object.values(memory || {})) {
    if (bucket && typeof bucket === 'object' && bucket[field.name] !== undefined) return bucket[field.name];
  }
  return undefined;
}

router.get('/:slug/admin/conversations/:id/overview', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = drizzle();
    const agent = await agentRowOf(req.params.slug);
    const [row] = await d.select({ conv: conversations, user: users }).from(conversations)
      .leftJoin(users, eq(conversations.userId, users.id))
      .where(eq(conversations.id, id)).limit(1);
    if (!agent || !row || row.conv.agentId !== agent.id) {
      return res.status(404).json({ error: `No conversation ${req.params.id} for this agent.` });
    }
    const { conv, user } = row;
    const meta = conv.metadata || {};

    const msgs = await d.select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt), asc(messages.id));
    // Turn = the n-th user message; an assistant reply belongs to the turn before it.
    const turnOf = {};
    const lineOf = {};
    let turn = 0;
    let lastUser = '';
    for (const m of msgs) {
      if (m.role === 'user') { turn += 1; lastUser = String(m.content || ''); }
      turnOf[m.id] = turn;
      lineOf[m.id] = lastUser;
    }

    const runRows = await d.select().from(addonRuns).where(eq(addonRuns.conversationId, id)).orderBy(asc(addonRuns.startedAt));
    let crewNames = {};
    // Which crew an add-on belongs to — so each turn can say which crew handled it.
    let crewOfInstance = {};
    try {
      const p = await builderProjects.hydrateProject({ agentSlug: req.params.slug });
      for (const c of (p && p.agents[0] && p.agents[0].crews) || []) {
        crewNames[c.id] = c.name;
        for (const a of c.addons || []) crewOfInstance[a.instanceId || a.id] = c.name;
      }
    } catch { crewNames = {}; crewOfInstance = {}; }
    const crewNameOf = cid => crewNames[cid] || cid;
    // Steps ran in parallel when one started (within 50 ms of the other's
    // start) while the other was still running — same reply, same lane. A
    // step that simply followed a very fast one is NOT parallel.
    let group = 0;
    const groupOf = [];
    runRows.forEach((r, i) => {
      const prev = runRows[i - 1];
      const startPrev = prev ? new Date(prev.startedAt).getTime() : 0;
      const start = new Date(r.startedAt).getTime();
      const together = prev && prev.messageId === r.messageId
        && (prev.runData?.lane || 'main') === (r.runData?.lane || 'main')
        && prev.status !== 'skipped' && r.status !== 'skipped'
        && start - startPrev < 50 && start < startPrev + (prev.durationMs || 0) - 5;
      if (!together) group += 1;
      groupOf.push(group);
    });
    const runs = runRows.map((r, i) => ({
      lane: r.runData?.lane || 'main',
      group: groupOf[i],
      summary: oneLineOf(r, crewNameOf),
      transitionTo: r.runData?.transition?.to ? crewNameOf(r.runData.transition.to) : null,
      writes: (r.runData?.memoryWrites || []).filter(w => w && w.field).map(w => ({
        kind: w.kind || 'memory', domain: w.domain || null, field: w.field, value: typeof w.value === 'string' ? clip(w.value, 400) : w.value,
      })),
      id: r.id,
      instanceId: r.instanceId,
      crewName: crewOfInstance[r.instanceId] || null,
      pluginId: r.pluginId,
      label: r.runData?.label || r.pluginId,
      status: r.status,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      messageId: r.messageId,
      turn: r.messageId ? (turnOf[r.messageId] ?? null) : null,
      userLine: r.messageId ? String(lineOf[r.messageId] || '').slice(0, 90) : '',
      modelLabel: r.runData?.modelLabel || null,
      error: r.runData?.error || null,
    }));

    // The profile: every declared field (agent + crews), filled or not, and the Profiler panels.
    let fields = [];
    let panels = [];
    let crewName = null;
    let agentDisplayName = null;
    try {
      const project = await builderProjects.hydrateProject({ agentSlug: req.params.slug });
      const a = project && project.agents[0];
      if (a) {
        const blob = await builderMemory.loadMemory(conv.userId, id);
        const seen = new Set();
        const defs = [...(a.fields || []), ...(a.crews || []).flatMap(c => c.fields || [])]
          .filter(f => f && f.name && !seen.has(f.name) && seen.add(f.name));
        fields = defs.map(f => {
          const v = valueOf(blob.memory, f);
          const filled = v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
          return { name: f.name, domain: f.domain || null, type: f.type, value: filled ? v : null, filled };
        });
        const profiler = a.profiler?.enabled === false ? null : a.profiler;
        if (Array.isArray(profiler?.panels) && profiler.panels.length) {
          panels = resolveProfilerPanelsForClient(profiler.panels, blob);
        }
        agentDisplayName = a.name || null;
        const crew = (a.crews || []).find(c => c.id === (meta.currentCrewId || a.defaultCrewId));
        crewName = crew ? crew.name : null;
      }
    } catch (e) {
      console.warn('[admin-conversations] profile unavailable:', e.message);
    }

    res.json({
      conversation: {
        id: conv.id,
        name: meta.name || null,
        source: sourceOf(meta),
        agentName: agentDisplayName || agent.name,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: msgs.length,
        ownerUserId: user ? user.externalId : null,
        ownerName: user ? (user.name || null) : null,
        simulatedBy: meta.simulation?.by || null,
        crewName,
      },
      profile: { fields, panels },
      runs,
    });
  } catch (err) {
    console.error('[admin-conversations] overview failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:slug/admin/runs/:runId', async (req, res) => {
  try {
    const d = drizzle();
    const [run] = await d.select().from(addonRuns).where(eq(addonRuns.id, String(req.params.runId))).limit(1);
    const agent = run ? await agentRowOf(req.params.slug) : null;
    const [conv] = run && agent ? await d.select({ agentId: conversations.agentId }).from(conversations)
      .where(eq(conversations.id, run.conversationId)).limit(1) : [];
    if (!run || !conv || conv.agentId !== agent.id) return res.status(404).json({ error: `No run ${req.params.runId} for this agent.` });
    res.json({ run });
  } catch (err) {
    console.error('[admin-conversations] run failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
