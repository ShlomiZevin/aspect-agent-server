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

console.log('\n1b · the actionable calendar — two dates, never an instruction in the past');
{
  const r = computeRecommendation(baseRow(), settings(), ctx);
  // Overdue: the diagnosis stays in the past, the instruction clamps to today.
  ok('an overdue item says PLACE ORDER TODAY, never a past date',
    r.placeOrderBy === TODAY, r.placeOrderBy);
  ok('…while orderByDate keeps the diagnosis (what would have prevented it)',
    r.orderByDate === '2026-07-19' && r.daysLate === 38, `${r.orderByDate} / ${r.daysLate}`);
  ok('runout = data-through + days of cover', r.runoutDate === '2026-10-17', r.runoutDate);
  ok('arrival if ordered today = today + lead', r.arrivesIfOrderedToday === '2026-11-24', r.arrivesIfOrderedToday);
  ok('stockout gap = arrival − runout when positive',
    r.stockoutGapDays === 38, String(r.stockoutGapDays));

  // Not yet due: the instruction IS the ideal date — no clamp.
  const early = computeRecommendation(baseRow(), settings(), { ...ctx, today: '2026-07-01' });
  ok('a not-yet-due item keeps its future order date as the instruction',
    early.placeOrderBy === early.orderByDate && early.placeOrderBy > '2026-07-01', early.placeOrderBy);
  ok('…and its gap is zero — ordering on time beats the runout',
    early.stockoutGapDays === 0, String(early.stockoutGapDays));

  const dead = computeRecommendation(
    baseRow({ qty_sold_28d: 0, qty_sold_90d: 0, qty_sold_365d: 0 }), settings(), ctx);
  ok('no demand → no calendar (null dates, not fake ones)',
    dead.placeOrderBy === null && dead.runoutDate === null && dead.stockoutGapDays === null,
    JSON.stringify([dead.placeOrderBy, dead.runoutDate]));
}

console.log('\n1c · forward-looking urgency — runout first, bleed breaks ties');
{
  const eng = require('../modules/replenishment/engine');
  const mk = (over) => computeRecommendation(baseRow(over), settings(), ctx);
  // Already out, bleeding fast vs slow: same runout (=THROUGH), bleed decides.
  const fast = mk({ sku: 'FAST', warehouse_qty: 0, on_order_qty: 0, committed_qty: 0, cost_ex_vat: 10 });
  const slow = mk({ sku: 'SLOW', warehouse_qty: 0, on_order_qty: 0, committed_qty: 0, cost_ex_vat: 0.5 });
  // In stock, runs out soon vs the already-out pair.
  const soon = mk({ sku: 'SOON', warehouse_qty: 300, on_order_qty: 0, committed_qty: 0 }); // ~5 days cover
  const sorted = [slow, soon, fast].sort(eng.compareUrgency).map(r => r.sku);
  ok('already-out items lead (earliest runout), fast bleeder before slow',
    sorted[0] === 'FAST' && sorted[1] === 'SLOW', sorted.join(','));
  ok('an in-stock item running out later sorts after the stockouts',
    sorted[2] === 'SOON', sorted.join(','));
  const okRow = mk({ warehouse_qty: 999999 });
  ok('adequately-stocked rows band after due rows regardless of runout',
    [okRow, fast].sort(eng.compareUrgency)[0].sku === 'FAST',
    okRow.status);
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
  // 60 became a real prepared window (it backs the weighted pace model), so
  // the unavailable-window case now uses 45 — whose nearest neighbour is 60.
  const w = pickWindow(45);
  ok('an unavailable window falls back to the nearest prepared one',
    w.column === 'qty_sold_60d' && w.exact === false, JSON.stringify(w));
  const r = computeRecommendation(baseRow(), settings({ velocityWindowDays: 45 }), ctx);
  ok('…and the row admits which window it really used',
    r.velocityBasis.code === 'window_average' && r.velocityBasis.params.days === 60 &&
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
    days: 90, requested: 45, soldForDays: 20, lastSold: '2026-02-01',
    netAvailable: -600, safetyDays: 14, safetyStock: 840, leadTimeDays: 90,
    onHand: 2300, carton: 24, minOrderUnits: 100,
    // pace model v2 (weighted seasonal)
    recentDays: 60, seasonal: true, seasonalIdx: 1.4, idx: 1.4,
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

// ── 7b · Pace model v2: weighted + seasonal ───────────────────────────────
//
// The Why? copy the design ships says "weights the last 60 days double and
// adjusts for seasonality". The copy-consistency rule: the screen must never
// describe arithmetic that isn't running — so the basis code states the model
// that RAN, and these assert both the arithmetic and that statement.
{
  console.log('\n7b · Pace model v2 — weighted + seasonal, honestly labelled');
  const v2row = (over = {}) => baseRow({
    qty_sold_60d: 600, qty_sold_90d: 810, qty_sold_365d: 1825,
    py_year_units: 1000, py_next90_units: 493, ...over,
  });
  const v2settings = (over = {}) => settings({ paceModel: 'weighted_seasonal', seasonalMinUnits: 200, ...over });

  const r = computeRecommendation(v2row(), v2settings(), ctx);
  // weighted base: (2*600 + (1825-600)) / 425 = 2425/425 = 5.7059
  // seasonal idx: (493/1000) / (90/365) = 0.493/0.24657 = 1.9995... ≈ 2.0
  ok('weighted pace doubles the last 60 days', near(r.velocityDaily / ((493 / 1000) / (90 / 365)), 2425 / 425, 0.01),
    String(r.velocityDaily));
  ok('…and multiplies by the item\'s own prior-year seasonal index',
    near(r.velocityDaily, (2425 / 425) * ((493 / 1000) / (90 / 365)), 0.01), String(r.velocityDaily));
  ok('the basis states the model that ran', r.velocityBasis.code === 'weighted_seasonal'
    && r.velocityBasis.params.seasonalIdx !== null, JSON.stringify(r.velocityBasis));
  ok('…and a pace-model note rides every weighted row', has(r, 'pace_model_weighted'));

  const noPy = computeRecommendation(v2row({ py_year_units: 50, py_next90_units: 10 }), v2settings(), ctx);
  ok('below seasonalMinUnits the seasonal factor is NOT applied and the label says so',
    noPy.velocityBasis.params.seasonalIdx === null && near(noPy.velocityDaily, 2425 / 425, 0.01),
    JSON.stringify(noPy.velocityBasis));

  const clamped = computeRecommendation(v2row({ py_next90_units: 0 }), v2settings(), ctx);
  ok('a dead prior-year season clamps at 0.25×, never zeroing a selling item',
    near(clamped.velocityDaily, (2425 / 425) * 0.25, 0.01), String(clamped.velocityDaily));

  const simple = computeRecommendation(v2row(), settings(), ctx);
  ok('without paceModel the engine is byte-identically the simple model',
    simple.velocityBasis.code === 'window_average' && near(simple.velocityDaily, 810 / 90, 0.001));

  const thin = computeRecommendation(
    v2row({ first_sold: '2026-08-20' }), v2settings(), ctx);
  ok('thin-history items keep their own basis — a weighted year means nothing at ten days old',
    thin.velocityBasis.code === 'since_first_sale', JSON.stringify(thin.velocityBasis));

  const oldView = computeRecommendation(
    baseRow({ qty_sold_60d: undefined }), v2settings(), ctx);
  ok('a view without the 60d column falls back to simple — configured ≠ ran',
    oldView.velocityBasis.code === 'window_average');
}

// ── 8 · Scope resolution (modules/replenishment/scope.js) ─────────────────
//
// The chat-protocol fix: scope × arithmetic decomposition. These are the pure
// filters behind the tool's skus[]/search/category parameters — the layer
// whose ABSENCE produced the live refusals ("purchase recommendation for the
// wood-products department" → refused; "items with עץ in the name" → refused).
{
  console.log('\n8 · Scope resolution — the vocabulary bridge');
  const scope = require('../modules/replenishment/scope');

  const rows = [
    { sku: 'AD-1', itemName: 'שולחן עץ מתקפל', itemNumber: '100', category: 'ריהוט', subcategory: 'שולחנות' },
    { sku: 'AD-2', itemName: 'כסא פלסטיק', itemNumber: '101', category: 'ריהוט', subcategory: 'כסאות' },
    { sku: 'BH-9', itemName: 'קרש חיתוך עץ', itemNumber: '102', category: 'מטבח', subcategory: 'כלי הכנה' },
    { sku: 'ML-3', itemName: 'צלחת נייר', itemNumber: '103', category: 'חד פעמי', subcategory: null },
  ];

  ok('no scope params → the list passes through untouched',
    scope.applyScope(rows, {}) === rows || scope.applyScope(rows, {}).length === 4);
  ok('hasScope is false for empty opts and blank search',
    !scope.hasScope({}) && !scope.hasScope({ search: '  ' }) && !scope.hasScope({ skus: [] }));

  const wood = scope.applyScope(rows, { search: 'עץ' });
  ok('search matches the item NAME across categories ("עץ" → table + cutting board)',
    wood.length === 2 && wood.every(r => ['AD-1', 'BH-9'].includes(r.sku)), JSON.stringify(wood.map(r => r.sku)));

  ok('search also matches sku and item number',
    scope.applyScope(rows, { search: 'ml-3' }).length === 1
    && scope.applyScope(rows, { search: '101' }).length === 1);

  // Word-start semantics — the גיאומטרי incident: a stem must match where a
  // word begins, never inside another word. Codes stay plain substring.
  const stemRows = [
    { sku: 'U-1', itemName: 'מטריה ילדים שקופה', itemNumber: '201', category: 'חורף' },
    { sku: 'U-2', itemName: 'מטריות ג׳מבו 95 סמ', itemNumber: '202', category: 'חורף' },
    { sku: 'G-1', itemName: 'עציץ סוקולנט בכלי גיאומטרי מעוצב', itemNumber: '203', category: 'בית' },
    { sku: 'G-2', itemName: 'מסגרת גיאומטרית 10*15', itemNumber: '204', category: 'בית' },
  ];
  const stem = scope.applyScope(stemRows, { search: 'מטרי' });
  ok('a name stem matches only at WORD STARTS ("מטרי" → umbrellas, never גיאומטרי)',
    stem.length === 2 && stem.every(r => r.sku.startsWith('U-')), JSON.stringify(stem.map(r => r.sku)));
  ok('mid-code fragments still match by substring ("20" hits the item numbers)',
    scope.applyScope(stemRows, { search: '20' }).length === 4);
  ok('a term that starts a LATER word in the name still matches ("ג׳מבו")',
    scope.applyScope(stemRows, { search: 'ג׳מבו' }).length === 1);
  ok('regex metacharacters in a search term are literal, never a pattern',
    scope.applyScope(stemRows, { search: '10*15' }).length === 1);

  const bySkus = scope.applyScope(rows, { skus: [' ad-1', 'BH-9 ', 'nope'] });
  ok('skus[] is the universal bridge — trims, case-insensitive, unknowns ignored',
    bySkus.length === 2, JSON.stringify(bySkus.map(r => r.sku)));

  ok('category is an exact label match, case/space-insensitive',
    scope.applyScope(rows, { category: ' ריהוט ' }).length === 2
    && scope.applyScope(rows, { category: 'ריה' }).length === 0);

  ok('filters compose with AND (category + search)',
    scope.applyScope(rows, { category: 'ריהוט', search: 'עץ' }).length === 1);

  ok('subcategory filters, and a null subcategory never matches a value',
    scope.applyScope(rows, { subcategory: 'כסאות' }).length === 1
    && scope.applyScope(rows, { subcategory: 'x' }).length === 0);

  const desc = scope.describeScope({ search: 'עץ', category: 'ריהוט' }, 1, 4);
  ok('describeScope states the interpretation AND the matched-of-total counts',
    /עץ/.test(desc) && /ריהוט/.test(desc) && /1 of 4/.test(desc), desc);
  ok('describeScope is null when nothing was scoped — no fake scope line on plain questions',
    scope.describeScope({}, 4, 4) === null);
  ok('the SKU-list ceiling is exported for the tool and the batteries to share',
    Number.isInteger(scope.MAX_SCOPE_SKUS) && scope.MAX_SCOPE_SKUS >= 100, String(scope.MAX_SCOPE_SKUS));
}

// ── 9 · The grouping classifier (modules/replenishment/groups.js) ─────────
{
  console.log('\n9 · Grouping classifier — doubt → season → trend → history → confidence');
  const { GROUPS, classify, REASON_TEXT } = require('../modules/replenishment/groups');
  const gctx = { today: '2026-09-06' };
  const gset = { paceFadingRatio: 0.5, seasonalMinUnits: 200, seasonalLowShare: 0.5, staleOnOrderDays: 180 };
  const rec = (over = {}) => ({ unmatched: false, netAvailable: 100, onOrderQty: 0, thinHistory: false, ...over });
  const grow = (over = {}) => ({
    qty_sold_28d: 280, qty_sold_90d: 900, py_year_units: 0, py_next90_units: 0,
    in_stock_file: true, on_order_last_date: null, ...over,
  });

  ok('clean steady demand → order_now',
    classify(rec(), grow(), gset, gctx).group === GROUPS.ORDER_NOW);
  ok('negative availability → suspicious, before anything else',
    classify(rec({ netAvailable: -5 }), grow({ qty_sold_28d: 0 }), gset, gctx).group === GROUPS.SUSPICIOUS);
  ok('catalogue-unmatched → suspicious',
    classify(rec({ unmatched: true }), grow(), gset, gctx).group === GROUPS.SUSPICIOUS);
  ok('an open PO older than the threshold → suspicious',
    classify(rec({ onOrderQty: 10 }), grow({ on_order_last_date: '2026-01-01' }), gset, gctx).group === GROUPS.SUSPICIOUS
    && classify(rec({ onOrderQty: 10 }), grow({ on_order_last_date: '2026-08-01' }), gset, gctx).group === GROUPS.ORDER_NOW);
  ok('prior year says the coming 90 days are dead → out_of_season (the September pool)',
    classify(rec(), grow({ py_year_units: 1000, py_next90_units: 20 }), gset, gctx).group === GROUPS.OUT_OF_SEASON);
  ok('…but thin prior-year history never triggers it',
    classify(rec(), grow({ py_year_units: 100, py_next90_units: 0 }), gset, gctx).group === GROUPS.ORDER_NOW);
  ok('recent pace collapsed → fading',
    classify(rec(), grow({ qty_sold_28d: 20, qty_sold_90d: 900 }), gset, gctx).group === GROUPS.FADING);
  ok('thin engine history → new',
    classify(rec({ thinHistory: true }), grow(), gset, gctx).group === GROUPS.NEW);
  ok('absentStockMeansZero=false routes selling untracked items to suspicious',
    classify(rec(), grow({ in_stock_file: false }), { ...gset, absentStockMeansZero: false }, gctx).group === GROUPS.SUSPICIOUS
    && classify(rec(), grow({ in_stock_file: false }), gset, gctx).group === GROUPS.ORDER_NOW);
  ok('every reason code has a rendering', Object.values(GROUPS).length === 5
    && ['excluded_supplier', 'not_in_catalogue', 'negative_availability', 'stale_open_order',
      'stock_not_tracked', 'low_prior_year_share', 'recent_pace_collapsed', 'thin_history',
      'steady_or_rising'].every(c => typeof REASON_TEXT[c] === 'string'));
}

console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
