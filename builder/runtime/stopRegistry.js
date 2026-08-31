/**
 * Stop flags for in-flight turns (task #816).
 *
 * Internal builder feature. A "stop" is a FLAG that our own loops read
 * at their natural checkpoints — between chain steps, per streamed
 * chunk, per Alfred stream event — never a kill. Nothing here touches
 * the provider request or the DB. A stopped turn simply stops ACTING:
 * no assistant text is persisted, no transition cascades, no offline
 * lane runs. Work that already completed before the flag flipped
 * (an extractor's memory write, say) stays — it was derived from the
 * user's message and is still true.
 *
 * Keyed by scope ("alfred:<chatId>" / "conv:<conversationId>") in one
 * process-local Map. A run registers on start and unregisters on end
 * (with its own handle, so an overlapping run on the same key can't
 * clear a sibling's entry). Not meant to be bullet-proof across
 * instances — one Cloud Run container, one builder user at a time.
 */
const runs = new Map();

function start(key) {
  const handle = { stopped: false };
  runs.set(key, handle);
  return handle;
}

/** Returns true when there was a live run to flag. */
function stop(key) {
  const r = runs.get(key);
  if (!r) return false;
  r.stopped = true;
  return true;
}

function isStopped(key) {
  return runs.get(key)?.stopped === true;
}

function end(key, handle) {
  if (runs.get(key) === handle) runs.delete(key);
}

module.exports = {
  start, stop, isStopped, end,
  alfredKey: id => `alfred:${id}`,
  convKey:   id => `conv:${id}`,
};
