/**
 * offlineDispatcher — evaluate and run the OFFLINE-lane addons for
 * one turn.
 *
 * v1 model: offline addons fire only as a reaction to a user-message
 * turn (no background scheduler, no cron, no time-based triggers).
 * That keeps the runtime entirely within the HTTP request lifecycle —
 * the SSE stream stays open until offline addons complete, and the
 * client sees their events in the same timeline as blocking-lane
 * addons. Future trigger kinds (e.g. `time_elapsed`) will need a
 * separate background worker; not today.
 *
 * What this module does, in order:
 *   1. Collect every offline-lane addon enabled on the agent cortex
 *      and the current crew.
 *   2. Load per-(conversation, instance) trigger state via
 *      `offlineTriggerState`.
 *   3. For each addon, evaluate its `context.trigger` against the
 *      turn's events (just-completed turn + whether a transition
 *      fired during the blocking chain).
 *   4. Increment the `every_n_messages` counter for every offline
 *      addon (regardless of whether it fired this turn — the counter
 *      tracks user turns since the addon's last run).
 *   5. For each addon whose trigger fires, dispatch via `addonRunner`
 *      and reset its counter.
 *   6. Persist the updated trigger state.
 *
 * Concurrency: all triggered offline addons run in parallel via
 * `Promise.all`. Order between them is not specified — they share no
 * read/write ordering guarantees with each other. The blocking-lane
 * results are already in the brain blob by the time we're here, so
 * the offline runs see consistent state.
 */

const { runAddon } = require('./addonRunner');
const offlineTriggerState = require('./offlineTriggerState');

/** Walk the agent cortex + current crew's addons, return every
 *  offline-lane addon that's enabled. */
function collectOfflineAddons(runnable) {
  const out = [];
  const cortex = Array.isArray(runnable.agent.body?.cortex) ? runnable.agent.body.cortex : [];
  const crew   = Array.isArray(runnable.crew.body?.addons)  ? runnable.crew.body.addons  : [];
  for (const a of cortex) {
    if (a?.lane === 'offline' && a.enabled !== false) out.push(a);
  }
  for (const a of crew) {
    if (a?.lane === 'offline' && a.enabled !== false) out.push(a);
  }
  return out;
}

/**
 * Decide whether an offline addon's trigger should fire on this turn.
 *
 * @param {object} args
 * @param {object} args.instance     — the offline addon
 * @param {number} args.nextCounter  — what the addon's counter will
 *        be AFTER this turn's increment. `every_n_messages` checks
 *        `nextCounter >= n`.
 * @param {boolean} args.didTransition — whether any transition fired
 *        in this turn's blocking chain.
 * @returns {boolean}
 */
function shouldFire({ instance, nextCounter, didTransition }) {
  const trigger = instance.context?.trigger;
  if (!trigger || typeof trigger !== 'object') {
    // No trigger configured — that's a misconfiguration, not a
    // crash-worthy event. Skip silently; the UI flags missing
    // triggers in the offline-lane card.
    return false;
  }
  if (trigger.kind === 'every_n_messages') {
    const n = Math.max(1, Math.floor(trigger.n || 0));
    return nextCounter >= n;
  }
  if (trigger.kind === 'on_transition') {
    return !!didTransition;
  }
  // Unknown trigger kind — forward-compat: skip silently rather than
  // throwing. Adding new kinds is a server-only concern; old clients
  // can still author them without crashing the runtime.
  return false;
}

/**
 * Dispatch offline addons for one turn.
 *
 * @param {object} args
 * @param {object} args.ctx       — the same per-turn context the
 *        blocking loop uses. `addonRunner` consumes the full shape.
 * @param {boolean} args.didTransition — set by the blocking loop when
 *        any addon emitted a transition. Drives `on_transition`.
 */
async function dispatchOfflineAddons({ ctx, didTransition }) {
  const { runnable, userId, conversationId } = ctx;
  const offline = collectOfflineAddons(runnable);
  if (offline.length === 0) return;

  // Load + normalise the per-conversation trigger state ONCE per
  // turn. We mutate it in place as we evaluate each addon, then
  // persist once at the end.
  const state = await offlineTriggerState.load(userId, conversationId);

  // For each offline addon, compute the "next counter" (current + 1
  // since this turn just finished) and decide whether to fire. We
  // increment EVERY counter — that's the semantic of
  // `every_n_messages`: tick once per user turn, fire when the tick
  // crosses the threshold.
  const dispatches = [];
  for (const instance of offline) {
    const current  = offlineTriggerState.readCounter(state, instance.instanceId);
    const next     = current + 1;
    const willFire = shouldFire({ instance, nextCounter: next, didTransition });
    if (willFire) {
      // Reset the counter to 0 — the addon is firing on THIS turn,
      // so the next interval starts fresh from the next turn.
      offlineTriggerState.writeCounter(state, instance.instanceId, 0);
      dispatches.push(instance);
    } else {
      offlineTriggerState.writeCounter(state, instance.instanceId, next);
    }
  }

  // Persist the new counter state. Best-effort: a save failure can't
  // break the user-facing reply (which has already streamed).
  try {
    await offlineTriggerState.save(userId, conversationId, state);
  } catch (err) {
    console.error('[offlineDispatcher] trigger-state save failed:', err.message);
  }

  if (dispatches.length === 0) return;

  // Run in parallel. addonRunner is self-contained: each call emits
  // its own SSE events, persists its own addon_runs row, applies its
  // own memory writes. Concurrency is safe because:
  //   - SSE writes serialise through the response writer
  //   - Brain memory writes inside addonRunner are followed by
  //     saveMemory(); two parallel writers will last-write-wins,
  //     which is acceptable for offline addons that produce
  //     independent slots (summary writes by name, thinking writes by
  //     domain). If a real conflict use-case appears, this is where
  //     to serialise.
  await Promise.all(dispatches.map(instance =>
    runAddon({ ctx, instance, addonStart: Date.now() })
      .catch(err => {
        // runAddon already emits addon.error on known failure modes;
        // a throw here is something unexpected. Log + swallow so one
        // bad offline addon can't take down the others.
        console.error('[offlineDispatcher] unexpected throw from runAddon:', err.message);
      }),
  ));
}

module.exports = { dispatchOfflineAddons, collectOfflineAddons };
