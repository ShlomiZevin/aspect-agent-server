/**
 * historyService — pull message history per an addon's
 * `context.history` config.
 *
 * Returns an array of `{ role, content }` shaped messages the LLM
 * provider can ingest. The provider-specific transformation (Claude
 * vs OpenAI vs Gemini) is done downstream by llm.js / per-provider
 * adapters; we just supply the raw chronological list.
 *
 * History modes (mirror client `HistoryMode`):
 *   - `none`               → []
 *   - `last_n`             → last N (default 5) ordered oldest→newest
 *   - `full`               → entire conversation (legacy alias for `all`)
 *   - `all`                → entire conversation
 *   - `since_transition`   → strictly after the last crew transition;
 *                            falls back to `all` if no transition yet.
 *   - `since_summarizer`   → strictly after the named summarizer's
 *                            watermark; falls back to `all` when the
 *                            summarizer has never fired or doesn't exist.
 *
 * `since_transition` reads from `conversations.metadata.lastTransitionMessageId`
 * (recorded by BuilderRunner when a Transition Router fires).
 * `since_summarizer` reads `brain.summary[name].watermark` from the
 * memory blob passed in by the caller — the historyService doesn't
 * reload memory itself.
 *
 * Watermarks are inclusive of the cutoff message: "since cutoff" means
 * messages with id strictly greater than the cutoff.
 *
 * The most recently inserted user message is the "current turn" — the
 * caller (BuilderRunner) passes it separately as `userMessage`. We
 * always drop a trailing user message so it isn't duplicated in the
 * history parameter.
 */

const db = require('../../services/db.pg');
const { messages, conversations } = require('../../db/schema');
const { eq, asc, and, gt } = require('drizzle-orm');

function drizzle() {
  return db.getDrizzle();
}

/** All messages in a conversation, oldest→newest. */
async function fetchAll(conversationId) {
  return drizzle().select()
    .from(messages)
    .where(eq(messages.conversationId, Number(conversationId)))
    .orderBy(asc(messages.createdAt));
}

/** Messages strictly after the given DB id, oldest→newest. */
async function fetchAfterId(conversationId, afterId) {
  if (!Number.isFinite(afterId) || afterId <= 0) {
    return fetchAll(conversationId);
  }
  return drizzle().select()
    .from(messages)
    .where(and(
      eq(messages.conversationId, Number(conversationId)),
      gt(messages.id, Number(afterId)),
    ))
    .orderBy(asc(messages.createdAt));
}

/** Look up `conversations.metadata.lastTransitionMessageId`. Returns
 *  null when there isn't one. */
async function lastTransitionMessageId(conversationId) {
  const [row] = await drizzle().select()
    .from(conversations)
    .where(eq(conversations.id, Number(conversationId)))
    .limit(1);
  const id = row?.metadata?.lastTransitionMessageId;
  return Number.isFinite(id) ? Number(id) : null;
}

/** Drop a trailing user message from the chronological list — that's
 *  the current turn, passed separately by BuilderRunner. */
function dropTrailingUserMessage(rows) {
  return rows.length > 0 && rows[rows.length - 1].role === 'user'
    ? rows.slice(0, -1)
    : rows;
}

function format(rows) {
  return rows.map(m => ({ role: m.role, content: m.content }));
}

/**
 * Load history per the addon's `context.history` config.
 *
 * @param {object} args
 * @param {number|string} args.conversationId
 * @param {object|null} args.historyMode
 * @param {object} [args.brain] — already-loaded brain blob; required
 *        when `since_summarizer` may be requested so the resolver can
 *        read `brain.summary[name].watermark` without a redundant
 *        load.
 */
async function loadHistory({ conversationId, historyMode, brain }) {
  const mode = historyMode?.mode || 'none';
  if (mode === 'none') return [];

  // last_n: fetch all then slice. Same as the legacy implementation —
  // no point in a separate per-conversation LIMIT query; conversations
  // here are bounded.
  if (mode === 'last_n') {
    const rows = dropTrailingUserMessage(await fetchAll(conversationId));
    const n = Math.max(0, Math.floor(historyMode?.n ?? 5));
    return format(rows).slice(-n);
  }

  if (mode === 'all' || mode === 'full') {
    return format(dropTrailingUserMessage(await fetchAll(conversationId)));
  }

  if (mode === 'since_transition') {
    const cutoff = await lastTransitionMessageId(conversationId);
    if (cutoff === null) {
      // No transition yet — graceful fallback to `all`. The author
      // hasn't lost data; they just see everything until the first
      // transition lands.
      return format(dropTrailingUserMessage(await fetchAll(conversationId)));
    }
    return format(dropTrailingUserMessage(await fetchAfterId(conversationId, cutoff)));
  }

  if (mode === 'since_summarizer') {
    const name = String(historyMode.summarizerName || '').trim();
    const slot = name && brain?.summary ? brain.summary[name] : null;
    const cutoff = slot && Number.isFinite(slot.watermark) ? Number(slot.watermark) : null;
    if (cutoff === null) {
      // Summarizer doesn't exist or hasn't fired yet. Fall back to
      // `all` so a fresh agent doesn't render an empty history (which
      // would be more confusing than seeing everything).
      return format(dropTrailingUserMessage(await fetchAll(conversationId)));
    }
    return format(dropTrailingUserMessage(await fetchAfterId(conversationId, cutoff)));
  }

  // Unknown mode — treat as `none` rather than crashing on a typo.
  return [];
}

/** Highest message DB id in the conversation. Used by Summarizer's
 *  plugin runner to compute the watermark for the run.
 *
 *  Returns 0 when there are no messages yet — same as "no watermark
 *  set", which is the natural identity for `since_summarizer`
 *  fallback semantics. */
async function highestMessageId(conversationId) {
  const rows = await fetchAll(conversationId);
  if (rows.length === 0) return 0;
  return Math.max(...rows.map(r => Number(r.id)));
}

module.exports = {
  loadHistory,
  highestMessageId,
  lastTransitionMessageId,
};
