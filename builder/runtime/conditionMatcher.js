/**
 * Builder V2 — shared condition matcher.
 *
 * Used by both the Transition Router and the Triggered Context
 * addons. ONE condition vocabulary across the system, ONE matcher to
 * maintain.
 *
 * The condition shape mirrors the client's `TransitionCondition`
 * (see `aspect-react-client/src/builder/types/index.ts`):
 *
 *   - { type: 'fields-collected', fields: string[] }
 *   - { type: 'field', field: string, op: FieldOp, value?, values? }
 *
 * Operators (`FieldOp`): equals, not-equals, contains, starts-with,
 * ends-with, gt, gte, lt, lte, in, not-in.
 *
 * Returns rich `{ ok, why }` results from `evaluateCondition` so the
 * caller can surface per-condition explanations in the addon run
 * card (Transition Router does this today). `evaluateConditions`
 * is the AND-of-all helper most callers want.
 */

const builderMemory = require('./builderMemory');

/**
 * Apply a binary operator. Both sides coerced as needed:
 *   - string ops (contains / starts-with / ends-with) → String() both
 *   - numeric ops (gt / gte / lt / lte) → Number() both, NaN → not-ok
 *   - equality (equals / not-equals) → String() both
 */
function applyOp(op, actual, expected) {
  if (op === 'equals')      return String(actual) === String(expected);
  if (op === 'not-equals')  return String(actual) !== String(expected);
  if (op === 'contains')    return String(actual).includes(String(expected));
  if (op === 'starts-with') return String(actual).startsWith(String(expected));
  if (op === 'ends-with')   return String(actual).endsWith(String(expected));
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    const a = Number(actual);
    const b = Number(expected);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (op === 'gt')  return a >  b;
    if (op === 'gte') return a >= b;
    if (op === 'lt')  return a <  b;
    if (op === 'lte') return a <= b;
  }
  return false;
}

/**
 * Evaluate a single condition against the brain blob's memory section
 * (always the memory section — thinking/triggered aren't condition
 * inputs; they're outputs).
 *
 * @param {Object} blob       — the full brain blob (memory + thinking + triggered)
 * @param {Object} condition  — TransitionCondition shape
 * @returns {{ ok: boolean, why: string }}
 */
function evaluateCondition(blob, condition) {
  switch (condition.type) {
    case 'fields-collected': {
      const fields = Array.isArray(condition.fields) ? condition.fields : [];
      if (fields.length === 0) return { ok: false, why: 'no fields configured' };
      const missing = fields.filter(name => {
        const v = builderMemory.findFieldValue(blob, name, 'memory');
        return v === undefined || v === null || v === '';
      });
      return missing.length === 0
        ? { ok: true,  why: `all ${fields.length} fields populated` }
        : { ok: false, why: `missing: ${missing.join(', ')}` };
    }
    case 'field': {
      const v = builderMemory.findFieldValue(blob, condition.field, 'memory');
      const op = condition.op;
      // `in` / `not-in` use the `values` array; everything else uses
      // the scalar `value`. Mirrors the client's TransitionCondition.
      if (op === 'in' || op === 'not-in') {
        const values = Array.isArray(condition.values) ? condition.values : [];
        const inSet = v !== undefined && values.some(x => String(x) === String(v));
        const ok = op === 'in' ? inSet : !inSet;
        return {
          ok,
          why: `${condition.field}=${JSON.stringify(v)} ${op} [${values.join(', ')}]`,
        };
      }
      const ok = v !== undefined && applyOp(op, v, condition.value);
      return {
        ok,
        why: ok
          ? `${condition.field} ${op} ${JSON.stringify(condition.value)} (actual: ${JSON.stringify(v)})`
          : `${condition.field}=${JSON.stringify(v)} fails ${op} ${JSON.stringify(condition.value)}`,
      };
    }
    default:
      return { ok: false, why: `unknown condition type "${condition.type}"` };
  }
}

/**
 * AND-of-conditions. Returns `{ ok, evaluations }` so callers can
 * surface each condition's outcome in the run card.
 *
 * @param {Object} blob — the brain blob
 * @param {Array<Object>} conditions
 * @returns {{ ok: boolean, evaluations: Array<{ type: string, ok: boolean, why: string }> }}
 */
function evaluateConditions(blob, conditions) {
  const evaluations = [];
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return { ok: false, evaluations };
  }
  for (const c of conditions) {
    const res = evaluateCondition(blob, c);
    evaluations.push({ type: c.type, ok: res.ok, why: res.why });
    if (!res.ok) {
      return { ok: false, evaluations };
    }
  }
  return { ok: true, evaluations };
}

module.exports = {
  applyOp,
  evaluateCondition,
  evaluateConditions,
};
