/**
 * addonRunsStore — thin Drizzle wrapper for the `addon_runs` table.
 *
 * One row per addon execution. `run_data` JSON mirrors the live SSE
 * `addon.output` event so the historical-view UI can rehydrate cards
 * from these rows verbatim.
 */

const db = require('../../services/db.pg');
const { addonRuns } = require('../../db/schema');
const { eq, asc } = require('drizzle-orm');

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
  runsForMessage,
  deleteForConversation,
  deleteForMessage,
};
