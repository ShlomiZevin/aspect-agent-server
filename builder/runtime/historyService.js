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
const { eq, asc, and, gt, lt } = require('drizzle-orm');

function drizzle() {
  return db.getDrizzle();
}

/**
 * Build the conditions list with an optional "exclude from id" cap.
 *
 * The runtime inserts BOTH the user message AND an empty assistant
 * placeholder into the DB before any addon's `loadHistory` call, so
 * naive "all messages in this conversation" queries see the current
 * turn's own rows. The caller passes the just-inserted user message
 * id as `excludeFromMessageId`; we apply `id < excludeFromMessageId`
 * to scope to messages strictly BEFORE the current turn started.
 *
 * Returns the array of Drizzle conditions, ready to spread into
 * `.where(and(...))`.
 */
function baseConditions(conversationId, excludeFromMessageId) {
  const out = [eq(messages.conversationId, Number(conversationId))];
  if (Number.isFinite(excludeFromMessageId) && excludeFromMessageId > 0) {
    out.push(lt(messages.id, Number(excludeFromMessageId)));
  }
  return out;
}

/** All messages in a conversation up to (but not including) the
 *  current turn, oldest→newest. */
async function fetchAll(conversationId, excludeFromMessageId) {
  return drizzle().select()
    .from(messages)
    .where(and(...baseConditions(conversationId, excludeFromMessageId)))
    .orderBy(asc(messages.createdAt));
}

/** Messages strictly after the given DB id, oldest→newest, capped at
 *  the current turn's user message id. */
async function fetchAfterId(conversationId, afterId, excludeFromMessageId) {
  if (!Number.isFinite(afterId) || afterId <= 0) {
    return fetchAll(conversationId, excludeFromMessageId);
  }
  return drizzle().select()
    .from(messages)
    .where(and(
      ...baseConditions(conversationId, excludeFromMessageId),
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

function format(rows) {
  return rows.map(m => ({ role: m.role, content: m.content }));
}

/**
 * Load history per the addon's `context.history` config.
 *
 * Returns BOTH the message list AND a `resolution` record describing
 * what was actually applied. The resolution exposes whether a fallback
 * fired (e.g. `since_summarizer` with no watermark fell back to
 * `all`) so the runtime / client can show the author exactly why their
 * prompt looks the way it does. The card's expanded view surfaces it
 * as a small "history: <mode> → N msgs" line.
 *
 * @param {object} args
 * @param {number|string} args.conversationId
 * @param {object|null} args.historyMode
 * @param {object} [args.brain] — already-loaded brain blob; required
 *        when `since_summarizer` may be requested so the resolver can
 *        read `brain.summary[name].watermark` without a redundant
 *        load.
 * @param {number} [args.excludeFromMessageId] — every query is capped
 *        at `id < excludeFromMessageId`. Used by the blocking-chain
 *        caller to exclude the current turn's own user message AND
 *        assistant placeholder (both are inserted by the route handler
 *        before runOnce). Omit to include everything up to the present.
 * @returns {Promise<{
 *   messages: Array<{ role: string, content: string }>,
 *   resolution: {
 *     requestedMode: string,           // what the config asked for
 *     effectiveMode: string,           // what actually applied (may equal requestedMode)
 *     fallbackReason?: string,         // present iff effectiveMode !== requestedMode
 *     count: number                    // length of messages
 *   }
 * }>}
 */
async function loadHistory({ conversationId, historyMode, brain, excludeFromMessageId }) {
  const mode = historyMode?.mode || 'none';

  // Tiny helper — wraps a message list with the resolution record so
  // every return point below stays one-liner. `messages` is final
  // (already trimmed / sliced); `resolution.count` mirrors its length.
  const resolved = (messages, { effectiveMode = mode, fallbackReason } = {}) => ({
    messages,
    resolution: {
      requestedMode: mode,
      effectiveMode,
      ...(fallbackReason ? { fallbackReason } : {}),
      count: messages.length,
    },
  });

  if (mode === 'none') return resolved([]);

  // last_n: fetch all then slice. Same as the legacy implementation —
  // no point in a separate per-conversation LIMIT query; conversations
  // here are bounded.
  if (mode === 'last_n') {
    const rows = await fetchAll(conversationId, excludeFromMessageId);
    const n = Math.max(0, Math.floor(historyMode?.n ?? 5));
    return resolved(format(rows).slice(-n));
  }

  if (mode === 'all' || mode === 'full') {
    return resolved(format(await fetchAll(conversationId, excludeFromMessageId)));
  }

  if (mode === 'since_transition') {
    const cutoff = await lastTransitionMessageId(conversationId);
    if (cutoff === null) {
      // No transition yet — graceful fallback to `all`. The author
      // hasn't lost data; they just see everything until the first
      // transition lands.
      return resolved(
        format(await fetchAll(conversationId, excludeFromMessageId)),
        { effectiveMode: 'all', fallbackReason: 'No crew transition has fired in this conversation yet.' },
      );
    }
    return resolved(format(await fetchAfterId(conversationId, cutoff, excludeFromMessageId)));
  }

  if (mode === 'since_summarizer') {
    const name = String(historyMode.summarizerName || '').trim();
    const slot = name && brain?.summary ? brain.summary[name] : null;
    const cutoff = slot && Number.isFinite(slot.watermark) ? Number(slot.watermark) : null;
    if (cutoff === null) {
      // Summarizer doesn't exist or hasn't fired yet. Fall back to
      // `all` so a fresh agent doesn't render an empty history (which
      // would be more confusing than seeing everything).
      return resolved(
        format(await fetchAll(conversationId, excludeFromMessageId)),
        {
          effectiveMode: 'all',
          fallbackReason: name
            ? `Summarizer "${name}" hasn't fired yet (no watermark).`
            : 'No summarizer name configured.',
        },
      );
    }
    return resolved(format(await fetchAfterId(conversationId, cutoff, excludeFromMessageId)));
  }

  // Unknown mode — treat as `none` rather than crashing on a typo.
  return resolved([], { effectiveMode: 'none', fallbackReason: `Unknown mode "${mode}".` });
}

/** Highest message DB id in the conversation, respecting the same
 *  `excludeFromMessageId` cap the regular history queries use. Used
 *  by Summarizer's plugin runner to compute the watermark for the
 *  run — should match exactly the slice of messages the summarizer
 *  actually saw.
 *
 *  Returns 0 when no messages qualify — same as "no watermark set",
 *  which is the natural identity for `since_summarizer` fallback
 *  semantics. */
async function highestMessageId(conversationId, excludeFromMessageId) {
  const rows = await fetchAll(conversationId, excludeFromMessageId);
  if (rows.length === 0) return 0;
  return Math.max(...rows.map(r => Number(r.id)));
}

module.exports = {
  loadHistory,
  highestMessageId,
  lastTransitionMessageId,
};
