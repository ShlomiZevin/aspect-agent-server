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
    out = out.filter(r =>
      norm(r.itemName).includes(term)
      || norm(r.sku).includes(term)
      || norm(r.itemNumber).includes(term));
  }
  return out;
}

/**
 * The scope stated in words — what the buyer was actually answered about.
 * Goes into the data contract so the talker can rephrase it but not drop it.
 */
function describeScope(opts = {}, matched, ofTotal) {
  const parts = [];
  if (Array.isArray(opts.skus) && opts.skus.length) parts.push(`a provided list of ${opts.skus.length} SKUs`);
  if (opts.category) parts.push(`category "${opts.category}" (label as delivered in the feed)`);
  if (opts.subcategory) parts.push(`subcategory "${opts.subcategory}" (label as delivered)`);
  if (String(opts.search ?? '').trim()) parts.push(`items whose name or code contains "${String(opts.search).trim()}"`);
  if (!parts.length) return null;
  return `Scope: ${parts.join(', ')} — ${matched.toLocaleString('en-GB')} of ${ofTotal.toLocaleString('en-GB')} items.`;
}

module.exports = { MAX_SCOPE_SKUS, scopeParams, hasScope, applyScope, describeScope };
