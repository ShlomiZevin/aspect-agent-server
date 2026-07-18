/**
 * Builder V2 — runtime + conversations routes.
 *
 * Mounted on `/api/agents/:slug` so a future customer-facing v2
 * chat can call the same endpoints with `version: 'active'` (no
 * rename). Today only the builder UI calls them, with
 * `version: 'viewing'`.
 *
 * Endpoints:
 *   POST   /:slug/conversations
 *   GET    /:slug/conversations           ?ownerUserId=…
 *   GET    /:slug/conversations/:convId/messages
 *   DELETE /:slug/conversations/:convId
 *   POST   /:slug/conversations/:convId/messages   → SSE stream
 */

const express = require('express');
const { eq, and, desc, inArray, sql } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { agents, conversations, messages, users } = require('../../db/schema');
const { runOnce } = require('../runtime/BuilderRunner');

const router = express.Router({ mergeParams: true });

function drizzle() {
  return db.getDrizzle();
}

/**
 * Resolve / create the legacy `agents` row that backs builder
 * conversations for this slug. Conversations.agentId is a FK to
 * legacy agents (serial int), so we either reuse the existing row
 * or insert a placeholder. Builder-preview conversations are
 * tagged via metadata.kind = 'builder-preview'.
 */
async function resolveLegacyAgentId(slug) {
  const d = drizzle();
  const existing = await d.select().from(agents).where(eq(agents.urlSlug, slug)).limit(1);
  if (existing.length > 0) return existing[0].id;
  // Insert a placeholder agent for the builder. Keeps FK happy
  // without polluting the legacy listing — name distinct.
  const [created] = await d.insert(agents).values({
    name: `Builder · ${slug}`,
    urlSlug: slug,
    domain: 'builder-v2',
    description: 'Auto-created by the V2 builder for preview conversations.',
    isActive: false,
  }).returning();
  return created.id;
}

async function resolveUserId(ownerUserId) {
  const d = drizzle();
  if (!ownerUserId) throw new Error('Missing ownerUserId');
  const existing = await d.select().from(users)
    .where(eq(users.externalId, String(ownerUserId)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [created] = await d.insert(users).values({
    externalId: String(ownerUserId),
    role: 'user',
    source: 'web',
    subscription: 'demo',
  }).returning();
  return created.id;
}

/**
 * POST /api/agents/:slug/conversations
 *   Body: { ownerUserId, seedMemory?: [{ field, value, domain? }] }
 *   Creates a new conversation row, returns { conversationId }.
 *
 *   `seedMemory` (optional) — starting field values the conversation is
 *   BORN with (builder "enter data before the chat starts", task #765).
 *   Written through the same brain path the memory PATCH endpoint uses,
 *   as part of creation — so the very first turn's extractors, DC
 *   tokens and {{fields_current}} already see them. Mirrors the pinned-
 *   fields precedent (values existing before the user says anything is
 *   a runtime concept, owned server-side).
 */
router.post('/:slug/conversations', async (req, res) => {
  try {
    const { slug } = req.params;
    const { ownerUserId, seedMemory } = req.body || {};
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const agentId = await resolveLegacyAgentId(slug);
    const userId = await resolveUserId(ownerUserId);
    const [conv] = await drizzle().insert(conversations).values({
      userId,
      agentId,
      channel: 'web',
      status: 'active',
      kind: 'user',
      metadata: { kind: 'builder-preview', agentSlug: slug },
    }).returning();
    if (Array.isArray(seedMemory) && seedMemory.length > 0) {
      const builderMemory = require('../runtime/builderMemory');
      const blob = await builderMemory.loadMemory(userId, conv.id);
      for (const s of seedMemory) {
        if (!s || typeof s.field !== 'string' || !s.field.trim() || s.value === undefined) continue;
        const domain = typeof s.domain === 'string' && s.domain.trim() ? s.domain.trim() : null;
        builderMemory.setField(blob, s.field.trim(), s.value, domain, 'memory');
      }
      await builderMemory.saveMemory(userId, conv.id, blob);
    }
    res.json({ conversationId: conv.id });
  } catch (err) {
    console.error('[builder] POST conversation failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/conversations?ownerUserId=:uid
 *   List builder-preview conversations for this slug + owner. Each
 *   row includes a `name` derived from `metadata.name` (custom or
 *   auto-generated from the first user message).
 */
router.get('/:slug/conversations', async (req, res) => {
  try {
    const { slug } = req.params;
    const { ownerUserId } = req.query;
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const d = drizzle();
    const [agentRow] = await d.select().from(agents).where(eq(agents.urlSlug, slug)).limit(1);
    if (!agentRow) return res.json({ conversations: [] });
    const userRow = await d.select().from(users)
      .where(eq(users.externalId, String(ownerUserId))).limit(1);
    if (userRow.length === 0) return res.json({ conversations: [] });
    const list = await d.select()
      .from(conversations)
      .where(and(
        eq(conversations.agentId, agentRow.id),
        eq(conversations.userId, userRow[0].id),
        eq(conversations.kind, 'user'),
      ))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    res.json({ conversations: list.map(c => ({
      id: c.id,
      name: (c.metadata && c.metadata.name) || null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      metadata: c.metadata,
    })) });
  } catch (err) {
    console.error('[builder] GET conversations failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/admin/conversations?limit=:n
 *   ADMIN view: every `user`-kind conversation for this agent,
 *   regardless of owner (the owner-scoped list above filters by
 *   `ownerUserId`; admins need the whole picture). Keyed only by the
 *   runtime `agents.id` resolved from the slug. Joins the owning user
 *   so the admin can see who each conversation belongs to, and counts
 *   messages in one grouped query (no N+1).
 *
 *   Returns [] (not 404) when the agent has no runtime row yet — a
 *   brand-new builder agent simply has no conversations.
 */
router.get('/:slug/admin/conversations', async (req, res) => {
  try {
    const { slug } = req.params;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    // Optional: scope to a single owner (internal users.id) — powers the
    // Users tab → "view conversations" drill-down.
    const userIdFilter = req.query.userId ? Number(req.query.userId) : null;
    const d = drizzle();
    const [agentRow] = await d.select().from(agents).where(eq(agents.urlSlug, slug)).limit(1);
    if (!agentRow) return res.json({ conversations: [] });

    const rows = await d.select({ conv: conversations, user: users })
      .from(conversations)
      .leftJoin(users, eq(conversations.userId, users.id))
      .where(and(
        eq(conversations.agentId, agentRow.id),
        eq(conversations.kind, 'user'),
        ...(userIdFilter ? [eq(conversations.userId, userIdFilter)] : []),
      ))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit);

    // Message counts for the listed conversations, grouped in one query.
    const ids = rows.map(r => r.conv.id);
    const counts = {};
    if (ids.length > 0) {
      const countRows = await d.select({
        conversationId: messages.conversationId,
        n: sql`count(*)`.mapWith(Number),
      })
        .from(messages)
        .where(inArray(messages.conversationId, ids))
        .groupBy(messages.conversationId);
      for (const c of countRows) counts[c.conversationId] = c.n;
    }

    res.json({ conversations: rows.map(({ conv, user }) => ({
      id: conv.id,
      name: (conv.metadata && conv.metadata.name) || null,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messageCount: counts[conv.id] || 0,
      currentCrewId: (conv.metadata && conv.metadata.currentCrewId) || null,
      // Owner identity — `ownerUserId` is the external id the builder
      // mints client-side; `userId` is the internal serial.
      userId: conv.userId,
      ownerUserId: user ? user.externalId : null,
      ownerName: user ? (user.name || null) : null,
    })) });
  } catch (err) {
    console.error('[builder] GET admin conversations failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/agents/:slug/conversations/:convId
 *   Body: { name }
 *   Renames a conversation by writing `metadata.name`.
 */
router.patch('/:slug/conversations/:convId', async (req, res) => {
  try {
    const { convId } = req.params;
    const { name } = req.body || {};
    if (typeof name !== 'string') return res.status(400).json({ error: 'Missing name' });
    const d = drizzle();
    const [conv] = await d.select().from(conversations)
      .where(eq(conversations.id, Number(convId))).limit(1);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const trimmed = name.trim();
    const nextMeta = { ...(conv.metadata || {}), name: trimmed };
    await d.update(conversations)
      .set({ metadata: nextMeta, updatedAt: new Date() })
      .where(eq(conversations.id, Number(convId)));
    res.json({ ok: true, name: trimmed });
  } catch (err) {
    console.error('[builder] PATCH conversation failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/conversations/:convId/messages
 */
router.get('/:slug/conversations/:convId/messages', async (req, res) => {
  try {
    const { convId } = req.params;
    const list = await drizzle().select()
      .from(messages)
      .where(eq(messages.conversationId, Number(convId)))
      .orderBy(messages.createdAt);
    res.json({ messages: list.map(m => ({
      id: m.id, role: m.role, content: m.content, createdAt: m.createdAt,
    })) });
  } catch (err) {
    console.error('[builder] GET messages failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/conversations/:convId/memory
 *   Returns the per-conversation brain blob — three parallel sections:
 *     {
 *       memory:    { "<domain>": { fieldName: value, ... }, ... },
 *       thinking:  { "<domain>": { fieldName: value, ... }, ... },
 *       summary:   { "<summarizerName>": { text, watermark, ranAt }, ... }
 *     }
 *   `memory` holds facts (Field/Vibe Extractor writes); `thinking`
 *   holds the current plan (Thinker / Field Interviewer writes);
 *   `summary` holds rolling Summarizer checkpoints. The `_general`
 *   bucket inside the first two sections holds domain-less fields;
 *   `summary` is flat (keyed by free-form summarizer name, no domain).
 */
router.get('/:slug/conversations/:convId/memory', async (req, res) => {
  try {
    const { convId } = req.params;
    const { ownerUserId } = req.query;
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const userId = await resolveUserId(String(ownerUserId));
    const builderMemory = require('../runtime/builderMemory');
    const blob = await builderMemory.loadMemory(userId, Number(convId));
    res.json({
      memory:    blob.memory,
      thinking:  blob.thinking,
      summary:   blob.summary || {},
      // Ephemeral KB Retriever slots ({{kb:NAME}} injection text) — the
      // Live Brain panel renders these under "Knowledge".
      retrieval: blob.retrieval || {},
      // Live Brain panel outputs, keyed by panel id. Raw (no filter/config
      // join) — the builder screen joins them with its working-copy config.
      panels: blob.panels || {},
    });
  } catch (err) {
    console.error('[builder] GET memory failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/agents/:slug/conversations/:convId/memory
 *   Body: { ownerUserId, field, value?, domain?, kind?: 'memory'|'thinking', clear?: boolean }
 *   - clear=true → removes the field from every bucket of the section.
 *   - otherwise → sets it under `domain` (or `_general` if null/missing)
 *     in the requested section. Defaults to `kind: 'memory'`.
 *   Returns the updated brain blob ({ memory, thinking }).
 */
router.patch('/:slug/conversations/:convId/memory', async (req, res) => {
  try {
    const { convId } = req.params;
    const { ownerUserId, field, value, domain, kind, clear } = req.body || {};
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    if (!field) return res.status(400).json({ error: 'Missing field' });
    const userId = await resolveUserId(String(ownerUserId));
    const builderMemory = require('../runtime/builderMemory');
    const section = kind === 'thinking' ? 'thinking' : 'memory';
    const blob = await builderMemory.loadMemory(userId, Number(convId));
    if (clear) {
      builderMemory.clearField(blob, field, section);
    } else {
      builderMemory.setField(blob, field, value, domain ?? null, section);
    }
    await builderMemory.saveMemory(userId, Number(convId), blob);
    res.json({
      memory:   blob.memory,
      thinking: blob.thinking,
    });
  } catch (err) {
    console.error('[builder] PATCH memory failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/conversations/:convId/live-brain
 *   Resolve the agent's Live Brain panels for this conversation into
 *   render-ready content. Applies each panel's filter (hidden panels are
 *   omitted) and returns only panels that currently hold a valid value
 *   (text resolved from tokens every turn; AI panels computed on their
 *   cadence). This is what the customer Live Brain + the builder preview
 *   render.
 *
 *   Query: ownerUserId (required), version ('active' default | 'viewing' | 'published').
 *   Returns { panels: [{ id, title, render, text?|values?, ranAt }] }.
 */
router.get('/:slug/conversations/:convId/live-brain', async (req, res) => {
  try {
    const { slug, convId } = req.params;
    const { ownerUserId, version = 'active' } = req.query;
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const userId = await resolveUserId(String(ownerUserId));
    const builderMemory = require('../runtime/builderMemory');
    const { resolveRunnable } = require('../services/builderProjects');
    const { resolvePanelsForClient } = require('../runtime/liveBrainDispatcher');

    const mode = version === 'viewing' ? 'viewing'
      : version === 'published' ? 'published'
      : 'active';

    let runnable;
    try {
      runnable = await resolveRunnable({ agentSlug: String(slug), ownerUserId: String(ownerUserId), mode });
    } catch {
      // Agent not built / no active version yet — nothing to show.
      return res.json({ panels: [] });
    }

    const panels = Array.isArray(runnable?.agent?.body?.liveBrain?.panels)
      ? runnable.agent.body.liveBrain.panels
      : [];
    if (panels.length === 0) return res.json({ panels: [] });

    const blob = await builderMemory.loadMemory(userId, Number(convId));
    // Same resolver the live `brain.snapshot` uses — the initial-load
    // shape is byte-for-byte what streaming updates deliver.
    res.json({ panels: resolvePanelsForClient(panels, blob) });
  } catch (err) {
    console.error('[builder] GET live-brain failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/conversations/:convId/live-brain/runs
 *   Recent Live Brain panel runs for a conversation (newest first),
 *   filtered to the `live-brain-panel` plugin so the builder's run
 *   inspector shows brain activity only — never chat addons. Each row's
 *   `runData` mirrors the addon.output shape (input prompt, output,
 *   duration, model).
 */
router.get('/:slug/conversations/:convId/live-brain/runs', async (req, res) => {
  try {
    const { convId } = req.params;
    const addonRunsStore = require('../runtime/addonRunsStore');
    const rows = await addonRunsStore.recentRunsForConversation(Number(convId), 'live-brain-panel', 40);
    res.json({
      runs: rows.map(r => ({
        id:         r.id,
        instanceId: r.instanceId,
        pluginId:   r.pluginId,
        status:     r.status,
        durationMs: r.durationMs,
        runData:    r.runData,
        startedAt:  r.startedAt,
        endedAt:    r.endedAt,
      })),
    });
  } catch (err) {
    console.error('[builder] GET live-brain runs failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/agents/:slug/conversations/:convId
 *   Cascade: addon_runs, messages, conversation.
 */
router.delete('/:slug/conversations/:convId', async (req, res) => {
  try {
    const { convId } = req.params;
    const addonRunsStore = require('../runtime/addonRunsStore');
    await addonRunsStore.deleteForConversation(Number(convId));
    const d = drizzle();
    await d.transaction(async tx => {
      await tx.delete(messages).where(eq(messages.conversationId, Number(convId)));
      await tx.delete(conversations).where(eq(conversations.id, Number(convId)));
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] DELETE conversation failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/:slug/messages/:messageId/runs
 *   Returns persisted addon_runs for an assistant message. The
 *   payloads mirror the live SSE addon.output shape, so the
 *   historical view can rehydrate AddonRunCards identically.
 */
router.get('/:slug/messages/:messageId/runs', async (req, res) => {
  try {
    const { messageId } = req.params;
    const addonRunsStore = require('../runtime/addonRunsStore');
    const rows = await addonRunsStore.runsForMessage(Number(messageId));
    res.json({
      runs: rows.map(r => ({
        id:         r.id,
        instanceId: r.instanceId,
        pluginId:   r.pluginId,
        status:     r.status,
        durationMs: r.durationMs,
        runData:    r.runData,
        startedAt:  r.startedAt,
        endedAt:    r.endedAt,
      })),
    });
  } catch (err) {
    console.error('[builder] GET runs failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/agents/:slug/conversations/:convId/messages/:messageId
 *   Body: { fromHereDown?: boolean }
 *   When `fromHereDown` is true, also deletes every message inserted
 *   after this one (and their addon_runs). Otherwise just this one.
 */
router.delete('/:slug/conversations/:convId/messages/:messageId', async (req, res) => {
  try {
    const { convId, messageId } = req.params;
    const fromHereDown = !!(req.body && req.body.fromHereDown);
    const addonRunsStore = require('../runtime/addonRunsStore');
    const d = drizzle();

    // Look up the cutoff message (its createdAt) for from-here-down.
    const [pivot] = await d.select().from(messages)
      .where(and(eq(messages.id, Number(messageId)), eq(messages.conversationId, Number(convId))))
      .limit(1);
    if (!pivot) return res.status(404).json({ error: 'Message not found' });

    if (fromHereDown) {
      // All messages with createdAt >= pivot.createdAt for this conv.
      const { gte } = require('drizzle-orm');
      const victims = await d.select({ id: messages.id }).from(messages)
        .where(and(
          eq(messages.conversationId, Number(convId)),
          gte(messages.createdAt, pivot.createdAt),
        ));
      for (const v of victims) await addonRunsStore.deleteForMessage(v.id);
      await d.delete(messages)
        .where(and(
          eq(messages.conversationId, Number(convId)),
          gte(messages.createdAt, pivot.createdAt),
        ));
    } else {
      await addonRunsStore.deleteForMessage(Number(messageId));
      await d.delete(messages).where(eq(messages.id, Number(messageId)));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] DELETE message failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:slug/conversations/:convId/messages
 *   The runtime call. Streams SSE.
 *   Body: { ownerUserId, userMessage, version: 'viewing'|'active' }
 */
router.post('/:slug/conversations/:convId/messages', async (req, res) => {
  const { slug, convId } = req.params;
  const {
    ownerUserId,
    userMessage,
    version = 'viewing',
    overrideCrewId = null,
    // Working-copy bodies sent by the builder UI so unsaved edits run
    // against the actual draft state instead of the saved viewing
    // version. Both are optional — when missing the runtime falls back
    // to the DB version (the original behaviour).
    overrideAgentBody  = null,
    overrideCrewBody   = null,
    // Working-copy crew bodies keyed by crewId. The runtime consults
    // this map during Transition Router cascades so the target crew
    // runs against unsaved edits rather than the stale DB body. The
    // current crew is still covered by `overrideCrewBody` for backward
    // compat; we merge it in below.
    overrideCrewBodies = null,
  } = req.body || {};

  if (!ownerUserId || !userMessage) {
    return res.status(400).json({ error: 'Missing ownerUserId or userMessage' });
  }

  // SSE headers (match the existing pattern in server.js).
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write(':ok\n\n');
  if (res.flush) res.flush();

  const emit = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    if (res.flush) res.flush();
  };

  try {
    const d = drizzle();

    // Resolve internal user id (memory persistence + future logging).
    const userId = await resolveUserId(ownerUserId);

    // Persist the user's message first so we have an id to emit.
    const [userMsg] = await d.insert(messages).values({
      conversationId: Number(convId),
      role: 'user',
      content: userMessage,
    }).returning();

    // Auto-name the conversation on its first user message. Truncated
    // first message reads better than "Chat #1667" in the history
    // panel; user can still rename via the pencil affordance.
    try {
      const [conv] = await d.select().from(conversations)
        .where(eq(conversations.id, Number(convId))).limit(1);
      if (conv && !(conv.metadata && conv.metadata.name)) {
        const auto = userMessage.replace(/\s+/g, ' ').trim().slice(0, 60);
        if (auto) {
          await d.update(conversations)
            .set({ metadata: { ...(conv.metadata || {}), name: auto } })
            .where(eq(conversations.id, Number(convId)));
        }
      }
    } catch (err) {
      console.warn('[builder] auto-name failed:', err.message);
    }

    // Apply the override BEFORE emitting `conversation` so the event
    // reflects the post-override DB state (avoids a header flicker
    // where the chip briefly snaps to the pre-pick value).
    if (overrideCrewId) {
      try {
        const [conv] = await d.select().from(conversations)
          .where(eq(conversations.id, Number(convId))).limit(1);
        const meta = conv?.metadata || {};
        if (meta.currentCrewId !== overrideCrewId) {
          await d.update(conversations)
            .set({ metadata: { ...meta, currentCrewId: overrideCrewId }, updatedAt: new Date() })
            .where(eq(conversations.id, Number(convId)));
        }
      } catch (err) {
        console.warn('[builder] pre-run override persist failed:', err.message);
      }
    }

    // Emit the conversation event with the active crew pointer so
    // the client header can show "you're talking to crew X right now"
    // before any addons fire this turn. Falls back to null →
    // client resolves to the agent's default crew.
    const [convForEvent] = await d.select().from(conversations)
      .where(eq(conversations.id, Number(convId))).limit(1);
    emit('conversation', {
      conversationId: Number(convId),
      messageId: userMsg.id,
      currentCrewId: (convForEvent?.metadata && convForEvent.metadata.currentCrewId) || null,
    });

    // Reserve the assistant message row up front (empty content) so
    // BuilderRunner can attach addon_runs to its id. We update the
    // content at the end of the turn with the accumulated stream.
    const [asstMsgPlaceholder] = await d.insert(messages).values({
      conversationId: Number(convId),
      role: 'assistant',
      content: '',
    }).returning();

    // Run the chain. BuilderRunner now owns the assistant message
    // update + `assistant.message` emit (between the blocking and
    // offline phases) — the route handler only needs to clean up the
    // placeholder when the turn produced no assistant text at all.
    const { assistantText } = await runOnce({
      agentSlug: slug,
      ownerUserId,
      userId,
      conversationId:     Number(convId),
      userMessageId:      userMsg.id,
      assistantMessageId: asstMsgPlaceholder.id,
      userMessage,
      version,
      overrideCrewId,
      overrideAgentBody,
      overrideCrewBody,
      overrideCrewBodies,
      emit,
    });

    // Extractor-only crew, error before talker, etc. — drop the
    // empty placeholder so the conversation history doesn't carry a
    // ghost assistant row.
    if (!assistantText) {
      await d.delete(messages).where(eq(messages.id, asstMsgPlaceholder.id));
    }

    emit('done', { totalMs: 0 });
    res.end();
  } catch (err) {
    console.error('[builder] runtime POST failed:', err);
    emit('addon.error', { instanceId: null, error: { code: 'runtime_failed', message: err.message } });
    res.end();
  }
});

module.exports = router;
