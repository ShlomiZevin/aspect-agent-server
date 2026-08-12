/**
 * Rules plugin — server side.
 *
 * Deterministic if/then engine over conversation memory. No LLM call.
 * Each rule: WHEN (AND-conditions, same vocabulary as filters/router;
 * an EMPTY list means "always fires" — that's how computed fields are
 * expressed) + THEN (ordered actions).
 *
 * Actions:
 *   set        → memory write. Value modes: fixed | copy (another
 *                field) | compute (fixed function library below).
 *   clear      → per-field delete across all domains (builderMemory
 *                honors { clear:true, domain:'*' } writes).
 *   transition → same contract as the Transition Router: returns a
 *                `transition` the engine acts on (fires same turn).
 *   stop       → breakChain: skip the rest of this turn's chain,
 *                including the Talker.
 *   reply      → fixed assistant text. Pair with stop so the Talker
 *                doesn't overwrite it.
 *
 * Rules run top to bottom; every matching rule fires; later writes
 * win (applyWrites applies in order). Set-values are visible to LATER
 * rules' conditions within the same run via a working overlay.
 *
 * The client keeps `config.extractsFields` in sync with every field
 * the rules touch, so the engine hands us resolved FieldDefs
 * (ctx.extractorFields) — that's how set-writes land in the field's
 * declared DOMAIN instead of the general bucket.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { evaluateConditions } = require('../../runtime/conditionMatcher');
const builderMemory = require('../../runtime/builderMemory');
const formulaEval = require('../../runtime/formulaEval');
const descriptor = require('../../addons/rules.addon.json');

const RULES_PLUGIN_ID = descriptor.pluginId;

const MS_DAY = 24 * 60 * 60 * 1000;

/** Resolve a field's current value: working overlay first (values set
 *  by earlier rules THIS run), then persisted memory. */
function readField(memory, overlay, name) {
  if (name && Object.prototype.hasOwnProperty.call(overlay, name)) return overlay[name];
  return builderMemory.findFieldValue(memory, name, 'memory');
}

/** The fixed compute-function library. Every function is deterministic
 *  code we own — there is no user-authored expression language. */
function computeValue(compute, memory, overlay) {
  const fn = compute && compute.fn;
  if (fn === 'today') {
    return new Date().toISOString().slice(0, 10);
  }
  if (fn === 'years-since' || fn === 'days-since') {
    const raw = readField(memory, overlay, compute.field);
    const date = raw ? new Date(raw) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return { error: `"${compute.field}" is not a valid date (${JSON.stringify(raw)})` };
    }
    const days = Math.floor((Date.now() - date.getTime()) / MS_DAY);
    return fn === 'days-since' ? days : Math.floor(days / 365.25);
  }
  if (fn === 'add' || fn === 'subtract') {
    const a = Number(readField(memory, overlay, compute.field));
    const b = compute.otherField !== undefined && compute.otherField !== ''
      ? Number(readField(memory, overlay, compute.otherField))
      : Number(compute.number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { error: `non-numeric operand (a=${a}, b=${b})` };
    }
    return fn === 'add' ? a + b : a - b;
  }
  return { error: `unknown function "${fn}"` };
}

async function run(ctx) {
  const { instance, memory } = ctx;
  const start = Date.now();
  const cfg = instance.config || {};
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];

  // field name → FieldDef (for domain resolution on set-writes).
  const pool = new Map((ctx.extractorFields || []).map(f => [f.name, f]));

  const memoryWrites = [];
  const lines = [];
  const ruleResults = [];
  // Values set by earlier rules this run — later rules' conditions and
  // computes see them even though memory isn't persisted yet.
  const overlay = {};

  let transition = null;
  let breakChain = false;
  let assistantText = null;

  rules.forEach((rule, i) => {
    const num = i + 1;
    if (rule.enabled === false) {
      ruleResults.push({ num, matched: false, skipped: 'disabled', actions: [] });
      lines.push(`· Rule ${num}: disabled`);
      return;
    }
    if (breakChain) {
      ruleResults.push({ num, matched: false, skipped: 'after stop', actions: [] });
      lines.push(`· Rule ${num}: not evaluated (chain stopped by an earlier rule)`);
      return;
    }

    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    let matched = true;
    let evaluations = [];
    if (conditions.length > 0) {
      // Overlay-aware matching: shadow memory fields set earlier this run.
      const shadow = Object.keys(overlay).length > 0
        ? mergeOverlay(memory, overlay)
        : memory;
      const res = evaluateConditions(shadow, conditions, { instanceId: instance.instanceId });
      matched = res.ok;
      evaluations = res.evaluations;
    }

    if (!matched) {
      ruleResults.push({ num, matched: false, evaluations, actions: [] });
      lines.push(`· Rule ${num}: no match (${evaluations.map(e => e.why).join('; ') || 'no conditions met'})`);
      return;
    }

    const done = [];
    for (const action of (Array.isArray(rule.actions) ? rule.actions : [])) {
      if (action.type === 'set' && action.field) {
        let value;
        if (action.valueMode === 'copy') {
          value = readField(memory, overlay, action.fromField);
        } else if (action.valueMode === 'formula') {
          // Real-JS single expression via the fenced evaluator
          // (lint + vm timeout). {{field}} tokens see the overlay.
          const r = formulaEval.evaluate(action.formula, name => readField(memory, overlay, name));
          if (!r.ok) {
            done.push({ type: 'set', field: action.field, error: r.error, formula: r.substituted });
            continue;
          }
          value = r.value;
          if (value === undefined || value === null) {
            done.push({ type: 'set', field: action.field, error: 'formula produced no value', formula: r.substituted });
            continue;
          }
          const fdef = pool.get(action.field);
          memoryWrites.push({ domain: (fdef && fdef.domain) || null, field: action.field, value });
          overlay[action.field] = value;
          // WYSIWYG: keep the substituted expression so the run card
          // shows the calculation with real values, not just the result.
          done.push({ type: 'set', field: action.field, value, formula: r.substituted });
          continue;
        } else if (action.valueMode === 'compute') {
          const r = computeValue(action.compute || {}, memory, overlay);
          if (r && typeof r === 'object' && r.error) {
            done.push({ type: 'set', field: action.field, error: r.error });
            continue;
          }
          value = r;
        } else {
          value = action.value;
        }
        if (value === undefined || value === null) {
          done.push({ type: 'set', field: action.field, error: 'no value (source empty)' });
          continue;
        }
        const def = pool.get(action.field);
        memoryWrites.push({ domain: (def && def.domain) || null, field: action.field, value });
        overlay[action.field] = value;
        done.push({ type: 'set', field: action.field, value });
      } else if (action.type === 'clear' && action.field) {
        memoryWrites.push({ field: action.field, clear: true, domain: '*' });
        overlay[action.field] = undefined;
        done.push({ type: 'clear', field: action.field });
      } else if (action.type === 'transition' && action.target) {
        transition = {
          to: action.target,
          reason: `Rule ${num} matched`,
          fireImmediately: action.fireImmediately !== false,
        };
        done.push({ type: 'transition', target: action.target });
      } else if (action.type === 'stop') {
        breakChain = true;
        done.push({ type: 'stop' });
      } else if (action.type === 'reply' && typeof action.text === 'string' && action.text.trim()) {
        assistantText = action.text;
        done.push({ type: 'reply' });
      }
    }

    ruleResults.push({ num, matched: true, evaluations, actions: done });
    // Show WHY it matched too (esp. formula conditions: expression
    // with substituted values → result), not just what it did.
    const whenNote = evaluations.length > 0
      ? ` [when: ${evaluations.map(e => e.why).join(' & ')}]`
      : '';
    lines.push(`✓ Rule ${num}${whenNote}: ${done.map(describeAction).join(', ') || 'matched, no actions'}`);
  });

  const fired = ruleResults.filter(r => r.matched).length;
  const summary = `Fired ${fired} of ${rules.length} rule${rules.length === 1 ? '' : 's'}`;

  const result = {
    rawOutput: [summary, ...lines].join('\n'),
    parsedOutput: { summary, fired, total: rules.length, ruleResults },
    memoryWrites,
    durationMs: Date.now() - start,
    tokens: { input: 0, output: 0, total: 0 },
  };
  if (transition) result.transition = transition;
  if (breakChain) result.breakChain = true;
  if (assistantText) result.assistantText = assistantText;
  return result;
}

function describeAction(a) {
  if (a.error) return `${a.type} ${a.field}: FAILED (${a.error})`;
  if (a.type === 'set' && a.formula) return `set ${a.field} = ${JSON.stringify(a.value)}  [${a.formula}]`;
  if (a.type === 'set') return `set ${a.field} = ${JSON.stringify(a.value)}`;
  if (a.type === 'clear') return `clear ${a.field}`;
  if (a.type === 'transition') return `transition → ${a.target}`;
  if (a.type === 'stop') return 'stop chain';
  if (a.type === 'reply') return 'fixed reply';
  return a.type;
}

/** Cheap structural overlay: clone the memory section shallowly and
 *  lay overlay values into the general bucket so findFieldValue sees
 *  them. Cleared fields (undefined) are removed from every domain. */
function mergeOverlay(memory, overlay) {
  const clone = JSON.parse(JSON.stringify(memory || {}));
  if (!clone.memory) clone.memory = {};
  if (!clone.memory._general) clone.memory._general = {};
  for (const [name, value] of Object.entries(overlay)) {
    if (value === undefined) {
      for (const d of Object.keys(clone.memory)) delete clone.memory[d][name];
    } else {
      clone.memory._general[name] = value;
    }
  }
  return clone;
}

registerPlugin({
  id: descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  // Pure deterministic evaluation over the memory blob — no LLM.
  requiresModel: false,
  run,
});

module.exports = { RULES_PLUGIN_ID };
