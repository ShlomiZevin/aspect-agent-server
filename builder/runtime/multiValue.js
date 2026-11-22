/**
 * Multi-value fields (task #947) — one place that knows what a
 * "several values" field is and how its value is read.
 *
 * A field is multi-value when it is an enum field (a Choice or a
 * Targeted KB) with `multiple: true`, and is not pinned (a pinned field
 * is a single selector — which bank — so the flag is ignored there).
 *
 * Its memory value is a list of the enum's own values, de-duplicated and
 * kept in the ENUM'S AUTHORED ORDER (no ranking — the order a value was
 * picked in means nothing). An empty selection is never stored: writing
 * `[]` clears the field, so "nothing selected" and "never collected" are
 * the same state.
 *
 * Reading is lenient so switching the flag never needs a migration: a
 * plain string read through a multi-value field is a list of one.
 *
 * Mirrored on the client in
 * `aspect-react-client/src/builder/state/multiValue.ts` — change both.
 */

/** True when `def` is a multi-value field. */
function isMultiField(def) {
  return !!(def && def.type === 'enum' && def.multiple === true && def.source !== 'pinned');
}

/**
 * Any stored value → a clean list of strings. Arrays keep their
 * non-empty members; a non-empty scalar becomes a list of one; empty /
 * missing → [].
 */
function valuesOf(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter(v => v !== undefined && v !== null)
      .map(v => String(v).trim())
      .filter(Boolean);
  }
  const s = String(raw).trim();
  return s ? [s] : [];
}

/**
 * De-duplicate and sort `values` into the enum's authored order. Values
 * that are not on the enum keep their relative order at the end (the
 * caller decides whether they are allowed at all).
 */
function orderByEnum(values, enumDef) {
  const list = [...new Set(valuesOf(values))];
  const order = new Map();
  (enumDef && Array.isArray(enumDef.values) ? enumDef.values : []).forEach((v, i) => {
    if (v && typeof v.value === 'string' && !order.has(v.value)) order.set(v.value, i);
  });
  const rank = v => (order.has(v) ? order.get(v) : Number.MAX_SAFE_INTEGER);
  return list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (rank(a.v) - rank(b.v)) || (a.i - b.i))
    .map(x => x.v);
}

/** How a multi-value field reads inline in a prompt: `a, b`. */
function formatList(values) {
  return valuesOf(values).join(', ');
}

module.exports = { isMultiField, valuesOf, orderByEnum, formatList };
