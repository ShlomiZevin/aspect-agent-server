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
const { evaluateConditions } = require('../../runtime/conditionMatcher');
const descriptor = require('../../addons/transitionRouter.addon.json');

const TRANSITION_ROUTER_PLUGIN_ID = descriptor.pluginId;

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

  // ALL conditions must pass — shared matcher short-circuits on first
  // miss and returns the partial evaluations array so we can show
  // exactly which condition failed in the addon run card.
  const { ok: allOk, evaluations } = evaluateConditions(memory, conditions);

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
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  // This plugin doesn't call the LLM — it only evaluates rules
  // against the in-memory conversation memory blob. The engine
  // checks this flag to skip its "no model configured" check for
  // plugins that don't need one.
  requiresModel: false,
  run,
});

module.exports = { TRANSITION_ROUTER_PLUGIN_ID };
