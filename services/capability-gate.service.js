/**
 * Capability gate — deterministic pre-flight for datasets with a capability
 * manifest (Stage 2, Step 2).
 *
 * Runs BEFORE SQL generation, costs zero LLM calls, and does exactly two
 * things:
 *
 *  1. REFUSE, structurally, questions about dimensions the manifest declares
 *     absent — matched by that refusal's high-precision `triggers` regexes.
 *     The baseline showed prompt-level refusals already work ~always; the
 *     gate's job is making them INVARIANT (a regex fires every run; a prompt
 *     fires most runs) and free (no SQL generation, no query, ~0s).
 *
 *  2. DETECT unresolved client vocabulary ("מכירות כולל מעמ", the P-marker)
 *     and return it as structured `unresolvedTerms` so the caller can (a)
 *     say so in the answer and (b) stop retry marathons hunting for fields
 *     that do not exist.
 *
 * Precision beats recall: anything ambiguous falls through (`action:
 * 'proceed'`) to the existing prompt-level handling. A gate failure of any
 * kind also falls through — ambiguity never blocks a customer question
 * (same principle as the insights classifier).
 *
 * No manifest → callers must not even call this (data-query.service guards).
 */

/**
 * @param {string} question - the natural-language question
 * @param {Object} manifest - the dataset's capability manifest (required)
 * @returns {{action: 'proceed'|'refuse', refusal?: {dimension, reason, roadmap, alternatives}, unresolvedTerms: Array<{terms, detail}>}}
 */
function check(question, manifest) {
  const result = { action: 'proceed', unresolvedTerms: [] };
  if (!question || !manifest) return result;

  try {
    // 1. Absent-dimension refusals — first unambiguous trigger wins.
    for (const [dimension, refusal] of Object.entries(manifest.refusals || {})) {
      for (const trigger of refusal.triggers || []) {
        if (trigger.test(question)) {
          return {
            action: 'refuse',
            refusal: {
              dimension,
              reason: refusal.reason,
              roadmap: refusal.roadmap,
              alternatives: refusal.alternatives || null,
            },
            unresolvedTerms: [],
          };
        }
      }
    }

    // 2. Unresolved vocabulary — collected, never blocking on its own.
    for (const v of manifest.vocabulary || []) {
      if (v.resolution !== 'unresolved') continue;
      if ((v.terms || []).some(t => question.includes(t))) {
        result.unresolvedTerms.push({ terms: v.terms, detail: v.detail });
      }
    }
  } catch (err) {
    // Never let the gate break a question — fall through wide open.
    console.warn(`⚠️  Capability gate error (${manifest?.id}): ${err.message}`);
    return { action: 'proceed', unresolvedTerms: [] };
  }
  return result;
}

module.exports = { check };
