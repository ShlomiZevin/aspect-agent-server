/**
 * pinnedFields — seed memory at the start of every turn with the
 * default values configured on `FieldDef.source === 'pinned'` fields.
 *
 * Pinned fields are the organizational-KB selector pattern: an
 * authoring-time decision ("this agent is acting as Bank Hapoalim")
 * instead of a runtime extraction. The runtime treats them like any
 * other memory value at resolution time — the only difference is
 * where the value originated.
 *
 * Seed contract:
 *   - For every pinned field declared on `agent.fields[]` + the
 *     current `crew.fields[]`, if memory has no value for that field
 *     name in ANY domain, write `defaultValue` to `memory[domain][name]`
 *     where `domain` is the FieldDef's `domain` (defaults to '_general').
 *   - Existing memory values WIN. The chat-header swap chip, the brain
 *     panel value picker, and any prior conversation memory all live
 *     under the same key, so this seed is purely "populate the empty
 *     slot at the start of the turn" — never overwrite.
 *   - Pinned fields without `defaultValue` or a non-string defaultValue
 *     are skipped. Pinned fields whose `type !== 'enum'` are also
 *     skipped (the use case is enum-only by spec; we leave the door
 *     open without forcing any behavior).
 *
 * Pure data manipulation — no I/O. The caller (BuilderRunner) is
 * responsible for persisting memory after this seed runs.
 */

const builderMemory = require('./builderMemory');

const PINNED_SOURCE = 'pinned';

/**
 * Seed pinned-field default values into `memory` for the given runnable.
 * Mutates `memory` in place; returns the count of slots seeded so
 * callers can decide whether to persist.
 *
 * @param {object} memory   - the brain blob from `builderMemory.loadMemory`
 * @param {object} runnable - shape from BuilderRunner: `{ agent: {body:{fields}}, crew: {body:{fields}} }`
 * @returns {number}        - number of slots actually seeded this call
 */
function seedPinnedFields(memory, runnable) {
  if (!memory || typeof memory !== 'object') return 0;
  if (!runnable) return 0;

  const agentFields = Array.isArray(runnable.agent?.body?.fields) ? runnable.agent.body.fields : [];
  const crewFields  = Array.isArray(runnable.crew?.body?.fields)  ? runnable.crew.body.fields  : [];
  // Agent-scoped pinned fields first, then crew-scoped — same scope
  // model the rest of the runtime uses. A crew-scoped pin with the
  // same name as an agent-scoped one would be ambiguous; we leave
  // that for the schema validators to flag (not silently masking
  // here, just iterating in declared order).
  const pool = [...agentFields, ...crewFields];

  let seeded = 0;
  for (const f of pool) {
    if (!f || typeof f !== 'object') continue;
    if (f.source !== PINNED_SOURCE) continue;
    if (typeof f.name !== 'string' || !f.name) continue;
    if (typeof f.defaultValue !== 'string' || !f.defaultValue) continue;
    // Only enum-typed pins are meaningful per the spec — a "pinned
    // string" wouldn't have a Targeted KB to consult and tokens like
    // `{{dc:F:SEC}}` would resolve empty. Skip silently so other
    // shapes don't accidentally seed garbage into memory.
    if (f.type !== 'enum') continue;
    // Don't overwrite an existing value — chat overrides + prior
    // conversation state win.
    const existing = builderMemory.findFieldValue(memory, f.name, 'memory');
    if (existing !== undefined && existing !== null) continue;

    builderMemory.applyWrites(memory, [{
      kind:   'memory',
      domain: typeof f.domain === 'string' && f.domain.trim() ? f.domain.trim() : null,
      field:  f.name,
      value:  f.defaultValue,
    }]);
    seeded += 1;
  }
  return seeded;
}

module.exports = { seedPinnedFields };
