/**
 * System fields — registry + helpers.
 *
 * A "system field" is a platform-defined memory field that:
 *   - Has a fixed, reserved name (users can't declare a custom field
 *     with the same name).
 *   - Is auto-extracted on every addon turn: the runtime scans each
 *     addon's parsedOutput for matching keys and writes them to
 *     memory, regardless of whether the addon's `extractsFields` is
 *     wired to it.
 *   - Has a declared lifetime that the runtime enforces (e.g.,
 *     reset on crew transition).
 *   - Otherwise behaves exactly like a normal field: visible in the
 *     Fields panel, available in autocomplete, usable in filter and
 *     transition conditions, readable via `{{field:NAME}}`.
 *
 * The whole point is "what you see is what you get": the user writes
 * their own prompt instruction telling the LLM to emit (say)
 * `moveOn: true`. The runtime just harvests that key — it never
 * injects prompt text.
 *
 * KEEP IN SYNC with the client mirror at
 * `aspect-react-client/src/builder/registry/systemFields.ts`. The
 * list is tiny so duplication beats a build-time dependency between
 * the two repos.
 */

/**
 * @typedef {Object} SystemFieldDef
 * @property {string} name         — reserved field name (memory key)
 * @property {string} type         — 'boolean' | 'string' | 'int' | 'enum'
 * @property {'crew-transition' | 'per-turn' | 'never'} lifetime
 *   When the runtime clears the value.
 *     'crew-transition' — cleared whenever a Transition Router fires.
 *     'per-turn'        — cleared at the start of every turn.
 *     'never'           — persisted for the lifetime of the conversation.
 * @property {string} description  — author-facing explanation
 * @property {string} [domain]     — optional memory domain. Defaults
 *   to `_system` so they group together visually and don't pollute
 *   user-declared domains.
 */

/**
 * @type {SystemFieldDef[]}
 *
 * Currently empty. `move_on` was retired — no live agent relied on the
 * auto-harvest + transition-reset behavior, and it lingered confusingly
 * in the condition/autocomplete pickers. The machinery below (harvest,
 * reset, reserved-name checks) stays intact and simply no-ops on an
 * empty registry, so re-adding a system field is a one-entry change.
 */
const SYSTEM_FIELDS = [];

const SYSTEM_FIELD_BY_NAME = Object.fromEntries(
  SYSTEM_FIELDS.map(f => [f.name, f]),
);
const SYSTEM_FIELD_NAMES = new Set(SYSTEM_FIELDS.map(f => f.name));

/** True when `name` is reserved. */
function isSystemFieldName(name) {
  return SYSTEM_FIELD_NAMES.has(name);
}

/** Look up a definition. Returns undefined when name isn't reserved. */
function findSystemField(name) {
  return SYSTEM_FIELD_BY_NAME[name];
}

/**
 * Coerce a raw value from addon parsedOutput to the system field's
 * declared type. Returns `undefined` when the value is unusable
 * (caller should skip the write).
 *
 * For booleans we accept both JSON booleans AND common string
 * representations because small LLMs sometimes emit `"true"`. We
 * deliberately DO NOT accept truthy-ish values like the number 1 or
 * the string `"yes"` — strict matching keeps the signal crisp.
 */
function coerceSystemFieldValue(def, raw) {
  if (raw === undefined || raw === null) return undefined;
  switch (def.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true')  return true;
      if (raw === 'false') return false;
      return undefined;
    }
    case 'int': {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : undefined;
    }
    case 'string':
    case 'enum': {
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Scan a parsed addon output object for system field keys and emit
 * matching memory writes. Returns an array of writes in the same
 * shape `applyWrites` consumes:
 *
 *   { kind: 'memory', domain: '_system', field: 'moveOn', value: true }
 *
 * Empty array when nothing matches (most addons most of the time).
 */
function harvestSystemFieldWrites(parsedOutput) {
  if (!parsedOutput || typeof parsedOutput !== 'object' || Array.isArray(parsedOutput)) {
    return [];
  }
  const out = [];
  for (const def of SYSTEM_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(parsedOutput, def.name)) continue;
    const value = coerceSystemFieldValue(def, parsedOutput[def.name]);
    if (value === undefined) continue;
    out.push({
      kind:   'memory',
      domain: def.domain || '_system',
      field:  def.name,
      value,
    });
  }
  return out;
}

/**
 * Reset system fields whose lifetime matches the given trigger. Used
 * by the runtime: `resetSystemFields(memory, 'crew-transition')`
 * fires right after a Transition Router commits, so the new crew
 * starts with `moveOn` (etc.) cleared.
 *
 * Mutates `memory` in place; safe to call when nothing matches.
 */
function resetSystemFields(memory, trigger) {
  if (!memory || typeof memory !== 'object') return;
  for (const def of SYSTEM_FIELDS) {
    if (def.lifetime !== trigger) continue;
    const domain = def.domain || '_system';
    const bucket = memory.memory && memory.memory[domain];
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, def.name)) {
      delete bucket[def.name];
    }
  }
}

/**
 * Generalised companion to `harvestSystemFieldWrites` — same scan,
 * but against the agent's user-declared fields. If a plugin's parsed
 * JSON output contains a key whose name matches a declared `FieldDef`
 * in the agent or current-crew scope, emit a memory write at that
 * field's `domain`.
 *
 * Lets any plugin (Thinker most usefully) double as a quiet extractor:
 *   - keys NOT matching a field → handled by the plugin as usual
 *     (e.g. Thinker writes them to `thinking[domain]`)
 *   - keys matching a field → also written to `memory[domain]` by this
 *     harvest, so a follow-up addon can read the value via
 *     `{{field:NAME}}`.
 *
 * Caller passes the full field pool (agent.fields + crew.fields).
 * `alreadyWrittenNames` is the set of names the plugin already wrote
 * to the memory section — skipped here so explicit plugin writes win
 * if both fire (e.g. Field Extractor's targeted writes).
 *
 * No type coercion — the value is stored as-is. The system harvest
 * coerces because system fields have a canonical type contract; user
 * fields don't have one strict enough to safely coerce at this layer.
 */
function harvestDeclaredFieldWrites(parsedOutput, fieldPool, alreadyWrittenNames) {
  if (!parsedOutput || typeof parsedOutput !== 'object' || Array.isArray(parsedOutput)) {
    return [];
  }
  if (!Array.isArray(fieldPool) || fieldPool.length === 0) return [];
  const skip = alreadyWrittenNames instanceof Set
    ? alreadyWrittenNames
    : new Set(Array.isArray(alreadyWrittenNames) ? alreadyWrittenNames : []);
  const seen = new Set();
  const out = [];
  for (const def of fieldPool) {
    if (!def || typeof def.name !== 'string' || !def.name) continue;
    if (skip.has(def.name)) continue;
    if (seen.has(def.name)) continue; // crew-scoped + agent-scoped same name → take first
    if (!Object.prototype.hasOwnProperty.call(parsedOutput, def.name)) continue;
    const value = parsedOutput[def.name];
    if (value === null || value === undefined) continue;
    seen.add(def.name);
    out.push({
      kind:   'memory',
      domain: (typeof def.domain === 'string' && def.domain.trim()) ? def.domain.trim() : null,
      field:  def.name,
      value,
    });
  }
  return out;
}

module.exports = {
  SYSTEM_FIELDS,
  isSystemFieldName,
  findSystemField,
  coerceSystemFieldValue,
  harvestSystemFieldWrites,
  harvestDeclaredFieldWrites,
  resetSystemFields,
};
