/**
 * Triggered Context plugin — server-side.
 *
 * No LLM call. Two rule kinds:
 *
 *  - `switch`: for each case, check `memory[field] equals case.value`.
 *    First matching case wins. On match, write that case's
 *    `contextText` to `triggered.<domain>.<field>`. The source field
 *    name doubles as the memory key.
 *
 *  - `match`: AND-of-conditions (shared matcher with Transition
 *    Router). On match, write the rule's `contextText` to
 *    `triggered.<domain>.<name>`. The user-typed `name` IS the key
 *    verbatim — no slugification. Empty falls back to
 *    `rule_<short-id>` so the rule still fires.
 *
 * Multiple matching rules writing to the SAME key (e.g. two switches
 * on the same field, two customs with the same name) → texts are
 * concatenated with `\n\n`. Domain is set once per addon instance
 * (default `'triggered'`), not per rule.
 *
 * Output: json-to-memory. Per-write `kind: 'triggered'` routes the
 * engine's `applyWrites` into the right brain section.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { evaluateConditions } = require('../../runtime/conditionMatcher');
const builderMemory = require('../../runtime/builderMemory');
const descriptor = require('../../addons/triggeredContext.addon.json');

const TRIGGERED_CONTEXT_PLUGIN_ID = descriptor.pluginId;

/** Short id fragment so a nameless Match rule still gets a stable
 *  but unique-ish memory key it can fire under. */
function shortIdFragment(id) {
  if (typeof id !== 'string' || !id) return 'unknown';
  const parts = id.split('_');
  return parts[parts.length - 1].slice(0, 6) || 'unknown';
}

/** Resolve a value from memory for a field-equals check.
 *  Reads from the `memory` section only — `triggered` and `thinking`
 *  are outputs, not condition inputs. */
function memoryValue(blob, fieldName) {
  return builderMemory.findFieldValue(blob, fieldName, 'memory');
}

/** First-match-wins evaluation for a switch rule. Returns the matched
 *  case (or null) along with a human-readable `why` for the run card. */
function evaluateSwitch(blob, rule) {
  const fieldName = (rule.field || '').trim();
  if (!fieldName) return { matched: null, why: 'no field configured' };
  const actual = memoryValue(blob, fieldName);
  if (actual === undefined || actual === null) {
    return { matched: null, why: `${fieldName} has no value yet` };
  }
  const cases = Array.isArray(rule.cases) ? rule.cases : [];
  for (const c of cases) {
    if (!c || typeof c !== 'object') continue;
    if (String(c.value) === String(actual)) {
      return {
        matched: c,
        why: `${fieldName}=${JSON.stringify(actual)} → case ${JSON.stringify(c.value)}`,
      };
    }
  }
  return {
    matched: null,
    why: `${fieldName}=${JSON.stringify(actual)} matched no case`,
  };
}

async function run(ctx) {
  const start = Date.now();
  const cfg = ctx.instance.config || {};
  // Default to 'triggered' when the user wipes the domain — matches
  // the section name and avoids collapsing into the no-domain bucket.
  const domain = (typeof cfg.domain === 'string' && cfg.domain.trim()) ? cfg.domain.trim() : 'triggered';
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];

  const evaluations = [];
  // Accumulate per derived memory-key → concatenate with \n\n.
  const byField = new Map();

  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;

    if (r.kind === 'switch') {
      const fieldName = (r.field || '').trim();
      const { matched, why } = evaluateSwitch(ctx.memory, r);
      evaluations.push({
        ruleId: r.id, kind: 'switch',
        field: fieldName || null, memoryKey: fieldName || null,
        matched: !!matched, why,
      });
      if (matched && typeof matched.contextText === 'string' && matched.contextText.trim() && fieldName) {
        if (!byField.has(fieldName)) byField.set(fieldName, []);
        byField.get(fieldName).push(matched.contextText);
      }
      continue;
    }

    if (r.kind === 'match') {
      // User-typed name IS the memory key, verbatim. Trim only.
      // Empty falls back to a stable rule_<id> key so the rule still
      // fires — the editor's placeholder nudges the user to set one.
      const name = (r.name || '').trim();
      const key  = name || `rule_${shortIdFragment(r.id)}`;
      const { ok, evaluations: condEvals } = evaluateConditions(ctx.memory, r.conditions || []);
      evaluations.push({
        ruleId: r.id, kind: 'match', name: name || null,
        memoryKey: key, matched: ok, conditions: condEvals,
      });
      if (ok && typeof r.contextText === 'string' && r.contextText.trim()) {
        if (!byField.has(key)) byField.set(key, []);
        byField.get(key).push(r.contextText);
      }
      continue;
    }

    // Unknown kind — surface in the run card but don't crash.
    evaluations.push({
      ruleId: r.id, kind: r.kind,
      matched: false, why: `unknown rule kind "${r.kind}"`,
    });
  }

  const memoryWrites = [];
  for (const [field, texts] of byField) {
    memoryWrites.push({
      kind:   'triggered',
      domain,
      field,
      value:  texts.join('\n\n'),
    });
  }

  const payload = {
    domain,
    rulesEvaluated: evaluations.length,
    rulesMatched:   evaluations.filter(e => e.matched).length,
    evaluations,
  };

  return {
    rawOutput:    JSON.stringify(payload, null, 2),
    parsedOutput: payload,
    memoryWrites,
    durationMs:   Date.now() - start,
    tokens:       { input: 0, output: 0, total: 0 },
  };
}

registerPlugin({
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  requiresModel:      false,
  run,
});

module.exports = { TRIGGERED_CONTEXT_PLUGIN_ID };
