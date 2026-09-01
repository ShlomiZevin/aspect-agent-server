/**
 * addonRunsStore — thin Drizzle wrapper for the `addon_runs` table.
 *
 * One row per addon execution. `run_data` JSON mirrors the live SSE
 * `addon.output` event so the historical-view UI can rehydrate cards
 * from these rows verbatim.
 */

const db = require('../../services/db.pg');
const { addonRuns } = require('../../db/schema');
const { eq, and, asc, desc, isNull, gte } = require('drizzle-orm');

function drizzle() {
  return db.getDrizzle();
}

function uid() {
  return `run_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/**
 * Insert one run. Best-effort; failures bubble so the caller can log
 * without crashing the conversation.
 */
async function insertRun({
  conversationId,
  messageId,
  instance,
  status,
  startedAt,
  endedAt,
  durationMs,
  runData,
}) {
  await drizzle().insert(addonRuns).values({
    id:             uid(),
    conversationId: Number(conversationId),
    messageId:      messageId ? Number(messageId) : null,
    instanceId:     instance.instanceId,
    pluginId:       instance.pluginId,
    status,
    startedAt,
    endedAt,
    durationMs,
    runData,
  });
}

/**
 * Attach this run's rows to an assistant message that didn't exist yet
 * when they were written.
 *
 * A proactive turn (see BuilderRunner.runProactive) can't reserve an
 * assistant message up front the way a user turn does: staying silent is
 * a designed outcome there, and reserving-then-deleting a placeholder
 * would move `conversations.last_message_at` on every silent attempt —
 * a lie about when the conversation was last active. So the chain runs
 * with `messageId: null` and, only if a talker actually produced text,
 * the message is inserted and its rows are claimed here.
 *
 * Scoped by (conversation, still-unattached, started at or after this
 * run began), which is exact: a proactive turn is single-threaded per
 * conversation, so nothing else can have written an unattached row into
 * that window.
 *
 * @returns {Promise<void>}
 */
async function attachRunsToMessage({ conversationId, messageId, since }) {
  await drizzle().update(addonRuns)
    .set({ messageId: Number(messageId) })
    .where(and(
      eq(addonRuns.conversationId, Number(conversationId)),
      isNull(addonRuns.messageId),
      gte(addonRuns.startedAt, since),
    ));
}

/**
 * List all runs for a single assistant message id, ordered by
 * start time. Used by the historical-view endpoint.
 */
async function runsForMessage(messageId) {
  return drizzle().select()
    .from(addonRuns)
    .where(eq(addonRuns.messageId, Number(messageId)))
    .orderBy(asc(addonRuns.startedAt));
}

/**
 * Most-recent runs for one plugin across a whole conversation, newest
 * first. Powers the Live Brain run inspector (filtered to the
 * `live-brain-panel` plugin so brain runs stay separate from chat addons).
 */
async function recentRunsForConversation(conversationId, pluginId, limit = 40) {
  return drizzle().select()
    .from(addonRuns)
    .where(and(
      eq(addonRuns.conversationId, Number(conversationId)),
      eq(addonRuns.pluginId, pluginId),
    ))
    .orderBy(desc(addonRuns.startedAt))
    .limit(limit);
}

/**
 * Cascade delete for a conversation (used by DELETE conversation).
 */
async function deleteForConversation(conversationId) {
  await drizzle().delete(addonRuns)
    .where(eq(addonRuns.conversationId, Number(conversationId)));
}

/**
 * Cascade delete for a specific assistant message (used by delete-message).
 */
async function deleteForMessage(messageId) {
  await drizzle().delete(addonRuns)
    .where(eq(addonRuns.messageId, Number(messageId)));
}

module.exports = {
  insertRun,
  attachRunsToMessage,
  runsForMessage,
  recentRunsForConversation,
  deleteForConversation,
  deleteForMessage,
};
