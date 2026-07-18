/**
 * Builder V2 — per-conversation brain state.
 *
 * Wraps `context.service` so the engine can:
 *   1) load whatever the addons in this conversation have written so
 *      far (used to render `## Memory` and `## Thinking` blocks in
 *      subsequent turns), and
 *   2) merge in new writes after each addon runs.
 *
 * Storage shape (namespace `builder_memory`, conversation-scoped row
 * in `context_data`) — three parallel sections:
 *
 *   {
 *     "memory": {
 *       "_general":          { fieldA: 2, fieldB: "yes" },
 *       "<domain-name>":     { fieldC: "manager" },
 *       ...
 *     },
 *     "thinking": {
 *       "strategy":          { advice: "Focus on price objections" },
 *       ...
 *     },
 *     "summary": {
 *       "<summarizer-name>": { text: "...", watermark: 42, ranAt: 1234 },
 *       ...
 *     }
 *   }
 *
 * The three sections represent different brain functions:
 *   - Memory:   recalled facts (what we KNOW — extractors write here).
 *   - Thinking: current reasoning (what we PLAN — the Thinker writes here).
 *   - Summary:  compressed checkpoints (offline-lane Summarizers write here).
 *
 * `_general` is the no-domain bucket inside the memory/thinking sections.
 * The summary section is FLAT: each summarizer writes a single object
 * keyed by its configured name; there's no domain layer because a
 * summarizer's output is conceptually one slot.
 *
 * Backward compat: a previously-stored blob WITHOUT any section keys
 * is treated as legacy memory only. Blobs from the old triggered era
 * carrying a `triggered` key are read tolerantly — the key is just
 * dropped on the next normalize pass.
 */

const contextService = require('../../services/context.service');

const NAMESPACE = 'builder_memory';
const GENERAL_KEY = '_general';
const SECTION_MEMORY = 'memory';
const SECTION_THINKING = 'thinking';
const SECTION_SUMMARY = 'summary';
/** Retrieval = KB Retriever output slots. Flat `{ [name]: string }`,
 *  EPHEMERAL — recomputed (replaced/cleared) every turn the retriever
 *  runs, never accumulated. Read by the `{{kb-retrieve:NAME}}` token.
 *  See docs/guides/KB_V2_RETRIEVER.md. */
const SECTION_RETRIEVAL = 'retrieval';
/** Panels = Live Brain panel outputs. Flat `{ [panelId]: entry }` where
 *  each entry is `{ render, text?|values?, ranAt }`. Rolling-replace per
 *  panel; a slot is CLEARED (so the panel hides) when a run produces an
 *  invalid/empty result. Read by the customer Live Brain surface and the
 *  builder's brain run inspector. Live-Brain panels are the ONLY writers.
 *  See docs/guides/BUILDER_V2_LIVE_BRAIN.md. */
const SECTION_PANELS = 'panels';
/** Sections that follow the `{ [domain]: { [field]: value } }` shape.
 *  Summary breaks the pattern — its writes are flat `{ [name]: entry }` —
 *  so it has its own write path and is NOT in this list. */
const DOMAIN_SECTIONS = [SECTION_MEMORY, SECTION_THINKING];
const SECTIONS = [SECTION_MEMORY, SECTION_THINKING, SECTION_SUMMARY, SECTION_RETRIEVAL];

function domainKey(domain) {
  return domain && String(domain).trim() ? String(domain) : GENERAL_KEY;
}

function sectionKey(kind) {
  if (kind === SECTION_THINKING) return SECTION_THINKING;
  if (kind === SECTION_SUMMARY)  return SECTION_SUMMARY;
  return SECTION_MEMORY;
}

/**
 * Normalize a raw stored blob (possibly legacy-shaped) into the
 * { memory, thinking, summary, runCounts } shape every other helper
 * expects. Old blobs with a `triggered` key are read tolerantly (just
 * dropped) — the triggered section is gone since Dynamic Context
 * replaced the Triggered Context addon.
 *
 * `runCounts` is a top-level sibling of the memory sections — a flat
 * `{ [instanceId]: number }` map populated by `addonRunner` on every
 * successful run, used by the `AddonFilter.cap` gate to limit how
 * many times an addon may run per conversation. Lives outside the
 * three semantic sections because it's runtime bookkeeping, not
 * authored content.
 */
function normalizeBlob(raw) {
  const empty = () => ({
    [SECTION_MEMORY]:    {},
    [SECTION_THINKING]:  {},
    [SECTION_SUMMARY]:   {},
    [SECTION_RETRIEVAL]: {},
    [SECTION_PANELS]:    {},
    runCounts:           {},
  });
  if (!raw || typeof raw !== 'object') return empty();
  if (Object.prototype.hasOwnProperty.call(raw, SECTION_MEMORY) ||
      Object.prototype.hasOwnProperty.call(raw, SECTION_THINKING) ||
      Object.prototype.hasOwnProperty.call(raw, SECTION_SUMMARY) ||
      Object.prototype.hasOwnProperty.call(raw, SECTION_RETRIEVAL) ||
      Object.prototype.hasOwnProperty.call(raw, SECTION_PANELS)) {
    return {
      [SECTION_MEMORY]:    raw[SECTION_MEMORY]    && typeof raw[SECTION_MEMORY]    === 'object' ? raw[SECTION_MEMORY]    : {},
      [SECTION_THINKING]:  raw[SECTION_THINKING]  && typeof raw[SECTION_THINKING]  === 'object' ? raw[SECTION_THINKING]  : {},
      [SECTION_SUMMARY]:   raw[SECTION_SUMMARY]   && typeof raw[SECTION_SUMMARY]   === 'object' ? raw[SECTION_SUMMARY]   : {},
      [SECTION_RETRIEVAL]: raw[SECTION_RETRIEVAL] && typeof raw[SECTION_RETRIEVAL] === 'object' ? raw[SECTION_RETRIEVAL] : {},
      [SECTION_PANELS]:    raw[SECTION_PANELS]    && typeof raw[SECTION_PANELS]    === 'object' ? raw[SECTION_PANELS]    : {},
      runCounts:           raw.runCounts && typeof raw.runCounts === 'object' ? raw.runCounts : {},
    };
  }
  // Legacy shape: domains at the root → treat as memory only.
  return { ...empty(), [SECTION_MEMORY]: raw };
}

/**
 * Load the conversation's brain blob in the canonical shape. Returns
 * `{ memory: {}, thinking: {} }` when nothing is stored yet.
 */
async function loadMemory(userId, conversationId) {
  if (!userId || !conversationId) {
    return { [SECTION_MEMORY]: {}, [SECTION_THINKING]: {} };
  }
  const raw = await contextService.getContext(userId, NAMESPACE, conversationId);
  return normalizeBlob(raw);
}

/**
 * Persist a brain blob (replaces the row). Always writes in the
 * canonical shape — even if the caller hands us a partial blob, we
 * normalize first.
 */
async function saveMemory(userId, conversationId, blob) {
  if (!userId || !conversationId) return;
  await contextService.saveContext(userId, NAMESPACE, normalizeBlob(blob), conversationId);
}

/**
 * Merge a list of writes into the brain blob, in place. Returns the
 * same blob ref so callers can chain. Each write specifies which
 * section it goes into via `kind`:
 *
 *   - 'memory'   (default) — facts the brain remembers
 *   - 'thinking' — the brain's current plan
 *   - 'summary'  — a Summarizer's checkpoint slot
 *
 * Routing is per-write so a single addon could theoretically write
 * to several sections in one turn. In practice, Field/Vibe Extractors
 * emit 'memory' writes, Thinker emits 'thinking' writes, Summarizer
 * emits 'summary' writes.
 *
 * Memory / Thinking entries follow `{ kind, domain, field, value }`.
 * Summary entries follow `{ kind: 'summary', name, entry }` — a flat
 * slot per summarizer name, no domain layer. The `entry` is the
 * `SummaryEntry` object (text + watermark + ranAt).
 *
 * A memory/thinking write entry can also be a *domain replace marker*
 * — shape `{ kind, domain, replace: true }` (no `field`/`value`). When
 * the applier sees one, it wipes that (section, domain) bucket before
 * proceeding. Use it to express rolling-replace semantics: a Thinker
 * that emitted `{atr1: x}` last turn and `{atr2: y}` this turn should
 * end up with ONLY `{atr2: y}` — not the field-by-field merge that's
 * appropriate for additive Extractor writes. The marker is processed
 * in order: emit it BEFORE the value writes for the same domain in
 * the same array.
 *
 * Summary writes are always rolling-replace by construction (each
 * write replaces the whole `summary[name]` slot), so they don't need
 * the replace marker dance.
 *
 * @param {Object} blob       — the loaded brain shape (must already
 *                              be normalized — call normalizeBlob first
 *                              if you're unsure)
 * @param {Array} writes
 */
function applyWrites(blob, writes) {
  for (const w of writes) {
    // Retrieval: flat, ephemeral slots keyed by name (KB Retriever).
    //   { kind:'retrieval', name, value }       → set slot
    //   { kind:'retrieval', name, clear:true }  → drop slot
    if (w.kind === 'retrieval') {
      if (!blob[SECTION_RETRIEVAL]) blob[SECTION_RETRIEVAL] = {};
      if (!w.name) continue;
      if (w.clear === true) { delete blob[SECTION_RETRIEVAL][w.name]; continue; }
      if (w.value === null || w.value === undefined) continue;
      blob[SECTION_RETRIEVAL][w.name] = w.value;
      continue;
    }

    // Panels: flat, rolling-replace slots keyed by panel id (Live Brain).
    //   { kind:'panel', panelId, entry }      → set slot (replace)
    //   { kind:'panel', panelId, clear:true } → drop slot (panel hides)
    if (w.kind === 'panel') {
      if (!blob[SECTION_PANELS]) blob[SECTION_PANELS] = {};
      if (!w.panelId) continue;
      if (w.clear === true) { delete blob[SECTION_PANELS][w.panelId]; continue; }
      if (!w.entry || typeof w.entry !== 'object') continue;
      blob[SECTION_PANELS][w.panelId] = w.entry;
      continue;
    }

    const sec = sectionKey(w.kind);
    if (!blob[sec]) blob[sec] = {};

    // Summary writes don't use the (domain, field) layout — they're
    // flat slots keyed by summarizer name. Branched out so the
    // memory/thinking path stays single-purpose and easy to read.
    if (sec === SECTION_SUMMARY) {
      if (!w.name) continue;
      const entry = w.entry;
      if (!entry || typeof entry !== 'object') continue;
      blob[sec][w.name] = {
        text:      typeof entry.text === 'string' ? entry.text : '',
        watermark: Number.isFinite(entry.watermark) ? Number(entry.watermark) : 0,
        ranAt:     Number.isFinite(entry.ranAt) ? Number(entry.ranAt) : Date.now(),
      };
      continue;
    }

    // Memory / thinking — domain-keyed write or domain-replace marker.
    const dk = domainKey(w.domain);
    if (w.replace === true) {
      blob[sec][dk] = {};
      continue;
    }
    if (w.value === null || w.value === undefined) continue;
    if (!blob[sec][dk]) blob[sec][dk] = {};
    blob[sec][dk][w.field] = w.value;
  }
  return blob;
}

/** Read a KB Retriever slot by name. Returns undefined when nothing was
 *  written (caller / token resolver supplies the empty sentinel). */
function getRetrieval(blob, name) {
  const sec = blob?.[SECTION_RETRIEVAL];
  if (!sec || typeof name !== 'string' || !name) return undefined;
  return sec[name];
}

/** Read a Live Brain panel's stored entry by panel id. Returns undefined
 *  when the panel has no valid value (never ran, or last run was hidden). */
function getPanel(blob, panelId) {
  const sec = blob?.[SECTION_PANELS];
  if (!sec || typeof panelId !== 'string' || !panelId) return undefined;
  return sec[panelId];
}

/** The whole panels section — `{ [panelId]: entry }`. Empty object when
 *  nothing has been written. */
function listPanels(blob) {
  return (blob && blob[SECTION_PANELS]) || {};
}

/** Read a summary entry by name. Returns undefined when the slot is
 *  missing — caller decides on fallback (the `since_summarizer` history
 *  resolver falls back to `all`, for example). */
function getSummary(blob, name) {
  const sec = blob?.[SECTION_SUMMARY];
  if (!sec || typeof name !== 'string' || !name) return undefined;
  return sec[name];
}

/** Names of every summarizer that has at least one stored entry.
 *  Used by the brain runtime viewer. */
function listSummarizerNames(blob) {
  const sec = blob?.[SECTION_SUMMARY];
  if (!sec) return [];
  return Object.keys(sec).filter(k => sec[k]).sort();
}

/**
 * Lookup a field value across all domains in a given section. First
 * non-null hit wins. Used to populate `## Already collected` for an
 * extractor whose fields may or may not have a configured domain —
 * we don't ask the caller to know which bucket the field lives in.
 *
 * Section defaults to 'memory' — extractors read facts, not thoughts.
 */
function findFieldValue(blob, fieldName, section = SECTION_MEMORY) {
  const sec = blob?.[sectionKey(section)];
  if (!sec) return undefined;
  for (const domain of Object.keys(sec)) {
    const bucket = sec[domain];
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, fieldName)) {
      const v = bucket[fieldName];
      if (v !== null && v !== undefined) return v;
    }
  }
  return undefined;
}

/**
 * Get the value map for one domain inside a given section.
 * `null` domain resolves to `_general`. Returns {} when empty.
 */
function valuesForDomain(blob, domain, section = SECTION_MEMORY) {
  const sec = blob?.[sectionKey(section)];
  if (!sec) return {};
  const k = domainKey(domain);
  return sec[k] || {};
}

/**
 * List the names of every domain in a section that holds at least one
 * value. Used by the prompt assembler when rendering `{{memory}}` /
 * `{{thinking}}` — they enumerate domains with content rather than
 * relying on a structured per-addon list. The `_general` storage key
 * is mapped back to `null` (the API convention for "no domain").
 *
 * Returns an empty array when the section has no values at all.
 */
function listDomainsWithValues(blob, section = SECTION_MEMORY) {
  const sec = blob?.[sectionKey(section)];
  if (!sec) return [];
  const out = [];
  for (const key of Object.keys(sec)) {
    const bucket = sec[key];
    if (!bucket || Object.keys(bucket).length === 0) continue;
    out.push(key === '_general' ? null : key);
  }
  return out;
}

/**
 * Remove every occurrence of a field across all domains in a section,
 * in place. Returns true if anything was removed.
 */
function clearField(blob, fieldName, section = SECTION_MEMORY) {
  const sec = blob?.[sectionKey(section)];
  if (!sec) return false;
  let removed = false;
  for (const k of Object.keys(sec)) {
    const bucket = sec[k];
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, fieldName)) {
      delete bucket[fieldName];
      removed = true;
      // Drop empty buckets so the JSON stays tidy.
      if (Object.keys(bucket).length === 0) delete sec[k];
    }
  }
  return removed;
}

/**
 * Set a field's value in the given section, in place. Clears the
 * same field from any OTHER domains in the same section so it can't
 * end up duplicated when re-tagged. Other sections are untouched.
 */
function setField(blob, fieldName, value, domain, section = SECTION_MEMORY) {
  const sec = sectionKey(section);
  if (!blob[sec]) blob[sec] = {};
  clearField(blob, fieldName, sec);
  const k = domainKey(domain);
  if (!blob[sec][k]) blob[sec][k] = {};
  blob[sec][k][fieldName] = value;
  return blob;
}

module.exports = {
  loadMemory,
  saveMemory,
  applyWrites,
  findFieldValue,
  valuesForDomain,
  listDomainsWithValues,
  clearField,
  setField,
  normalizeBlob,
  getSummary,
  listSummarizerNames,
  getRetrieval,
  getPanel,
  listPanels,
  NAMESPACE,
  GENERAL_KEY,
  SECTION_MEMORY,
  SECTION_THINKING,
  SECTION_SUMMARY,
  SECTION_RETRIEVAL,
  SECTION_PANELS,
  DOMAIN_SECTIONS,
  SECTIONS,
};
