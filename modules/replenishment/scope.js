/**
 * Smart Replenishment — scope resolution over computed recommendation rows.
 *
 * THE PROTOCOL THIS FILE IMPLEMENTS: every replenishment question decomposes
 * into SCOPE × ARITHMETIC. Scope ("which rows — a department, a brand, items
 * whose name contains עץ, a pasted list") is a language problem and belongs to
 * the model, which can resolve ANY vocabulary against the catalogue and reduce
 * it to the parameters here. Arithmetic ("how much, when, what cost") belongs
 * to the engine, exclusively. Refusal is never a legitimate response to
 * vocabulary — only to scope that genuinely matches nothing, and even then the
 * answer names what was searched.
 *
 * `skus` is the universal bridge: any vocabulary the data chat can resolve
 * reduces to a SKU list, so this surface never needs a new parameter per
 * vocabulary. (The live incident this closes: a buyer asked for a purchase
 * recommendation for "מחלקת יצירה - מוצרי עץ", then for items with עץ in the
 * name, and was refused twice — while the base view carried the name and
 * category of every row all along.)
 *
 * Pure and dependency-free so the OFFLINE battery exercises every filter
 * without a database — the same reason engine.js is pure.
 *
 * Filters compose with AND. Matching is case-insensitive and trimmed;
 * category/subcategory are exact labels AS DELIVERED in the client's feed
 * (which on zolstock differ from their Qlik mapping — the manifest documents
 * it, and answers must say "labels as delivered" when they resolve through
 * them).
 */

/** Server-side ceiling for a pasted/resolved SKU list. Above it the caller
 *  should narrow the scope rather than page through an answer nobody reads. */
const MAX_SCOPE_SKUS = 500;

const norm = (v) => String(v ?? '').trim().toLowerCase();

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * NAME matching is word-start, not substring. A bare Hebrew stem inside
 * another word is how "מטרי" (umbrella-) swept geometric planters into an
 * umbrella move — גיאו·מטרי matched. A term now matches a name only where a
 * word begins with it ("מטרי" → "מטריה", "מטריות"; never "גיאומטרי").
 * Codes stay substring — a code is one token and buyers paste fragments.
 */
const nameWordMatcher = (term) => new RegExp(`(^|[^\\p{L}\\p{N}])${reEscape(term)}`, 'u');

/** Which of the scope parameters are present on an opts object. */
function scopeParams(opts = {}) {
  const out = {};
  if (Array.isArray(opts.skus) && opts.skus.length) out.skus = opts.skus;
  if (opts.category) out.category = opts.category;
  if (opts.subcategory) out.subcategory = opts.subcategory;
  if (String(opts.search ?? '').trim()) out.search = String(opts.search).trim();
  return out;
}

function hasScope(opts = {}) {
  return Object.keys(scopeParams(opts)).length > 0;
}

/**
 * Apply the scope filters to a list of computed recommendation rows.
 * Rows are engine output (itemName / sku / itemNumber / category / subcategory).
 */
function applyScope(list, opts = {}) {
  let out = list;

  if (Array.isArray(opts.skus) && opts.skus.length) {
    const set = new Set(opts.skus.map(norm).filter(Boolean));
    out = out.filter(r => set.has(norm(r.sku)));
  }
  if (opts.category) {
    const want = norm(opts.category);
    out = out.filter(r => norm(r.category) === want);
  }
  if (opts.subcategory) {
    const want = norm(opts.subcategory);
    out = out.filter(r => norm(r.subcategory) === want);
  }
  const term = norm(opts.search);
  if (term) {
    const nameRe = nameWordMatcher(term);
    out = out.filter(r =>
      nameRe.test(norm(r.itemName))
      || norm(r.sku).includes(term)
      || norm(r.itemNumber).includes(term));
  }
  return out;
}

/**
 * The scope stated in words — what the buyer was actually answered about.
 * Goes into the data contract so the talker can rephrase it but not drop it.
 */
/** First-strong isolate: a Hebrew term inside this English sentence renders
 *  in its own direction instead of scrambling the words around it. */
const iso = (s) => `⁨${s}⁩`;

function describeScope(opts = {}, matched, ofTotal) {
  const parts = [];
  if (Array.isArray(opts.skus) && opts.skus.length) parts.push(`a provided list of ${opts.skus.length} SKUs`);
  if (opts.category) parts.push(`category "${iso(opts.category)}" (label as delivered in the feed)`);
  if (opts.subcategory) parts.push(`subcategory "${iso(opts.subcategory)}" (label as delivered)`);
  if (String(opts.search ?? '').trim()) {
    parts.push(`items with a name word starting "${iso(String(opts.search).trim())}", or that text in the item code`);
  }
  if (!parts.length) return null;
  return `Scope: ${parts.join(', ')} — ${matched.toLocaleString('en-GB')} of ${ofTotal.toLocaleString('en-GB')} items.`;
}

module.exports = { MAX_SCOPE_SKUS, scopeParams, hasScope, applyScope, describeScope };
