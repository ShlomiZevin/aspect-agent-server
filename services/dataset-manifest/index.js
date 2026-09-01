/**
 * Dataset capability manifests — the "truth card" layer (Stage 2).
 *
 * A manifest is the per-dataset declaration of WHAT THE DATA CAN AND CANNOT
 * ANSWER, kept apart from the SQL-generation rules (schema-rules/) which say
 * HOW to query what exists. Rules rot when the schema moves; manifests rot
 * when the FEED moves — both are guarded by scripts/test-schema-contract.js.
 *
 * The generic engine (capability gate, coverage service, post-checks, answer
 * contract) activates for a dataset ONLY when get(schemaName) returns a
 * manifest. No manifest → every Stage-2 code path is skipped and the dataset
 * behaves exactly as before. That asymmetry is the multi-client safety
 * guarantee: adding a manifest is an explicit, reviewable opt-in per client.
 *
 * Manifest shape (all sections optional except id — a thin manifest is valid
 * and still buys refusals + coverage banners):
 *   {
 *     id: 'zolstock',
 *     vatRate: 1.18,                       // THE single VAT source for the dataset
 *     measures:   { <name>: {fidelity: 'exact'|'estimate'|'proxy', basis, knownDelta} }
 *     dimensions: { <name>: {status: 'available'|'unreliable'|'absent', detail, roadmap} }
 *     vocabulary: [ {terms: [..], resolution: 'field'|'unresolved', detail} ]
 *     dataFacts:  [ {fact, appliesTo} ]    // rendered into prompts + annotations
 *     coverage:   { dailyView, dateColumn, volumeColumn }   // enables coverage.service
 *     refusals:   { <dimensionName>: {reason, roadmap} }    // gate templates
 *   }
 */

const MANIFESTS = {
  zolstock: () => require('./zolstock.manifest'),
};

const cache = new Map();

/** @returns {Object|null} the dataset's manifest, or null (=> Stage-2 paths inactive). */
function get(schemaName) {
  if (!MANIFESTS[schemaName]) return null;
  if (!cache.has(schemaName)) cache.set(schemaName, MANIFESTS[schemaName]());
  return cache.get(schemaName);
}

/** All datasets that have a manifest (for contract tests). */
function ids() {
  return Object.keys(MANIFESTS);
}

/**
 * Render the manifest as a compact prompt section for SQL generation and the
 * crew system prompt. Facts only — no prose padding; token budget matters.
 */
function renderForPrompt(manifest) {
  if (!manifest) return '';
  const L = [];
  L.push(`## Dataset capability manifest (${manifest.id}) — AUTHORITATIVE limits of this data`);
  if (manifest.measures) {
    L.push('### Measures');
    for (const [name, m] of Object.entries(manifest.measures)) {
      let line = `- ${name}: ${m.fidelity.toUpperCase()}`;
      if (m.basis) line += ` — ${m.basis}`;
      if (m.knownDelta) line += ` (known delta vs client's own reports: ${m.knownDelta})`;
      L.push(line);
    }
  }
  if (manifest.dimensions) {
    L.push('### Dimensions');
    for (const [name, d] of Object.entries(manifest.dimensions)) {
      let line = `- ${name}: ${d.status.toUpperCase()}`;
      if (d.detail) line += ` — ${d.detail}`;
      L.push(line);
    }
  }
  if (manifest.vocabulary && manifest.vocabulary.length) {
    L.push('### Client vocabulary that does NOT map to this data (say so — never guess SQL for these)');
    for (const v of manifest.vocabulary.filter(v => v.resolution === 'unresolved')) {
      L.push(`- "${v.terms.join('" / "')}" — ${v.detail}`);
    }
  }
  if (manifest.dataFacts && manifest.dataFacts.length) {
    L.push('### Known data facts (disclose when relevant)');
    for (const f of manifest.dataFacts) L.push(`- ${f.fact}`);
  }
  return L.join('\n');
}

/**
 * Render the manifest as a "data discipline" block for the TALKER (crew)
 * prompt — behavioral rules the conversation model must follow when
 * presenting this dataset's numbers. Injected by CrewMember.buildContext()
 * for crews that declare `datasetSchema` (see crew/base/CrewMember.js);
 * rendered into the prompt by dispatcher.service the same way persona is.
 *
 * Facts only, tight token budget (≤500): this rides on EVERY turn.
 */
function renderForCrew(manifest) {
  if (!manifest) return '';
  const L = [];
  L.push('Answer discipline for this dataset:');
  L.push('- Start every reply with ONE direct sentence answering the question (the key figure or fact) BEFORE any table or breakdown. If the data cannot answer, that sentence states it plainly.');
  L.push('- When refusing because a dimension is absent: add ONE short sentence explaining that the client\'s source system holds this data but the export we receive does not include it — so the user understands it is a data-delivery gap, not a system fault — then offer the available alternatives. Keep the whole refusal under 4 sentences.');
  L.push('- NEVER arithmetically combine a number the user quoted with a number from the data (no adding, subtracting or averaging them). Either verify the user\'s number from the data, or state it cannot be verified from this dataset.');
  if (manifest.vatRate) {
    const pct = Math.round((manifest.vatRate - 1) * 100);
    L.push(`- VAT is ${pct}% (factor ${manifest.vatRate}). When the user quotes a figure, establish its VAT basis before comparing: a figure described as including VAT is compared to inc-VAT values, excluding to ex-VAT. If the basis is unknown, show the comparison on BOTH bases and say so.`);
  }
  const ambiguous = (manifest.vocabulary || []).filter(v => v.resolution === 'ambiguous');
  for (const v of ambiguous) {
    L.push(`- ONLY the exact phrase${v.terms.length > 1 ? 's' : ''} "${v.terms.join('" / "')}" ${v.terms.length > 1 ? 'are' : 'is'} AMBIGUOUS: ${v.detail} For these exact words ask ONE short clarifying question before fetching data. Do NOT extend this to other wordings — a question that names salespeople unambiguously (e.g. מוכרנים, סוכנים, salespeople) is NOT ambiguous: state directly that the dimension is absent and offer the available alternatives, without asking anything.`);
  }
  // Contributed by whichever modules are live for this dataset (plan D7).
  // Absent when none are, so a dataset with no module renders exactly as before.
  if (manifest.moduleNotes?.length) {
    L.push('Figures this client has switched on, which are COMPUTED rather than read from the source system:');
    L.push(...manifest.moduleNotes);
    L.push('- When you use one of these, say which basis it rests on. Never present a computed figure as if the source system reported it.');
  }

  return L.join('\n');
}

/**
 * The dataset manifest with every live module's fragment folded in.
 *
 * This is plan decision D7: a module contributes to what the agent is told
 * about the data, but ONLY while it is live. It was implemented on the module
 * side and never consumed here, so the hook was tested, registered and inert.
 *
 * Merged rather than replaced, key by key: a module adds measures and
 * dimensions it brought with it, and must not be able to overwrite a fact the
 * dataset itself asserts. Two modules cannot collide on the same key either --
 * the first one to claim it keeps it, and that is reported rather than silently
 * resolved.
 *
 * Never throws. A module that cannot produce a fragment degrades to the plain
 * dataset manifest, which is the same rule every other module hook follows: an
 * optional module may not break the thing it plugs into.
 */
async function getWithModules(schemaName) {
  const base = get(schemaName);
  if (!base) return null;

  let live = [];
  try {
    live = await require('../../modules/services/module.service').getLiveModules(schemaName);
  } catch (err) {
    console.error('[dataset-manifest] could not list live modules:', err.message);
    return base;
  }
  if (live.length === 0) return base;

  // Collected first, so a client with only app modules live -- which have no
  // fragment at all -- gets the base object back untouched. Building the merged
  // copy up front added empty `facts` and `vocabulary` keys that the dataset
  // never declared, which is a change to the manifest made by a module that
  // contributes nothing to it.
  const fragments = [];
  for (const { descriptor } of live) {
    let fragment = null;
    try {
      fragment = descriptor.hooks?.manifestFragment?.();
    } catch (err) {
      console.error(`[dataset-manifest] ${descriptor.id} manifestFragment threw:`, err.message);
      continue;
    }
    if (fragment) fragments.push([descriptor.id, fragment]);
  }
  if (fragments.length === 0) return base;

  const merged = {
    ...base,
    measures: { ...(base.measures || {}) },
    dimensions: { ...(base.dimensions || {}) },
    // What the live modules added, already phrased for the crew prompt. Kept
    // separate from `measures`/`dimensions` because renderForCrew must not
    // start rendering the dataset's own ones too -- that would change the
    // prompt for every dataset, module or not.
    moduleNotes: [],
  };
  if (base.vocabulary) merged.vocabulary = [...base.vocabulary];
  if (base.facts) merged.facts = [...base.facts];

  for (const [id, fragment] of fragments) {
    const descriptor = { id };

    for (const group of ['measures', 'dimensions']) {
      for (const [key, value] of Object.entries(fragment[group] || {})) {
        if (key in merged[group]) {
          console.warn(
            `[dataset-manifest] ${descriptor.id} tried to redefine ${group}.${key} on `
            + `${schemaName}; the dataset's own definition wins`);
          continue;
        }
        merged[group][key] = value;

        const detail = value.basis || value.detail || '';
        const status = value.fidelity || value.status || '';
        merged.moduleNotes.push(
          `- ${key}${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}`);
      }
    }
    if (Array.isArray(fragment.vocabulary)) {
      merged.vocabulary = [...(merged.vocabulary || []), ...fragment.vocabulary];
    }
    if (Array.isArray(fragment.facts)) {
      merged.facts = [...(merged.facts || []), ...fragment.facts];
    }
  }

  return merged;
}

module.exports = { get, getWithModules, ids, renderForPrompt, renderForCrew };
