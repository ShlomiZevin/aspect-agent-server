/**
 * Transition Router plugin — server side.
 *
 * Doesn't call the LLM. Evaluates an AND-list of conditions against
 * the current conversation memory; when ALL match, returns a
 * `transition` field the engine acts on (updates the conversation's
 * `currentCrewId`). If the instance is configured with
 * `onMatch: 'break'`, also returns `breakChain: true` so the engine
 * skips the rest of this turn's chain.
 *
 * See docs/guides/BUILDER_V2.md → "Crew Transitions" for the spec
 * and docs/guides/BUILDER_V2_RUNTIME_PLAN.md → P4 for runtime
 * integration.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const builderMemory = require('../../runtime/builderMemory');

const TRANSITION_ROUTER_PLUGIN_ID = 'transition-router';

/**
 * @param {object} blob
 * @param {object} condition
 * @returns {{ ok: boolean, why: string }}
 */
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

function evaluateCondition(blob, condition) {
  switch (condition.type) {
    case 'fields-collected': {
      const fields = Array.isArray(condition.fields) ? condition.fields : [];
      if (fields.length === 0) return { ok: false, why: 'no fields configured' };
      const missing = fields.filter(name => {
        const v = builderMemory.findFieldValue(blob, name);
        return v === undefined || v === null || v === '';
      });
      return missing.length === 0
        ? { ok: true,  why: `all ${fields.length} fields populated` }
        : { ok: false, why: `missing: ${missing.join(', ')}` };
    }
    case 'field': {
      const v = builderMemory.findFieldValue(blob, condition.field);
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

async function run(ctx) {
  const { instance, memory } = ctx;
  const start = Date.now();
  const cfg = instance.config || {};
  const conditions = Array.isArray(cfg.conditions) ? cfg.conditions : [];
  const target     = cfg.target || null;
  const onMatch    = cfg.onMatch === 'break' ? 'break' : 'continue';
  const reason     = cfg.reason || '';

  // No conditions or no target = misconfigured. Don't fire; surface
  // a "no-match" output so the user sees the no-op in the timeline.
  if (conditions.length === 0 || !target) {
    return {
      rawOutput:    JSON.stringify({ matched: false, reason: 'not configured' }),
      parsedOutput: { matched: false, reason: 'not configured', evaluations: [] },
      memoryWrites: [],
      durationMs:   Date.now() - start,
      tokens:       { input: 0, output: 0, total: 0 },
    };
  }

  // ALL conditions must pass. Short-circuit on first miss.
  const evaluations = [];
  let allOk = true;
  for (const c of conditions) {
    const res = evaluateCondition(memory, c);
    evaluations.push({ type: c.type, ok: res.ok, why: res.why });
    if (!res.ok) {
      allOk = false;
      break;
    }
  }

  if (!allOk) {
    return {
      rawOutput:    JSON.stringify({ matched: false, evaluations }),
      parsedOutput: { matched: false, evaluations },
      memoryWrites: [],
      durationMs:   Date.now() - start,
      tokens:       { input: 0, output: 0, total: 0 },
    };
  }

  // Matched. Engine reads these fields after run() returns:
  //   transition → write `conversations.metadata.currentCrewId`
  //   breakChain → stop iterating the chain for this turn
  const payload = {
    matched:    true,
    to:         target,
    reason:     reason || evaluations.map(e => e.why).join(' & '),
    onMatch,
    evaluations,
  };
  return {
    rawOutput:    JSON.stringify(payload),
    parsedOutput: payload,
    memoryWrites: [],
    durationMs:   Date.now() - start,
    tokens:       { input: 0, output: 0, total: 0 },
    transition:   { to: target, reason: payload.reason },
    breakChain:   onMatch === 'break',
  };
}

registerPlugin({
  id: TRANSITION_ROUTER_PLUGIN_ID,
  allowedOutputTypes: ['transition'],
  // This plugin doesn't call the LLM — it only evaluates rules
  // against the in-memory conversation memory blob. The engine
  // checks this flag to skip its "no model configured" check for
  // plugins that don't need one.
  requiresModel: false,
  run,
});

module.exports = { TRANSITION_ROUTER_PLUGIN_ID };
