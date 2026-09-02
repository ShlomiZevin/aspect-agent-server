/**
 * Smart Replenishment — the read path.
 *
 * Joins three things that are deliberately separate everywhere else:
 *   the prepared view   (mv_replenishment_base — built nightly, ~15k rows)
 *   the settings chain  (supplier override → dataset default → code)
 *   the engine          (pure arithmetic, no SQL, no clock)
 *
 * WHY THE ARITHMETIC IS NOT PRECOMPUTED: the heavy work — scanning 27M fact
 * rows into windows, stock, on-order — happens ONCE a night inside the reload
 * that already runs. What is left at request time is reading ~15k prepared
 * rows and doing simple arithmetic over them, which is milliseconds. Freezing
 * the RESULT into a daily snapshot instead would mean a buyer editing a
 * supplier's lead time sees no change until tomorrow, and the lead time is
 * the one input they own. So: aggregate nightly, compute on read.
 *
 * (The future proactive-alerts phase does want a stored daily digest — one
 * that is sent, and must not be sent twice. That is a different artefact from
 * this, and the engine being a plain function over stored settings is what
 * makes it cheap to add.)
 */

const datasetRegistry = require('../../../insights/datasets/registry');
const moduleService = require('../../services/module.service');
const supplierSettings = require('./supplier-settings.service');
const { localize } = require('../notes');
const engine = require('../engine');

const MODULE_ID = 'replenishment';

/** Columns the engine needs, in the order the view provides them. */
const BASE_COLUMNS = `sku, item_number, item_name, category, subcategory, supplier, supplier_code,
       units_per_carton, safety_stock_data, consumer_price, cost_ex_vat,
       warehouse_qty, store_qty_total, on_order_qty, on_order_line_count,
       on_order_last_date, committed_qty,
       qty_sold_28d, qty_sold_90d, qty_sold_365d, first_sold, last_sold, data_through`;

/**
 * Resolve the dataset, its pool, and the module — refusing unless the module
 * is genuinely LIVE.
 *
 * `enabled && status === 'ready'` is the whole gate. A module that is enabled
 * but never initialized has no views to read; one that is ready but switched
 * off must behave as though it is not installed. Callers get a code they can
 * turn into a 404 rather than an exception.
 */
async function resolveLive(datasetId, schemaOverride) {
  const entry = datasetRegistry.get(datasetId);
  if (!entry) return { error: `Unknown dataset: ${datasetId}`, code: 404 };

  const mod = await moduleService.getForDataset(datasetId, MODULE_ID);
  if (!mod) return { error: `Module not registered for ${datasetId}`, code: 404 };
  if (!mod.live) {
    return {
      error: mod.enabled
        ? `Replenishment is enabled for ${datasetId} but not ready (status: ${mod.status})`
        : `Replenishment is not enabled for ${datasetId}`,
      code: 404,
    };
  }

  return {
    entry,
    mod,
    pool: entry.getPool(),
    // schemaOverride exists for tests and for reading a shadow build; the
    // routes never pass it.
    schemaName: schemaOverride || entry.schemaName,
  };
}

/**
 * Suppliers, with each one's resolved delivery time and where it came from.
 *
 * The list is built from the DATA (mv_suppliers), never from the settings
 * table — a supplier the client stops buying from disappears by itself, and a
 * new one appears without anybody adding it. Settings are overlaid on top.
 */
async function listSuppliers(datasetId, opts = {}) {
  const ctx = await resolveLive(datasetId, opts.schemaName);
  if (ctx.error) return ctx;

  const chain = await supplierSettings.resolveAll(datasetId);
  const { rows } = await ctx.pool.query(`
    SELECT supplier, supplier_code, sku_item_count, skus_with_stock, skus_sold_365d,
           warehouse_units, warehouse_value_ex_vat, units_sold_365d, data_through
      FROM ${ctx.schemaName}.mv_suppliers
     ORDER BY units_sold_365d DESC NULLS LAST`);

  return {
    datasetId,
    suppliers: rows.map(r => {
      const resolved = chain.forSupplier(r.supplier);
      return {
        supplier: r.supplier,
        supplierCode: r.supplier_code,
        skuItemCount: Number(r.sku_item_count),
        skusWithStock: Number(r.skus_with_stock),
        skusSold365d: Number(r.skus_sold_365d),
        warehouseUnits: Number(r.warehouse_units || 0),
        warehouseValueExVat: Number(r.warehouse_value_ex_vat || 0),
        unitsSold365d: Number(r.units_sold_365d || 0),
        dataThrough: r.data_through,
        leadTimeDays: resolved.leadTimeDays,
        // The badge the client screen renders: "you set this" vs "default".
        leadTimeSource: resolved.leadTimeSource,
        reviewDays: resolved.reviewDays,
        safetyDays: resolved.safetyDays,
        minOrderUnits: resolved.minOrderUnits,
        // So the settings dialog can show the switch in the position it is
        // actually in. Without it the page could report that a supplier was
        // excluded while the only control for it opened unchecked.
        excluded: resolved.excluded,
      };
    }),
  };
}

/**
 * Recommendations, computed per row with THAT supplier's settings.
 *
 * Grouped by supplier because that is the unit of action — a buyer raises one
 * order per supplier, not per item — and because the lead time that drives
 * every date is a supplier-level number.
 */
/**
 * The pass everything else is built on: every row, computed with its own
 * supplier's settings, sorted by urgency.
 *
 * Extracted because two callers need the SAME numbers from it and must not
 * compute them differently — the plan (aggregates per supplier) and the item
 * list (one page of rows). When those were one function the page had to fetch
 * every row to add up a supplier's total, which on ZolStock was a 14 MB
 * response for a screen that shows ten lines.
 */
async function computeAll(datasetId, opts = {}) {
  // Progress is REPORTED, never simulated. The screen draws a four-step panel
  // while a plan is recalculated, and the only honest way to fill it is for the
  // work itself to say where it is. The whole computation takes well under a
  // second on 9,000 rows, so the panel is often a flash — which is the truth,
  // and better than a bar padded to look like effort.
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  // Which language the caveats come back in. English unless asked otherwise:
  // the CSV, the chat tool's data contract and every script default to it.
  const lang = opts.lang === 'he' ? 'he' : 'en';

  const ctx = await resolveLive(datasetId, opts.schemaName);
  if (ctx.error) return ctx;

  const chain = await supplierSettings.resolveAll(datasetId);
  const params = [];
  const filters = [];
  if (opts.supplier) { params.push(opts.supplier); filters.push(`supplier = $${params.length}`); }
  if (opts.sku) { params.push(opts.sku); filters.push(`sku = $${params.length}`); }

  report({ phase: 'reading', done: 0, total: 0 });
  const { rows } = await ctx.pool.query(`
    SELECT ${BASE_COLUMNS}
      FROM ${ctx.schemaName}.mv_replenishment_base
     ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}`, params);
  report({ phase: 'read', done: 0, total: rows.length });

  // `today` is a parameter of the engine, never read inside it — but SOMEONE
  // has to supply it, and this is the edge where a clock is legitimate.
  const today = opts.today || new Date().toISOString().slice(0, 10);

  const all = [];
  // Counted rather than silently dropped: a supplier excluded on purpose still
  // owes the buyer an explanation of where its rows went, and the screen says
  // so under the tiles.
  let excludedItems = 0;
  const excludedSuppliers = new Set();

  // Reported every 500 rows rather than every row: the loop is fast enough
  // that per-row events would cost more than the work they describe.
  const STRIDE = 500;
  let seen = 0;

  for (const row of rows) {
    if (++seen % STRIDE === 0) report({ phase: 'computing', done: seen, total: rows.length });
    const settings = chain.forSupplier(row.supplier);

    const rec = engine.computeRecommendation(row, {
      ...settings,
      horizonDays: opts.horizonDays ?? settings.horizonDays,
    }, { today, stockSource: opts.stockSource || 'warehouse' });
    if (!rec) continue;

    // An archive supplier sells but holds no warehouse stock by design, so every
    // one of its items reads as permanently overdue. Those are not orders anyone
    // will place; excluding them is the buyer's call, per supplier.
    //
    // Computed first and dropped after, so the count reports what the buyer
    // WOULD have seen. Counting the raw rows instead said "2,624 excluded" for a
    // supplier whose list only ever held 289 — a number that is true of the data
    // and false of the screen.
    if (settings.excluded) {
      excludedItems += 1;
      excludedSuppliers.add(row.supplier);
      continue;
    }

    all.push(rec);
  }

  // Rows are computed per supplier (each with its own lead time), so the
  // engine's own list helper cannot be used here — the ordering rule it
  // applies is reused instead.
  const ordered = sortByUrgency(all);
  report({ phase: 'done', done: rows.length, total: rows.length });

  return {
    ctx,
    chain,
    today,
    ordered,
    rowCount: rows.length,
    dataThrough: rows[0]?.data_through || null,
    excluded: { items: excludedItems, suppliers: [...excludedSuppliers] },
  };
}

/**
 * Recommendations, as a page of item rows.
 *
 * Grouped by supplier because that is the unit of action — a buyer raises one
 * order per supplier, not per item — and because the lead time that drives
 * every date is a supplier-level number.
 */
async function getRecommendations(datasetId, opts = {}) {
  const lang = opts.lang === 'he' ? 'he' : 'en';
  const base = await computeAll(datasetId, opts);
  if (base.error) return base;
  const { ordered, today, dataThrough, excluded } = base;

  const due = opts.onlyDue
    ? ordered.filter(r => r.status === engine.STATUS.OVERDUE || r.status === engine.STATUS.DUE_SOON)
    : ordered;

  // Free-text over the three things a buyer knows an item by.
  //
  // Applied HERE, after the engine, and never in the query: the summary below
  // is computed from `ordered`, so filtering in SQL made the tiles describe the
  // search results instead of the whole set — the exact thing the house rule
  // forbids, and it is invisible until someone types in the box. The engine
  // already runs over every row to build that summary, so this costs nothing
  // extra.
  const term = String(opts.search ?? '').trim().toLowerCase();
  const filtered = term
    ? due.filter(r =>
      String(r.itemName ?? '').toLowerCase().includes(term)
      || String(r.sku ?? '').toLowerCase().includes(term)
      || String(r.itemNumber ?? '').toLowerCase().includes(term))
    : due;

  // A page out of the filtered set. `offset` beyond the end yields an empty
  // page rather than an error: it is what a stale pager sends after someone
  // else's reload shortened the list, and an error there would be a dead screen.
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = opts.limit ? Math.max(0, Number(opts.limit)) : null;
  const page = limit === null ? filtered.slice(offset) : filtered.slice(offset, offset + limit);

  return {
    datasetId,
    today,
    // Summaries are over EVERYTHING, not the page and not the search — a tile
    // that counted only the visible rows would be a different, wrong number.
    summary: engine.summarize(ordered),
    dataThrough,
    // How many the filters matched, so the screen can say "showing X of Y" and
    // never truncate silently.
    total: filtered.length,
    // Suppliers the buyer will actually see a row for: those with something
    // overdue or due soon, over the whole matched set rather than the page.
    //
    // Counted over the ACTIONABLE rows for the same reason the value above is:
    // the accordion below only lists suppliers with something to order, so
    // counting every supplier with any row at all would put a number in the
    // header that the list underneath contradicts. They agree on ZolStock today
    // only because every supplier here happens to have an urgent item.
    //
    // The view already COALESCEs a missing supplier to '(unattributed)', so
    // this counts that bucket as the one supplier it is drawn as.
    supplierCount: new Set(
      filtered
        .filter(r => r.status === engine.STATUS.OVERDUE || r.status === engine.STATUS.DUE_SOON)
        .map(r => r.supplier),
    ).size,
    offset,
    limit,
    // So the page can account for the difference rather than leaving the buyer
    // to wonder why a supplier they know is missing.
    excluded,
    // Turned into sentences HERE, for the page only. Everything above — the
    // summary, the totals, the sort — is computed on structured values, so
    // nothing that anyone reconciles depends on a language.
    recommendations: page.map(r => localize(r, lang)),
  };
}

/**
 * Same ordering rule as engine.computeRecommendations, applied to a built list.
 *
 * WHY THERE IS A TIE-BREAK. Sorting the overdue rows by days late is only a
 * sort when the days differ. They mostly do not: with no supplier delivery time
 * set, every overdue row inherits the same 90-day default and comes out at the
 * same lateness — on zolstock's largest supplier that is 4,322 of 5,205 rows
 * (83%) all reading "92 days late". Past that point the comparator returns 0
 * and the order is whatever the query happened to return, so page 20 looks like
 * page 2 and the whole list reads as arbitrary. That is exactly the complaint.
 *
 * So equal lateness falls through to the money at stake, then to how fast the
 * item actually moves. A buyer working down the list now meets the biggest,
 * fastest-moving gaps first instead of an accident of row order, and a page
 * deep in the list is visibly different from the first one.
 *
 * This does not invent urgency the data cannot support — every row here is
 * genuinely overdue on its own arithmetic. It orders rows the previous rule
 * left unordered.
 */
function sortByUrgency(list) {
  const rank = {
    [engine.STATUS.OVERDUE]: 0, [engine.STATUS.DUE_SOON]: 1,
    [engine.STATUS.OK]: 2, [engine.STATUS.NO_DEMAND]: 3,
  };
  const value = r => r.estimatedCostExVat ?? 0;
  const pace = r => r.velocityDaily ?? 0;

  return list.slice().sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];

    if (a.status === engine.STATUS.OVERDUE) {
      const byLate = (b.daysLate ?? 0) - (a.daysLate ?? 0);
      if (byLate !== 0) return byLate;
    } else if (a.status === engine.STATUS.DUE_SOON) {
      const byDate = String(a.orderByDate).localeCompare(String(b.orderByDate));
      if (byDate !== 0) return byDate;
    }

    const byValue = value(b) - value(a);
    if (byValue !== 0) return byValue;
    const byPace = pace(b) - pace(a);
    if (byPace !== 0) return byPace;
    // Last resort: a stable, meaningless-but-repeatable key, so two runs over
    // the same data produce the same page rather than shuffling under the
    // buyer between refreshes.
    return String(a.sku).localeCompare(String(b.sku));
  });
}

/** One item, with its full working — what the trust panel renders. */
/**
 * The whole screen in one small response: the tiles, and one line per supplier.
 *
 * This is what the Procurement page opens with. It used to open by downloading
 * every recommendation — 14 MB on ZolStock — purely so the browser could group
 * them and add up a total per supplier. The grouping is the server's job: it
 * has already computed every row to build the summary, and turning that into
 * ten lines costs nothing.
 *
 * The item rows arrive later, one expanded supplier at a time, through
 * getRecommendations with a `supplier` filter and a page size.
 */
async function getPlan(datasetId, opts = {}) {
  const base = await computeAll(datasetId, opts);
  if (base.error) return base;
  const { ordered, chain, today, dataThrough, excluded } = base;

  // What the accordion lists: suppliers with something overdue or due soon.
  // The same set the header counts and totals, so the page reconciles with
  // itself by construction rather than by two places agreeing to be careful.
  const actionable = ordered.filter(
    r => r.status === engine.STATUS.OVERDUE || r.status === engine.STATUS.DUE_SOON);

  const bySupplier = new Map();
  for (const r of actionable) {
    let g = bySupplier.get(r.supplier);
    if (!g) {
      g = { supplier: r.supplier, items: 0, estimatedTotalExVat: 0, overdue: 0, dueSoon: 0 };
      bySupplier.set(r.supplier, g);
    }
    g.items += 1;
    g.estimatedTotalExVat += r.estimatedCostExVat || 0;
    if (r.status === engine.STATUS.OVERDUE) g.overdue += 1; else g.dueSoon += 1;
  }

  const suppliers = [...bySupplier.values()]
    .map(g => {
      const settings = chain.forSupplier(g.supplier);
      return {
        ...g,
        leadTimeDays: settings.leadTimeDays,
        // The badge the row renders: "you set this" vs "default — set it".
        leadTimeSource: settings.leadTimeSource,
        excluded: settings.excluded,
      };
    })
    // Biggest list first: that is where a buyer's money and attention are.
    .sort((a, b) => b.items - a.items);

  return {
    datasetId,
    today,
    dataThrough,
    summary: engine.summarize(ordered),
    supplierCount: suppliers.length,
    excluded,
    suppliers,
  };
}

async function getBySku(datasetId, sku, opts = {}) {
  const res = await getRecommendations(datasetId, { ...opts, sku });
  if (res.error) return res;
  const rec = res.recommendations[0];
  if (!rec) return { error: `No replenishment row for sku ${sku}`, code: 404 };
  return { datasetId, today: res.today, recommendation: rec };
}

module.exports = { MODULE_ID, resolveLive, listSuppliers, getPlan, getRecommendations, getBySku };
