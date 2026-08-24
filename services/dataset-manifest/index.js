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
  L.push('- NEVER arithmetically combine a number the user quoted with a number from the data (no adding, subtracting or averaging them). Either verify the user\'s number from the data, or state it cannot be verified from this dataset.');
  if (manifest.vatRate) {
    const pct = Math.round((manifest.vatRate - 1) * 100);
    L.push(`- VAT is ${pct}% (factor ${manifest.vatRate}). When the user quotes a figure, establish its VAT basis before comparing: a figure described as including VAT is compared to inc-VAT values, excluding to ex-VAT. If the basis is unknown, show the comparison on BOTH bases and say so.`);
  }
  const ambiguous = (manifest.vocabulary || []).filter(v => v.resolution === 'ambiguous');
  for (const v of ambiguous) {
    L.push(`- ONLY the exact phrase${v.terms.length > 1 ? 's' : ''} "${v.terms.join('" / "')}" ${v.terms.length > 1 ? 'are' : 'is'} AMBIGUOUS: ${v.detail} For these exact words ask ONE short clarifying question before fetching data. Do NOT extend this to other wordings — a question that names salespeople unambiguously (e.g. מוכרנים, סוכנים, salespeople) is NOT ambiguous: state directly that the dimension is absent and offer the available alternatives, without asking anything.`);
  }
  return L.join('\n');
}

module.exports = { get, ids, renderForPrompt, renderForCrew };
