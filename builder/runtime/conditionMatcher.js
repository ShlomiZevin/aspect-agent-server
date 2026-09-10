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
 *   - { type: 'run-count', max: number } — caps how many times THIS
 *     addon instance has run successfully this conversation. Counter
 *     lives on `blob.runCounts[instanceId]`; the runtime bumps it on
 *     every successful addon completion (see addonRunner.js).
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
const formulaEval = require('./formulaEval');

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
 * Parameter references in conditions (task #826).
 *
 * An operand written as `#name` points at an agent PARAMETER instead of
 * a memory field — the same vocabulary prompts already use, so a value
 * like an age threshold is declared once and referenced everywhere
 * rather than retyped into each rule (which is how the two drift apart).
 *
 * Resolution is deliberately STRICT: an unknown parameter, or one used
 * where the runtime didn't supply the agent's parameter list, fails the
 * condition with a readable reason. Silently falling back to the literal
 * text `"#minorAge"` would reintroduce exactly the drift this exists to
 * kill — and it would fail invisibly.
 *
 * Supplied today by the Rules addon, the Transition Router and addon
 * filters. Live Brain / Profiler panel filters and trigger filters
 * resolve without a parameter list, so a `#ref` there says so out loud.
 */
const PARAM_REF = /^#([A-Za-z_][A-Za-z0-9_]*)$/;

function isParamRef(v) {
  return typeof v === 'string' && PARAM_REF.test(v);
}

/** `#name` → its configured value. `{ value, label }`, or `{ error }`. */
function resolveParamRef(ref, parameters) {
  const name = String(ref).slice(1);
  if (!Array.isArray(parameters)) {
    return { error: `parameter #${name} is not available in this context` };
  }
  const found = parameters.find(p => p && p.name === name);
  if (!found) return { error: `parameter #${name} is not defined` };
  // The label carries BOTH the reference and what it resolved to, so a
  // run card reads `#minorAge (18)` — the author sees the indirection
  // AND the value that actually did the comparing.
  return { value: found.value, label: `#${name} (${JSON.stringify(found.value)})` };
}

/** Left-hand operand: a `#parameter`, or a field read from the brain. */
function resolveOperand(ref, blob, parameters) {
  if (isParamRef(ref)) return resolveParamRef(ref, parameters);
  return { value: builderMemory.findFieldValue(blob, ref, 'memory'), label: String(ref) };
}

/** Right-hand operand: a `#parameter`, or the literal as authored. */
function resolveOperandValue(raw, parameters) {
  if (isParamRef(raw)) return resolveParamRef(raw, parameters);
  return { value: raw, label: JSON.stringify(raw) };
}

/**
 * Resolver for `{{...}}` tokens inside a formula: `{{#minorAge}}` reads a
 * parameter, anything else reads the brain (task #826).
 *
 * A bad parameter reference THROWS — `formulaEval` catches it and reports
 * `formula error: parameter #x is not defined`. Substituting null instead
 * would quietly change what the formula computes.
 */
function formulaTokenResolver(blob, parameters) {
  return (name) => {
    if (isParamRef(name)) {
      const r = resolveParamRef(name, parameters);
      if (r.error) throw new Error(r.error);
      return r.value;
    }
    return builderMemory.findFieldValue(blob, name, 'memory');
  };
}

/**
 * Evaluate a single condition against the brain blob's memory section
 * (always the memory section — thinking/triggered aren't condition
 * inputs; they're outputs).
 *
 * @param {Object} blob       — the full brain blob (memory + thinking + triggered)
 * @param {Object} condition  — TransitionCondition shape
 * @param {Object} [ctx]      — optional evaluation context. Today only
 *   `instanceId` is consulted (used by the `run-count` condition to
 *   look up `blob.runCounts[instanceId]`). When omitted, conditions
 *   that need it return ok=false with a self-explanatory `why`.
 * @returns {{ ok: boolean, why: string }}
 */
function evaluateCondition(blob, condition, ctx) {
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
    case 'run-count': {
      const max = Number(condition.max);
      if (!Number.isFinite(max) || max < 1) {
        return { ok: false, why: 'invalid max' };
      }
      const instanceId = ctx && ctx.instanceId;
      if (!instanceId) {
        // Defensive: the caller forgot to pass ctx. Treat as "true"
        // (don't accidentally cap every addon to zero runs).
        return { ok: true, why: 'no instance context — treating as unbounded' };
      }
      const counts = (blob && blob.runCounts) || {};
      const seen = Number(counts[instanceId]) || 0;
      return seen < max
        ? { ok: true,  why: `run ${seen + 1} of max ${max}` }
        : { ok: false, why: `already ran ${seen} time${seen === 1 ? '' : 's'} (max ${max})` };
    }
    case 'field': {
      // Either operand may be a `#parameter` reference (task #826) — so
      // a threshold lives in the agent's parameters instead of being
      // retyped into every rule that compares against it.
      const parameters = ctx && ctx.parameters;
      const subject = resolveOperand(condition.field, blob, parameters);
      if (subject.error) return { ok: false, why: subject.error };
      const v = subject.value;
      // Display missing as `null` — same vocabulary the formula path
      // uses for unset fields, so run-card explanations never mix
      // `undefined` and `null` for the same state.
      const shown = JSON.stringify(v === undefined ? null : v);
      const op = condition.op;
      // No-operand emptiness checks — the ONLY field ops that can
      // match a never-collected field (every other op requires a
      // value to exist). '' counts as empty, same as fields-collected.
      if (op === 'is-null' || op === 'is-not-null') {
        const empty = v === undefined || v === null || v === '';
        const ok = op === 'is-null' ? empty : !empty;
        return {
          ok,
          why: empty ? `${subject.label} is empty` : `${subject.label} has a value (${shown})`,
        };
      }
      // `in` / `not-in` use the `values` array; everything else uses
      // the scalar `value`. Mirrors the client's TransitionCondition.
      if (op === 'in' || op === 'not-in') {
        const raw = Array.isArray(condition.values) ? condition.values : [];
        const resolved = [];
        for (const one of raw) {
          const r = resolveOperandValue(one, parameters);
          if (r.error) return { ok: false, why: r.error };
          resolved.push(r);
        }
        const inSet = v !== undefined && resolved.some(x => String(x.value) === String(v));
        const ok = op === 'in' ? inSet : !inSet;
        return {
          ok,
          why: `${subject.label}=${shown} ${op} [${resolved.map(x => x.label).join(', ')}]`,
        };
      }
      const operand = resolveOperandValue(condition.value, parameters);
      if (operand.error) return { ok: false, why: operand.error };
      const ok = v !== undefined && applyOp(op, v, operand.value);
      return {
        ok,
        why: ok
          ? `${subject.label} ${op} ${operand.label} (actual: ${shown})`
          : `${subject.label}=${shown} fails ${op} ${operand.label}`,
      };
    }
    case 'formula': {
      // Real-JS single expression, truthiness decides. `{{field}}`
      // tokens resolve against memory. Errors (lint, runtime, timeout)
      // evaluate to NOT-matched with the error surfaced in `why`.
      const res = formulaEval.evaluate(
        condition.expr,
        formulaTokenResolver(blob, ctx && ctx.parameters),
      );
      if (!res.ok) {
        return { ok: false, why: `formula error: ${res.error}` };
      }
      const ok = Boolean(res.value);
      return { ok, why: `${res.substituted} → ${JSON.stringify(res.value)}` };
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
function evaluateConditions(blob, conditions, ctx) {
  const evaluations = [];
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return { ok: false, evaluations };
  }
  for (const c of conditions) {
    const res = evaluateCondition(blob, c, ctx);
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
  // Shared so plugins resolve `#parameter` references exactly the way
  // conditions do — one syntax, one resolver (task #826).
  isParamRef,
  resolveParamRef,
  formulaTokenResolver,
};
