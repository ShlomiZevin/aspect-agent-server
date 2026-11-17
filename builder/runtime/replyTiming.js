/**
 * Reply timing (task #985, round 3) — how long a turn's reply took, kept on
 * the reply message itself:
 *
 *   messages.metadata.replyTiming = {
 *     replyMs,      // the customer's message received by the server → the reply text saved and announced
 *     firstTextMs,  // received → the first word streamed (null when nothing streamed)
 *     receivedAt,   // ISO — when the server received the customer's message
 *     finishedAt,   // ISO — when the reply was saved
 *   }
 *
 * In the existing jsonb, no column, no migration. Written for every turn
 * from now on (Builder, customer chat, simulations); the customer-problems
 * page reads it for the customer chat only. Older replies have no timing.
 *
 * ── The one rule ───────────────────────────────────────────────────
 *
 * Like the error center: recording must never break or slow a turn.
 * `saveReplyTiming` returns at once, the write happens after, and every
 * failure is swallowed with a warning. It runs only after the reply text
 * itself was saved, as a separate statement, so it can never touch that save.
 */

const db = require('../../services/db.pg');

/** The timing object, or null when there is nothing sensible to keep. */
function buildReplyTiming({ receivedAt, firstTextAt, finishedAt }) {
  const r = Number(receivedAt);
  const f = Number(finishedAt);
  if (!Number.isFinite(r) || !Number.isFinite(f) || f < r) return null;
  const t = Number(firstTextAt);
  return {
    replyMs: Math.round(f - r),
    firstTextMs: Number.isFinite(t) && t >= r && t <= f ? Math.round(t - r) : null,
    receivedAt: new Date(r).toISOString(),
    finishedAt: new Date(f).toISOString(),
  };
}

/** Merge `replyTiming` into the reply message's metadata. Fire-and-forget; never throws. */
function saveReplyTiming(messageId, timing) {
  try {
    const id = Number(messageId);
    if (!timing || !Number.isInteger(id) || id <= 0) return;
    setImmediate(() => {
      Promise.resolve()
        .then(() => db.query(
          `UPDATE messages
              SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('replyTiming', $2::jsonb)
            WHERE id = $1`,
          [id, JSON.stringify(timing)],
        ))
        .catch(e => console.warn('[reply-timing] could not save:', e.message));
    });
  } catch (e) {
    console.warn('[reply-timing] could not save:', e.message);
  }
}

module.exports = { buildReplyTiming, saveReplyTiming };
