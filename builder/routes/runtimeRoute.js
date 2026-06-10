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
const { eq, and, desc } = require('drizzle-orm');
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
 *   Body: { ownerUserId }
 *   Creates a new conversation row, returns { conversationId }.
 */
router.post('/:slug/conversations', async (req, res) => {
  try {
    const { slug } = req.params;
    const { ownerUserId } = req.body || {};
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
      memory:   blob.memory,
      thinking: blob.thinking,
      summary:  blob.summary || {},
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
    overrideAgentBody = null,
    overrideCrewBody  = null,
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
