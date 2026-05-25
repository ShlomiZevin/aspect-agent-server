/**
 * Alfred chats — thin wrapper on the `conversations` + `messages`
 * tables, filtered by `kind = 'alfred'`.
 *
 * The runtime-preview route (builder/routes/runtimeRoute.js) creates
 * `kind='user'` rows on the same tables; this service is the dual for
 * Alfred chats. We FK to the same legacy `agents` row (by slug) — no
 * extra placeholder.
 */

const { eq, and, desc } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { agents, conversations, messages, users } = require('../../db/schema');

function drizzle() {
  return db.getDrizzle();
}

const KIND = 'alfred';

/**
 * Resolve the legacy agents.id for a slug. Insert a placeholder if no
 * legacy row exists (mirrors runtimeRoute.resolveLegacyAgentId).
 * Reused by Alfred chats and runtime previews — same row.
 */
async function resolveLegacyAgentId(slug) {
  const d = drizzle();
  const existing = await d.select().from(agents).where(eq(agents.urlSlug, slug)).limit(1);
  if (existing.length > 0) return existing[0].id;
  const [created] = await d.insert(agents).values({
    name: `Builder · ${slug}`,
    urlSlug: slug,
    domain: 'builder-v2',
    description: 'Auto-created by the V2 builder for preview / Alfred conversations.',
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

async function createChat({ agentSlug, ownerUserId }) {
  const agentId = await resolveLegacyAgentId(agentSlug);
  const userId  = await resolveUserId(ownerUserId);
  const [row] = await drizzle().insert(conversations).values({
    userId,
    agentId,
    channel:  'web',
    status:   'active',
    kind:     KIND,
    metadata: { agentSlug },
  }).returning();
  return { id: row.id };
}

async function listChats({ agentSlug, ownerUserId }) {
  const d = drizzle();
  const [agentRow] = await d.select().from(agents).where(eq(agents.urlSlug, agentSlug)).limit(1);
  if (!agentRow) return [];
  const userRow = await d.select().from(users)
    .where(eq(users.externalId, String(ownerUserId))).limit(1);
  if (userRow.length === 0) return [];
  const list = await d.select()
    .from(conversations)
    .where(and(
      eq(conversations.agentId, agentRow.id),
      eq(conversations.userId, userRow[0].id),
      eq(conversations.kind, KIND),
    ))
    .orderBy(desc(conversations.updatedAt))
    .limit(50);
  return list.map(c => ({
    id:        c.id,
    name:      (c.metadata && c.metadata.name) || null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
}

async function getChat(chatId) {
  const [row] = await drizzle().select().from(conversations)
    .where(and(eq(conversations.id, Number(chatId)), eq(conversations.kind, KIND)))
    .limit(1);
  return row || null;
}

async function listMessages(chatId) {
  const list = await drizzle().select()
    .from(messages)
    .where(eq(messages.conversationId, Number(chatId)))
    .orderBy(messages.createdAt);
  return list.map(m => ({
    id:        m.id,
    role:      m.role,
    content:   m.content,
    createdAt: m.createdAt,
    metadata:  m.metadata,
  }));
}

async function appendMessage({ chatId, role, content, metadata }) {
  const [row] = await drizzle().insert(messages).values({
    conversationId: Number(chatId),
    role,
    content,
    metadata: metadata || null,
  }).returning();
  // Bump the parent conversation's updatedAt so list ordering reflects activity.
  await drizzle().update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, Number(chatId)));
  return row;
}

async function updateMessageContent(messageId, content) {
  await drizzle().update(messages)
    .set({ content })
    .where(eq(messages.id, Number(messageId)));
}

async function renameChat(chatId, name) {
  const chat = await getChat(chatId);
  if (!chat) return null;
  const next = { ...(chat.metadata || {}), name: name.trim() };
  await drizzle().update(conversations)
    .set({ metadata: next, updatedAt: new Date() })
    .where(eq(conversations.id, Number(chatId)));
  return next.name;
}

async function setChatNameIfBlank(chatId, candidate) {
  const chat = await getChat(chatId);
  if (!chat) return;
  if (chat.metadata && chat.metadata.name) return;
  const trimmed = candidate.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!trimmed) return;
  await drizzle().update(conversations)
    .set({ metadata: { ...(chat.metadata || {}), name: trimmed } })
    .where(eq(conversations.id, Number(chatId)));
}

async function deleteChat(chatId) {
  const d = drizzle();
  await d.transaction(async tx => {
    await tx.delete(messages).where(eq(messages.conversationId, Number(chatId)));
    await tx.delete(conversations)
      .where(and(eq(conversations.id, Number(chatId)), eq(conversations.kind, KIND)));
  });
}

module.exports = {
  KIND,
  resolveLegacyAgentId,
  resolveUserId,
  createChat,
  listChats,
  getChat,
  listMessages,
  appendMessage,
  updateMessageContent,
  renameChat,
  setChatNameIfBlank,
  deleteChat,
};
