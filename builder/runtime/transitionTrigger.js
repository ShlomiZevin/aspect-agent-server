/**
 * `on_transition` triggers (offline add-ons, Live Brain and Profiler panels).
 *
 * Fires when a crew transition happened this turn. When the trigger names
 * `fromCrewId`, only when the conversation LEFT that crew (#921) — e.g. a
 * profile summary that should run once the welcome crew hands over, and not
 * on every later move. A `toCrewId` may join later; today "to" is any crew.
 *
 * @param {object} trigger        — `{ kind: 'on_transition', fromCrewId? }`
 * @param {boolean} didTransition — any transition this turn
 * @param {string[]} [fromCrewIds] — the crews this turn transitioned out of
 *        (`ctx.transitionFromCrewIds`, set by BuilderRunner)
 * @returns {boolean}
 */
function transitionMatches(trigger, didTransition, fromCrewIds) {
  if (!didTransition) return false;
  if (!trigger || !trigger.fromCrewId) return true;
  return Array.isArray(fromCrewIds) && fromCrewIds.includes(trigger.fromCrewId);
}

module.exports = { transitionMatches };
