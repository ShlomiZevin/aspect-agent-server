/**
 * triggerRegistry — the set of registered TRIGGER TYPES.
 *
 * Mirrors `builder/runtime/pluginRegistry.js` in shape, deliberately:
 * adding a trigger type should feel like adding an addon. It is NOT the
 * same registry, because a trigger is not an addon — see
 * docs/guides/BUILDER_V2_TRIGGERS.md for why that distinction is
 * load-bearing. In one line: an addon is handed a conversation, a
 * trigger has to find them.
 *
 * ── The contract a trigger type implements ─────────────────────────
 *
 * Two methods, and they are deliberately unequal in both cost and
 * authority:
 *
 *   candidateSql({ trigger, config, now }) → { where, params }
 *     A CHEAP SQL narrowing, ANDed into one indexed query across the
 *     agent's conversations. Its only job is to turn ten thousand rows
 *     into a handful.
 *
 *     ⚠ CONTRACT: it must be a SUPERSET of what `evaluate()` accepts.
 *     It may return conversations that `evaluate()` then rejects; it
 *     must NEVER exclude one that `evaluate()` would have accepted.
 *     Getting this wrong makes conversations silently invisible to the
 *     trigger, which is the hardest possible failure to notice. When in
 *     doubt, narrow LESS here and let `evaluate()` do the work — the
 *     cost of an extra candidate is one cheap object; the cost of a
 *     missing one is a customer who is never contacted.
 *
 *   evaluate({ facts, trigger, config, now }) → { ok, clauses }
 *     AUTHORITATIVE. The single source of truth for "should this fire?".
 *     Pure — it reads only the `facts` it is given, never the database,
 *     never the clock beyond `now`.
 *
 * Because `evaluate()` is authoritative and `candidateSql()` can only
 * over-select, the tick and the explainer cannot disagree: both call the
 * same `evaluate()`. The tick calls it on rows the SQL surfaced; the
 * explainer calls it on facts reconstructed for one conversation at one
 * past moment. There is no second implementation of the rule to drift
 * from the first — which is the whole reason the contract is shaped
 * this way rather than "each type exposes a query".
 *
 * ── Facts ──────────────────────────────────────────────────────────
 *
 * The evaluator (not the type) fetches these, so a type never touches
 * the DB and stays trivially testable:
 *
 *   conversationId                  number
 *   lastUserMessageAt               Date | null   the customer's last word
 *   lastMessageAt                   Date | null   any activity, ours included
 *   lastEventAt                     Date | null   this trigger's last attempt here
 *   attemptsSinceLastUserMessage    number        this trigger's attempts since
 *                                                 the customer last spoke
 *   createdAt                       Date          conversation start
 */

const registry = new Map();

/**
 * @param {object} type
 * @param {string} type.typeId
 * @param {function} type.candidateSql
 * @param {function} type.evaluate
 * @param {object}  [type.descriptor]  the shared *.trigger.json
 */
function registerTriggerType(type) {
  if (!type || !type.typeId) throw new Error('registerTriggerType: missing typeId');
  if (typeof type.evaluate !== 'function') {
    throw new Error(`registerTriggerType(${type.typeId}): evaluate() is required — it is the authoritative rule`);
  }
  if (typeof type.candidateSql !== 'function') {
    throw new Error(`registerTriggerType(${type.typeId}): candidateSql() is required`);
  }
  registry.set(type.typeId, type);
}

function getTriggerType(typeId) {
  return registry.get(typeId) || null;
}

function listTriggerTypes() {
  return Array.from(registry.values());
}

/** The shared descriptors, for the client picker and for Alfred. */
function listTriggerDescriptors() {
  return listTriggerTypes().map(t => t.descriptor).filter(Boolean);
}

module.exports = {
  registerTriggerType,
  getTriggerType,
  listTriggerTypes,
  listTriggerDescriptors,
};
