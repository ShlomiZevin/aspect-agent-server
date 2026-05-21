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
 *   List builder-preview conversations for this slug + owner.
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
      ))
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    res.json({ conversations: list.map(c => ({
      id: c.id,
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
 *   Returns the per-conversation builder_memory blob built up by
 *   extractor addons. Shape mirrors what BuilderRunner reads:
 *     { "<domain>": { fieldName: value, … }, ... }
 *   _general bucket holds domain-less fields.
 */
router.get('/:slug/conversations/:convId/memory', async (req, res) => {
  try {
    const { convId } = req.params;
    const { ownerUserId } = req.query;
    if (!ownerUserId) return res.status(400).json({ error: 'Missing ownerUserId' });
    const userId = await resolveUserId(String(ownerUserId));
    const builderMemory = require('../runtime/builderMemory');
    const memory = await builderMemory.loadMemory(userId, Number(convId));
    res.json({ memory });
  } catch (err) {
    console.error('[builder] GET memory failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/agents/:slug/conversations/:convId
 *   Cascade: delete messages, then the conversation. (addon_runs
 *   cleanup is added in P2 alongside the table.)
 */
router.delete('/:slug/conversations/:convId', async (req, res) => {
  try {
    const { convId } = req.params;
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
 * POST /api/agents/:slug/conversations/:convId/messages
 *   The runtime call. Streams SSE.
 *   Body: { ownerUserId, userMessage, version: 'viewing'|'active' }
 */
router.post('/:slug/conversations/:convId/messages', async (req, res) => {
  const { slug, convId } = req.params;
  const { ownerUserId, userMessage, version = 'viewing' } = req.body || {};

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

    emit('conversation', { conversationId: Number(convId), messageId: userMsg.id });

    // Run the chain.
    const { assistantText } = await runOnce({
      agentSlug: slug,
      ownerUserId,
      userId,
      conversationId: Number(convId),
      userMessage,
      version,
      emit,
    });

    // Persist the assistant message.
    if (assistantText) {
      const [asstMsg] = await d.insert(messages).values({
        conversationId: Number(convId),
        role: 'assistant',
        content: assistantText,
      }).returning();
      emit('assistant.message', { messageId: asstMsg.id, text: assistantText });
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
