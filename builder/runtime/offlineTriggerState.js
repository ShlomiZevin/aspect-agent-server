/**
 * offlineTriggerState — per-(conversation, addon-instance) state for
 * offline-lane triggers.
 *
 * The only state we need today is the message counter for the
 * `every_n_messages` trigger: each addon instance gets its own
 * counter, incremented after each user turn; when the counter
 * reaches `n`, the addon fires and the counter resets to 0.
 *
 * Storage: conversation-scoped row in `context_data` under the
 * `builder_offline` namespace. One row per conversation; the row's
 * payload is a flat map keyed by addon instance id:
 *
 *   { counters: { "<instanceId>": <integer>, ... } }
 *
 * Counters live OUTSIDE the brain blob deliberately — they're
 * runtime bookkeeping, not synthesised content, and the brain blob
 * is part of the user-facing live-view payload. Keeping them
 * separate means a brain reset (e.g. "clear conversation memory")
 * doesn't reset trigger state and vice versa.
 *
 * Forward-compat: when more trigger kinds need persistent state
 * (e.g. `time_elapsed` needs a last-fired timestamp), they get their
 * own sub-object inside the same namespace row. The
 * `every_n_messages` counter map is named `counters` precisely so
 * sibling state can coexist without colliding.
 */

const contextService = require('../../services/context.service');

const NAMESPACE = 'builder_offline';

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { counters: {} };
  return {
    counters: raw.counters && typeof raw.counters === 'object' ? raw.counters : {},
  };
}

/** Load the trigger-state blob for a conversation. The blob lives at
 *  user scope (per the context_data table) but is keyed by
 *  conversationId so each conversation has its own row. */
async function load(userId, conversationId) {
  if (!userId || !conversationId) return { counters: {} };
  const raw = await contextService.getContext(userId, NAMESPACE, conversationId);
  return normalize(raw);
}

/** Persist the trigger-state blob. */
async function save(userId, conversationId, state) {
  if (!userId || !conversationId) return;
  await contextService.saveContext(userId, NAMESPACE, normalize(state), conversationId);
}

/** Read one instance's counter. Returns 0 when missing — that's the
 *  identity for "never incremented", which is the right starting
 *  point for `every_n_messages` evaluation. */
function readCounter(state, instanceId) {
  if (!state || !state.counters || !instanceId) return 0;
  const v = state.counters[instanceId];
  return Number.isFinite(v) ? Number(v) : 0;
}

/** Write one instance's counter into the blob in place. Returns the
 *  same blob ref so callers can chain saves. */
function writeCounter(state, instanceId, value) {
  if (!state.counters) state.counters = {};
  state.counters[instanceId] = Math.max(0, Math.floor(value || 0));
  return state;
}

module.exports = {
  load,
  save,
  readCounter,
  writeCounter,
  NAMESPACE,
};
