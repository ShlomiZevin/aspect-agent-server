/**
 * Smart Replenishment — engine battery (B2).
 *
 * Offline: no DB, no LLM, no network, no clock — `today` is passed in, so
 * every case is deterministic and will still pass in a year.
 *
 * Section 3 covers the EIGHT named edge cases from the ZolStock plan's Step 4
 * verbatim. Each of them came from something real in this data, and each is
 * asserted by name so a regression says which one broke.
 *
 * Run: node scripts/test-replenishment-unit.js
 */

const {
  STATUS, computeRecommendation, computeRecommendations, summarize, pickWindow,
} = require('../modules/replenishment/engine');

let pass = 0, fail = 0;

/**
 * Notes are asserted by CODE, not by matching their English.
 *
 * These checks used to read `notes.some(n => /idle stock/i.test(n))`, which is
 * wrong in both directions: it fails when somebody improves the wording, and it
 * passes when the sentence is correct English about the wrong thing. The code
 * is the claim; the words are one rendering of it, and there are two.
 */
const note = (r, code) => (r.notes || []).find(n => n.code === code);
const has = (r, code) => Boolean(note(r, code));
const codes = r => JSON.stringify((r.notes || []).map(n => n.code));
const rounding = r => r.orderQtyRounding?.code;
function ok(label, cond, detail) {
  if (cond) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const TODAY = '2026-08-26';
const THROUGH = '2026-08-25';

/** A well-behaved item: 60/day, plenty of history, everything populated. */
function baseRow(over = {}) {
  return {
    sku: 'BH-34-240',
    item_number: '1001',
    item_name: 'כוסות נייר 250 מ״ל',
    category: 'חד פעמי',
    supplier: 'ב.א. זול סטוק והפצה בע"מ',
    supplier_code: 'BA1',
    units_per_carton: 24,
    safety_stock_data: null,
    consumer_price: 4.2,
    cost_ex_vat: 3.1,
    warehouse_qty: 2300,
    store_qty_total: 500,
    on_order_qty: 1000,
    on_order_line_count: 1,
    on_order_last_date: '2026-07-14',
    committed_qty: 100,
    qty_sold_28d: 1680,
    qty_sold_90d: 5400,     // 60/day over 90 days
    qty_sold_365d: 21900,
    first_sold: '2025-01-05',
    last_sold: '2026-08-25',
    data_through: THROUGH,
    ...over,
  };
}

function settings(over = {}) {
  return {
    leadTimeDays: 90, leadTimeSource: 'supplier', reviewDays: 30, safetyDays: 14,
    velocityWindowDays: 90, includeStoreStock: false, horizonDays: 14,
    minOrderUnits: 0, cartonRounding: true, ...over,
  };
}

const ctx = { today: TODAY, stockSource: 'warehouse' };

console.log('\n1 · The formula, on a well-behaved item');
{
  const r = computeRecommendation(baseRow(), settings(), ctx);
  ok('velocity is qty in window / window days', near(r.velocityDaily, 60), r.velocityDaily);
  ok('on hand excludes store stock by default', r.onHand === 2300, r.onHand);
  ok('net available = on hand + on order − committed',
    r.netAvailable === 2300 + 1000 - 100, r.netAvailable);
  ok('safety stock = velocity × safety days when the catalogue has none',
    r.safetyStock === Math.ceil(60 * 14), r.safetyStock);
  ok('safety stock is marked computed, not configured',
    r.safetyStockSource === 'computed', r.safetyStockSource);
  ok('reorder point = velocity × lead time + safety',
    near(r.reorderPoint, 60 * 90 + 840), r.reorderPoint);
  ok('days of cover = net available / velocity', near(r.daysOfCover, 3200 / 60), r.daysOfCover);
  ok('target = velocity × (lead + review) + safety',
    near(r.targetStock, 60 * 120 + 840), r.targetStock);
  ok('raw qty = target − available', near(r.rawQty, 60 * 120 + 840 - 3200), r.rawQty);
  ok('order qty is rounded UP to a full carton',
    r.orderQty % 24 === 0 && r.orderQty >= r.rawQty, `${r.orderQty} (raw ${r.rawQty})`);
  ok('…and states the rounding it applied',
    rounding(r) === 'cartons' && r.orderQtyRounding.params.carton === 24, JSON.stringify(r.orderQtyRounding));
  ok('estimated cost = qty × unit cost', near(r.estimatedCostExVat, r.orderQty * 3.1), r.estimatedCostExVat);
  ok('the order-by date is derived from the DATA date, not today',
    r.orderByDate === '2026-07-19', r.orderByDate);
  ok('it is overdue, and by how much', r.status === STATUS.OVERDUE && r.daysLate === 38,
    `${r.status} ${r.daysLate}`);
  ok('every row carries its data-through date', r.dataThrough === THROUGH, r.dataThrough);
}

console.log('\n2 · today and the stock source are parameters, never assumptions');
{
  const early = computeRecommendation(baseRow(), settings(), { ...ctx, today: '2026-07-01' });
  ok('a different `today` moves the status, not the arithmetic',
    early.status !== STATUS.OVERDUE && near(early.velocityDaily, 60), early.status);
  ok('…and the order-by date is unchanged (it is anchored to the data)',
    early.orderByDate === '2026-07-19', early.orderByDate);
}
{
  const withStore = computeRecommendation(baseRow(), settings({ includeStoreStock: true }), ctx);
  ok('includeStoreStock adds store stock into availability',
    withStore.onHand === 2800, withStore.onHand);
  const storeOnly = computeRecommendation(baseRow(), settings(), { ...ctx, stockSource: 'store' });
  ok('stockSource "store" uses store stock alone — a new caller, not a new engine',
    storeOnly.onHand === 500, storeOnly.onHand);
}
{
  let threw = false;
  try { computeRecommendation(baseRow(), settings(), { stockSource: 'warehouse' }); }
  catch { threw = true; }
  ok('omitting `today` throws rather than silently reading a clock', threw);
}

console.log('\n3 · The eight named edge cases (ZS-4)');

{
  // 1 — zero velocity, stock on hand ⇒ no_demand, qty 0, flagged as dead stock
  const r = computeRecommendation(
    baseRow({ qty_sold_28d: 0, qty_sold_90d: 0, qty_sold_365d: 0, last_sold: null, first_sold: null }),
    settings(), ctx);
  ok('[1] zero velocity with stock ⇒ no_demand', r.status === STATUS.NO_DEMAND, r.status);
  ok('[1] …order quantity is zero', r.orderQty === 0, r.orderQty);
  ok('[1] …and it is called idle stock in words',
    has(r, 'idle_stock'), codes(r));
}
{
  // 2 — zero velocity, zero stock ⇒ not on the list at all
  const r = computeRecommendation(
    baseRow({ qty_sold_28d: 0, qty_sold_90d: 0, qty_sold_365d: 0, last_sold: null, first_sold: null,
              warehouse_qty: 0, store_qty_total: 0, on_order_qty: 0 }),
    settings(), ctx);
  ok('[2] zero velocity and zero stock ⇒ excluded entirely', r === null, JSON.stringify(r));
}
{
  // 3 — negative availability is REPORTED, never clamped
  const r = computeRecommendation(baseRow({ warehouse_qty: -500, on_order_qty: 0, committed_qty: 100 }),
    settings(), ctx);
  ok('[3] negative net available is not clamped to zero', r.netAvailable === -600, r.netAvailable);
  ok('[3] …and it is explained rather than hidden',
    has(r, 'negative_available'), codes(r));
  ok('[3] …the item is still ordered for', r.orderQty > 0, r.orderQty);
  // TIME, unlike quantity, is clamped. Dividing a negative position by a
  // slow item produced "stock covers -5,400 days, order should have gone out
  // on 2011-08-15" on the real screen — implied by the formula, useless as a
  // statement, and impossible to act on.
  ok('[3] …but days of cover is 0, never negative', r.daysOfCover === 0, r.daysOfCover);
  ok('[3] …the order-by date is one lead time ago, not a decade',
    r.orderByDate === '2026-05-27', r.orderByDate);
  ok('[3] …lateness is on the order of the lead time', r.daysLate === 91, r.daysLate);
  ok('[3] …and the row says it is already out, in words',
    r.alreadyOut === true && has(r, 'already_out'),
    JSON.stringify(r.notes));
}
{
  // 4 — no carton size ⇒ no rounding, and say so
  const r = computeRecommendation(baseRow({ units_per_carton: null }), settings(), ctx);
  ok('[4] no carton size ⇒ quantity is a whole number, unrounded',
    Number.isInteger(r.orderQty) && r.orderQty === Math.ceil(r.rawQty), `${r.orderQty} vs ${r.rawQty}`);
  ok('[4] …rounding is reported as unknown', rounding(r) === 'carton_unknown', JSON.stringify(r.orderQtyRounding));
  ok('[4] …and a note says so in words',
    has(r, 'carton_unknown'), codes(r));
  const zero = computeRecommendation(baseRow({ units_per_carton: 0 }), settings(), ctx);
  ok('[4] a carton size of 0 behaves the same as absent',
    rounding(zero) === 'carton_unknown', JSON.stringify(zero.orderQtyRounding));
}
{
  // 5 — a code that is not in the catalogue
  const r = computeRecommendation(
    baseRow({ item_number: null, item_name: null, supplier: null, cost_ex_vat: null }),
    settings(), ctx);
  ok('[5] an unmatched code is still included (the stock is real)', r !== null);
  ok('[5] …and flagged as unmatched', r.unmatched === true, String(r.unmatched));
  ok('[5] …with a note that it cannot be identified',
    has(r, 'unmatched_code'), codes(r));
  ok('[5] …and no invented cost', r.estimatedCostExVat === null, String(r.estimatedCostExVat));
}
{
  // 6 — a new item: first sale INSIDE the window
  const r = computeRecommendation(
    baseRow({ first_sold: '2026-08-06', last_sold: '2026-08-25', qty_sold_90d: 400 }),
    settings(), ctx);
  ok('[6] velocity uses days since first sale, not the full window',
    near(r.velocityDaily, 400 / 20), r.velocityDaily);
  ok('[6] …the basis says so',
    r.velocityBasis.code === 'since_first_sale' && r.velocityBasis.params.days === 20,
    JSON.stringify(r.velocityBasis));
  ok('[6] …and thin history is flagged', r.thinHistory === true, String(r.thinHistory));
  ok('[6] …in words too', has(r, 'thin_history'), codes(r));
}
{
  // 7 — sold within 365d but nothing recent ⇒ dormant, not slow
  const r = computeRecommendation(
    baseRow({ qty_sold_28d: 0, qty_sold_90d: 0, qty_sold_365d: 9000, last_sold: '2026-02-01' }),
    settings(), ctx);
  ok('[7] stale demand ⇒ no_demand even with a non-zero 365-day figure',
    r.status === STATUS.NO_DEMAND, r.status);
  ok('[7] …velocity is zero, not a 365-day average', r.velocityDaily === 0, r.velocityDaily);
  ok('[7] …and the note names the last sale date',
    note(r, 'stale_demand')?.params.lastSold === '2026-02-01', codes(r));
}
{
  // 8 — an inherited lead time must always be visible
  const inherited = computeRecommendation(baseRow(), settings({ leadTimeSource: 'dataset_default' }), ctx);
  ok('[8] an inherited lead time keeps its source', inherited.leadTimeSource === 'dataset_default',
    inherited.leadTimeSource);
  ok('[8] …and is stated in words, every time',
    has(inherited, 'lead_time_default'), codes(inherited));
  const own = computeRecommendation(baseRow(), settings({ leadTimeSource: 'supplier' }), ctx);
  ok('[8] a supplier-set lead time is NOT nagged about',
    !has(own, 'lead_time_default'), codes(own));
}

console.log('\n4 · Sources and caveats travel with the row');
{
  const r = computeRecommendation(baseRow({ safety_stock_data: 1200 }), settings(), ctx);
  ok('a catalogue safety stock is used as-is', r.safetyStock === 1200, r.safetyStock);
  ok('…and marked configured', r.safetyStockSource === 'configured', r.safetyStockSource);
  ok('…with no "no safety stock is set" note',
    !has(r, 'safety_from_pace'), codes(r));
}
{
  const r = computeRecommendation(baseRow(), settings(), ctx);
  ok('the unverified on-order caveat is present', r.onOrderIsUnverified === true);
  ok('…and worded for a human',
    has(r, 'on_order_unverified'), codes(r));
  ok('the last order date is carried', r.onOrderLastDate === '2026-07-14', r.onOrderLastDate);
}
{
  const r = computeRecommendation(baseRow({ on_order_qty: 0, on_order_line_count: 0, on_order_last_date: null }),
    settings(), ctx);
  ok('nothing on order ⇒ no unverified-supply caveat',
    !has(r, 'on_order_unverified'), codes(r));
}

console.log('\n5 · Minimum order quantity and window selection');
{
  const r = computeRecommendation(baseRow(), settings({ minOrderUnits: 100000 }), ctx);
  ok('a minimum order raises the quantity', r.orderQty === 100000, r.orderQty);
  ok('…and says why', rounding(r) === 'min_order', JSON.stringify(r.orderQtyRounding));
  const none = computeRecommendation(
    baseRow({ warehouse_qty: 999999 }), settings({ minOrderUnits: 500 }), ctx);
  ok('a minimum order does NOT force an order that is not needed',
    none.orderQty === 0, none.orderQty);
}
{
  ok('an exact window is used directly', pickWindow(90).column === 'qty_sold_90d');
  const w = pickWindow(60);
  ok('an unavailable window falls back to the nearest prepared one',
    w.column === 'qty_sold_90d' && w.exact === false, JSON.stringify(w));
  const r = computeRecommendation(baseRow(), settings({ velocityWindowDays: 60 }), ctx);
  ok('…and the row admits which window it really used',
    r.velocityBasis.code === 'window_average' && r.velocityBasis.params.days === 90 &&
    has(r, 'window_substituted'), JSON.stringify(r.velocityBasis));
}

console.log('\n6 · Lists: ordering and summary');
{
  const rows = [
    baseRow({ sku: 'A', warehouse_qty: 2300 }),                                    // overdue
    baseRow({ sku: 'B', warehouse_qty: 8000 }),                                    // later
    baseRow({ sku: 'C', warehouse_qty: 100000 }),                                  // ok
    baseRow({ sku: 'D', qty_sold_28d: 0, qty_sold_90d: 0, qty_sold_365d: 0,
              last_sold: null, first_sold: null, warehouse_qty: 50 }),             // no demand
    baseRow({ sku: 'E', qty_sold_28d: 0, qty_sold_90d: 0, qty_sold_365d: 0,
              last_sold: null, first_sold: null,
              warehouse_qty: 0, store_qty_total: 0, on_order_qty: 0 }),            // dropped
  ];
  const list = computeRecommendations(rows, settings(), ctx);
  ok('rows with no demand and no stock are dropped from the list',
    list.length === 4 && !list.some(r => r.sku === 'E'), list.map(r => r.sku).join(','));
  ok('most urgent first, dormant last',
    list[0].status === STATUS.OVERDUE && list[list.length - 1].status === STATUS.NO_DEMAND,
    list.map(r => `${r.sku}:${r.status}`).join(' '));

  const s = summarize(list);
  ok('the summary counts every row exactly once',
    s.orderNow + s.dueSoon + s.ok + s.noDemand === list.length,
    JSON.stringify(s));
  ok('the estimated total is the sum of the rows, not a separate query',
    near(s.estimatedTotalExVat, list.reduce((t, r) => t + (r.estimatedCostExVat || 0), 0)),
    String(s.estimatedTotalExVat));
}

console.log('\n7 · Determinism — the reason this is a function and not a prompt');
{
  const a = computeRecommendation(baseRow(), settings(), ctx);
  const b = computeRecommendation(baseRow(), settings(), ctx);
  ok('the same inputs produce byte-identical output', JSON.stringify(a) === JSON.stringify(b));
}


// ---------------------------------------------------------------------------
// Every sentence this module can say, in both languages.
//
// The caveats are the most important text on the page - they are what makes a
// number checkable rather than merely printed. They shipped English-only, so a
// Hebrew buyer read them reversed by RTL into nonsense, under a Hebrew heading.
//
// Nothing could have caught that: the old checks matched English regexes, so
// English was the only thing they could see. These walk the ENGINE's own codes
// and demand that each one renders, in each language, into something that is
// not empty, not the code leaking through, and not identical across languages
// unless it has no words in it.
// ---------------------------------------------------------------------------
console.log('\n11 · Every note renders in both languages');
{
  const fs = require('fs');
  const path = require('path');
  const catalogue = require('../modules/replenishment/notes');

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'replenishment', 'engine.js'), 'utf8');

  // What the engine can actually emit, read from the engine rather than from a
  // list kept beside it - a list would drift the first time someone adds a note.
  const emitted = [...source.matchAll(/code:\s*'([a-z_]+)'/g)].map(m => m[1]);
  // The ternary form `code: carton > 0 ? 'a' : 'b'` puts both arms in the same
  // match position, so pick those up too.
  const ternary = [...source.matchAll(/code:\s*[^'\n]*\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g)]
    .flatMap(m => [m[1], m[2]]);
  const all = [...new Set([...emitted, ...ternary])];

  ok(`the engine emits ${all.length} distinct codes`, all.length >= 15, all.join(', '));

  const known = {
    ...catalogue.NOTES, ...catalogue.BASIS, ...catalogue.ROUNDING,
  };
  const orphans = all.filter(c => !known[c]);
  ok('every code the engine emits has a catalogue entry', orphans.length === 0, orphans.join(', '));

  // Params that satisfy every renderer. Missing keys render as "undefined",
  // which is precisely what these checks are looking for.
  const params = {
    days: 90, requested: 60, soldForDays: 20, lastSold: '2026-02-01',
    netAvailable: -600, safetyDays: 14, safetyStock: 840, leadTimeDays: 90,
    onHand: 2300, carton: 24, minOrderUnits: 100,
  };

  let bad = [];
  for (const code of Object.keys(known)) {
    for (const lang of ['en', 'he']) {
      const spec = known[code];
      const out = spec[lang] ? spec[lang](params) : null;
      if (!out || typeof out !== 'string') { bad.push(`${code}/${lang}: empty`); continue; }
      if (out === code) { bad.push(`${code}/${lang}: rendered as its own code`); continue; }
      if (/undefined|NaN|\[object/.test(out)) { bad.push(`${code}/${lang}: "${out}"`); continue; }
      // A Hebrew rendering with no Hebrew letters in it is a forgotten entry
      // that was copy-pasted from the English one.
      if (lang === 'he' && !/[֐-׿]/.test(out)) bad.push(`${code}/he: no Hebrew letters — "${out}"`);
    }
  }
  ok(`all ${Object.keys(known).length} codes render cleanly in en and he`, bad.length === 0, bad.join(' | '));

  // An unknown code must degrade, not throw: a missing translation should look
  // wrong on screen, never take the page down.
  ok('the rounding phrase for "no rounding" is a phrase, not the code',
    catalogue.ROUNDING.none.en({}) !== 'none' && catalogue.ROUNDING.none.he({}) !== 'none');
  ok('…and the code survives localisation, so the screen can drop the clause',
    catalogue.localize({ notes: [], orderQtyRounding: { code: 'none' } }, 'he').orderQtyRoundingCode === 'none');

  ok('an unknown code renders as itself rather than throwing',
    catalogue.renderNote({ code: 'not_a_real_code' }, 'he') === 'not_a_real_code');
  ok('a null note is dropped rather than rendered',
    catalogue.renderNotes([null, { code: 'already_out' }], 'he').length === 1);

  // The numbers must not move between languages. This is the whole promise of
  // localising at the edge: two people reading in two languages reconcile.
  const row = baseRow({ units_per_carton: 24 });
  const en = catalogue.localize(computeRecommendation(row, settings(), ctx), 'en');
  const he = catalogue.localize(computeRecommendation(row, settings(), ctx), 'he');
  ok('the same row gives identical figures in both languages',
    en.orderQty === he.orderQty && en.estimatedCostExVat === he.estimatedCostExVat
    && en.daysOfCover === he.daysOfCover,
    `${en.orderQty}/${he.orderQty}`);
  ok('…and different words', en.notes.join() !== he.notes.join() || en.notes.length === 0);
}


// ---------------------------------------------------------------------------
// The header must equal the list under it.
//
// The screen shows a total beside "order now" and then a supplier accordion
// that only lists what is overdue or due soon. Those two have to be the same
// money. They were not: the total summed every row carrying a quantity, which
// swept in items that are adequately stocked but whose NEXT order falls past
// the horizon - an item can be covered for the whole delivery time and still
// have a quantity computed for the review period after it.
//
// On ZolStock that was 182 items and 65,076 shekels between the header and the
// rows beneath it. Half a percent: small enough to read as a rounding error,
// which is what makes it corrosive on a page whose entire purpose is that a
// buyer can add it up themselves.
// ---------------------------------------------------------------------------
console.log('\n12 · The headline total is the value of the rows on screen');
{
  // Pace is 60/day, so the target is 60 x (90 lead + 30 review) + 840 safety =
  // 8,040 units. Stock of 7,000 covers 116 days: past the 90-day lead plus the
  // 14-day horizon, so the row reads "ok" - and yet it is 1,040 units short of
  // the target, so it carries a quantity. That gap between "not urgent" and
  // "needs nothing" is the whole bug.
  const rows = [
    computeRecommendation(baseRow({ warehouse_qty: 0, on_order_qty: 0, committed_qty: 0 }), settings(), ctx),
    computeRecommendation(baseRow({ warehouse_qty: 7000, on_order_qty: 0, committed_qty: 0 }), settings(), ctx),
  ].filter(Boolean);

  const s = summarize(rows);
  const listed = rows.filter(r => r.status === 'overdue' || r.status === 'due_soon');
  const listedValue = listed.reduce((a, r) => a + (r.estimatedCostExVat || 0), 0);
  const everything = rows.reduce((a, r) => a + (r.estimatedCostExVat || 0), 0);

  ok('the headline total equals the value of the listed rows',
    Math.round(s.estimatedTotalExVat) === Math.round(listedValue),
    `${Math.round(s.estimatedTotalExVat)} vs ${Math.round(listedValue)}`);

  ok('the wider total is still available for anyone who wants it',
    Math.round(s.estimatedTotalAllExVat) === Math.round(everything),
    `${Math.round(s.estimatedTotalAllExVat)} vs ${Math.round(everything)}`);

  // The fixture has to actually contain the leaking case, or this section
  // passes by testing nothing - which is how the bug survived in the first
  // place.
  const stockedWithQty = rows.filter(r => r.status === 'ok' && r.orderQty > 0);
  ok('the fixture contains a stocked row that still carries a quantity',
    stockedWithQty.length > 0, JSON.stringify(rows.map(r => [r.status, r.orderQty])));
  ok('…and it is counted in the wider total but not the headline',
    s.estimatedTotalAllExVat > s.estimatedTotalExVat,
    `${s.estimatedTotalAllExVat} vs ${s.estimatedTotalExVat}`);
}

console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
