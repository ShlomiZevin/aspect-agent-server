/**
 * Smart Replenishment — the calculation.
 *
 * A pure function over prepared rows and resolved settings. No DB, no LLM,
 * no clock: `today` and `dataThrough` are parameters, and the stock source is
 * passed in rather than hardcoded to "warehouse".
 *
 * WHY IT IS A FUNCTION AND NOT A PROMPT: the same question asked five
 * different ways, in either language, must return identical numbers. A model
 * asked to compute a reorder point will not do that. House rule: code does
 * arithmetic, the model does judgment — the model's job here is to explain
 * the answer and to ask for a missing lead time, never to derive it.
 *
 * WHY IT IS CALLABLE WITH NO USER IN FRONT OF IT: the agreed phasing has
 * proactive alerts arriving later. If this needed a request context or a
 * session, that phase would be a rewrite; as a plain function over stored
 * settings it is a scheduler entry plus a delivery channel.
 *
 * EVERY OUTPUT ROW SHOWS ITS WORKING. Each row carries the inputs it used,
 * where each parameter came from (`configured` / `dataset_default` /
 * `computed`), and `notes[]` — the single place every caveat is worded, so
 * the screen, the chat tool and the report quote the same sentence instead of
 * re-deriving three slightly different ones. A buyer will not act on a number
 * they cannot check.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Windows the prepared view carries. Keep in step with templates.js WINDOWS. */
const AVAILABLE_WINDOWS = [28, 60, 90, 365];

const STATUS = {
  OVERDUE: 'overdue',
  DUE_SOON: 'due_soon',
  OK: 'ok',
  NO_DEMAND: 'no_demand',
};

// ── small date helpers (no clock read anywhere) ──────────────────────────

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d;
}

function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

function iso(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Choose which prepared window column backs the velocity, and say so.
 *
 * The view carries 28/90/365 only; a settings value of, say, 60 has no
 * column. Rather than silently using the wrong one, the nearest available
 * window is used and the row records the basis it actually used — an answer
 * computed over 90 days must not claim to be a 60-day figure.
 */
function pickWindow(requestedDays) {
  const requested = num(requestedDays, 90);
  if (AVAILABLE_WINDOWS.includes(requested)) {
    return { days: requested, column: `qty_sold_${requested}d`, exact: true };
  }
  const nearest = AVAILABLE_WINDOWS.reduce((best, w) =>
    Math.abs(w - requested) < Math.abs(best - requested) ? w : best, AVAILABLE_WINDOWS[0]);
  return { days: nearest, column: `qty_sold_${nearest}d`, exact: false, requested };
}

/**
 * Compute one recommendation.
 *
 * NOTES AND LABELS ARE CODES, NOT SENTENCES. `notes[]`, `velocityBasis` and
 * `orderQtyRounding` come out of here as `{ code, params }`, and
 * modules/replenishment/notes.js turns them into text in the reader's language
 * at the service edge. The engine has no opinion about who is reading: the same
 * computation feeds a Hebrew screen, an English CSV and a model prompt. Before
 * this, a Hebrew buyer read English caveats reversed by RTL — under the one
 * heading on the page that exists to make a number checkable.
 *
 * @param {object} row       one row of mv_replenishment_base
 * @param {object} settings  resolved settings + per-supplier overrides:
 *   { leadTimeDays, leadTimeSource, reviewDays, safetyDays, velocityWindowDays,
 *     includeStoreStock, horizonDays, minOrderUnits, cartonRounding, vatRate }
 * @param {object} context   { today: Date|string, stockSource: 'warehouse'|'store'|'both' }
 * @returns {object|null}    the recommendation row, or null if the item does
 *                           not belong in the list at all (edge case 2)
 */
function computeRecommendation(row, settings, context = {}) {
  const notes = [];
  const today = toDate(context.today);
  if (!today) throw new Error('replenishment/engine: context.today is required (never read a clock in here)');

  const stockSource = context.stockSource || 'warehouse';
  const dataThrough = toDate(row.data_through) || today;

  // ── velocity ──
  const win = pickWindow(settings.velocityWindowDays);
  if (!win.exact) {
    notes.push({ code: 'window_substituted', params: { days: win.days, requested: win.requested } });
  }
  const qtyInWindow = num(row[win.column]);
  const firstSold = toDate(row.first_sold);
  const lastSold = toDate(row.last_sold);

  // Edge case 6 — a new item whose first sale is INSIDE the window has not
  // had the full window to sell in. Dividing by the full window understates
  // its pace, sometimes by a lot, and would under-order a product that is
  // actually selling well.
  let effectiveDays = win.days;
  let velocityBasis = { code: 'window_average', params: { days: win.days } };
  let thinHistory = false;
  if (firstSold) {
    const soldForDays = daysBetween(dataThrough, firstSold) + 1;
    if (soldForDays > 0 && soldForDays < win.days) {
      effectiveDays = soldForDays;
      velocityBasis = { code: 'since_first_sale', params: { days: soldForDays } };
      thinHistory = true;
      notes.push({ code: 'thin_history', params: { soldForDays, days: win.days } });
    }
  }

  // Edge case 7 — sales exist in the 365-day column but nothing recent. The
  // item is dormant, not slow; treating stale demand as current would keep
  // reordering something that stopped selling.
  const staleDemand = Boolean(lastSold && daysBetween(dataThrough, lastSold) > win.days);
  let velocityDaily = staleDemand || effectiveDays <= 0 ? 0 : qtyInWindow / effectiveDays;
  if (staleDemand) {
    notes.push({ code: 'stale_demand', params: { days: win.days, lastSold: iso(lastSold) } });
  }

  // ── pace model v2: the last 60 days count double, adjusted by the item's
  //    own prior-year seasonality ──
  //
  // Opt-in via settings.paceModel = 'weighted_seasonal', and applied ONLY when
  // the prepared row actually carries the inputs (qty_sold_60d from the base
  // view; py_* from the signals view). The basis code always states the
  // arithmetic that RAN, never the one configured — the Why? panel must not
  // describe a model that didn't run. Thin-history and dormant items keep
  // their own bases: a weighted year means nothing for an item ten days old,
  // and a dormant item's pace stays zero.
  if (settings.paceModel === 'weighted_seasonal' && !staleDemand && !thinHistory
      && row.qty_sold_60d !== undefined && row.qty_sold_60d !== null) {
    const q60 = num(row.qty_sold_60d);
    const q365 = num(row.qty_sold_365d);
    // 60 recent days at weight 2, the remaining 305 at weight 1.
    let v = (2 * q60 + Math.max(0, q365 - q60)) / (2 * 60 + 305);
    let seasonalIdx = null;
    const pyYear = num(row.py_year_units);
    const pyNext90 = num(row.py_next90_units);
    if (pyYear >= num(settings.seasonalMinUnits, 200)) {
      // How the coming 90 days compared to a uniform share, one year ago —
      // clamped so a single odd year cannot zero an item or 10x it.
      const raw = (pyNext90 / pyYear) / (90 / 365);
      seasonalIdx = Math.min(4, Math.max(0.25, raw));
      v *= seasonalIdx;
    }
    velocityDaily = v;
    velocityBasis = {
      code: 'weighted_seasonal',
      params: {
        recentDays: 60,
        seasonalIdx: seasonalIdx === null ? null : Math.round(seasonalIdx * 100) / 100,
      },
    };
    notes.push({ code: 'pace_model_weighted', params: { recentDays: 60, seasonal: seasonalIdx !== null } });
    if (seasonalIdx !== null && (seasonalIdx <= 0.5 || seasonalIdx >= 2)) {
      notes.push({ code: 'seasonal_adjustment', params: { idx: Math.round(seasonalIdx * 100) / 100 } });
    }
  }

  // ── availability ──
  const warehouseQty = num(row.warehouse_qty);
  const storeQty = num(row.store_qty_total);
  const includeStore = stockSource === 'both'
    || stockSource === 'store'
    || Boolean(settings.includeStoreStock);
  const onHand = stockSource === 'store' ? storeQty : warehouseQty + (includeStore ? storeQty : 0);

  const onOrderQty = num(row.on_order_qty);
  const committedQty = num(row.committed_qty);
  const netAvailable = onHand + onOrderQty - committedQty;

  // Edge case 3 — a negative position is REPORTED, not clamped. One ZolStock
  // store carries −802,918 units across 8,755 items; hiding that behind a
  // max(0,…) would present broken data as a healthy zero.
  if (netAvailable < 0) {
    notes.push({ code: 'negative_available', params: { netAvailable } });
  }

  // The on-order term is the weakest input in the whole formula: with no
  // goods-receipt events in the feed, an order placed long ago still looks
  // open, so supply is over-counted and the system under-orders.
  const onOrderIsUnverified = Boolean(row.on_order_qty) && settings.onOrderUnverified !== false;
  if (onOrderQty > 0 && onOrderIsUnverified) {
    notes.push({ code: 'on_order_unverified' });
  }

  // ── safety stock ──
  const safetyFromData = row.safety_stock_data === null || row.safety_stock_data === undefined
    ? null : num(row.safety_stock_data);
  let safetyStock;
  let safetyStockSource;
  if (safetyFromData !== null && safetyFromData > 0) {
    safetyStock = safetyFromData;
    safetyStockSource = 'configured';
  } else {
    safetyStock = Math.ceil(velocityDaily * num(settings.safetyDays, 14));
    safetyStockSource = 'computed';
    if (velocityDaily > 0) {
      notes.push({ code: 'safety_from_pace', params: { safetyDays: num(settings.safetyDays, 14), safetyStock } });
    }
  }

  const leadTimeDays = num(settings.leadTimeDays, 90);
  const reviewDays = num(settings.reviewDays, 30);
  const leadTimeSource = settings.leadTimeSource || 'dataset_default';
  // Edge case 8 — an inherited lead time is stated, every time. The buyer
  // must always be able to tell a number they gave us from one we assumed.
  if (leadTimeSource !== 'supplier') {
    notes.push({ code: 'lead_time_default', params: { leadTimeDays } });
  }

  const reorderPoint = velocityDaily * leadTimeDays + safetyStock;

  // ── timing ──
  //
  // Cover is clamped at zero. The QUANTITY may legitimately be negative and
  // is reported as such (edge case 3) — but time cannot be: dividing a
  // negative position by a slow-moving item produced "stock covers -5,400
  // days, this order should have gone out on 2011-08-15", which is
  // arithmetically implied by the formula and useless as a statement. Nobody
  // can act on "you should have ordered in 2011".
  //
  // Clamped, the same item says: cover 0, and the order is late by the
  // delivery time — "you are out of stock and this should have gone out
  // three months ago", which is both true and actionable. The negative
  // position stays visible in netAvailable and in its own note.
  const rawCover = velocityDaily > 0 ? netAvailable / velocityDaily : null;
  const daysOfCover = rawCover === null ? null : Math.max(0, rawCover);
  const alreadyOut = rawCover !== null && rawCover <= 0;
  if (alreadyOut) {
    notes.push({ code: 'already_out' });
  }
  const orderByDate = daysOfCover === null ? null : addDays(dataThrough, daysOfCover - leadTimeDays);
  const daysLate = orderByDate ? daysBetween(today, orderByDate) : null;

  // ── the actionable calendar (two-date model) ──
  //
  // `orderByDate` is a DIAGNOSIS: the last date an order could have gone out
  // and still beaten the runout. Once missed it lies in the past — and a past
  // date read as an instruction ("order by June 6") is nonsense; the client
  // said exactly that. These four are the INSTRUCTION side, clamped to the
  // calendar a buyer can act in:
  //   placeOrderBy          when to actually place the order — today at the
  //                         earliest, never a date that has already passed
  //   runoutDate            when current stock is projected to hit zero
  //   arrivesIfOrderedToday when goods would land if the order went out today
  //   stockoutGapDays       projected days of zero stock even if ordered
  //                         today (0 = an order today still beats the runout)
  const runoutDate = daysOfCover === null ? null : addDays(dataThrough, daysOfCover);
  const placeOrderBy = orderByDate === null ? null
    : (daysLate !== null && daysLate > 0 ? new Date(today.getTime()) : orderByDate);
  const arrivesIfOrderedToday = daysOfCover === null ? null : addDays(today, leadTimeDays);
  const stockoutGapDays = runoutDate && arrivesIfOrderedToday
    ? Math.max(0, daysBetween(arrivesIfOrderedToday, runoutDate))
    : null;

  // ── quantity ──
  const targetStock = velocityDaily * (leadTimeDays + reviewDays) + safetyStock;
  const rawQty = Math.max(0, targetStock - netAvailable);

  const carton = num(row.units_per_carton, 0);
  const roundingEnabled = settings.cartonRounding !== false;
  let orderQty;
  let orderQtyRounding;
  if (rawQty <= 0) {
    orderQty = 0;
    orderQtyRounding = { code: 'none' };
  } else if (carton > 0 && roundingEnabled) {
    orderQty = Math.ceil(rawQty / carton) * carton;
    orderQtyRounding = { code: 'cartons', params: { carton } };
  } else {
    // Edge case 4 — no carton size known. Round up to a whole unit and say
    // so, rather than silently emitting a fractional order quantity.
    orderQty = Math.ceil(rawQty);
    orderQtyRounding = { code: carton > 0 ? 'carton_rounding_off' : 'carton_unknown' };
    if (carton <= 0) {
      notes.push({ code: 'carton_unknown' });
    }
  }

  const minOrderUnits = num(settings.minOrderUnits, 0);
  if (rawQty > 0 && minOrderUnits > 0 && orderQty < minOrderUnits) {
    orderQty = minOrderUnits;
    orderQtyRounding = { code: 'min_order', params: { minOrderUnits } };
  }

  // ── status ──
  let status;
  if (daysOfCover === null) {
    status = STATUS.NO_DEMAND;
  } else if (daysLate !== null && daysLate > 0) {
    status = STATUS.OVERDUE;
  } else if (orderByDate && orderByDate <= addDays(today, num(settings.horizonDays, 14))) {
    status = STATUS.DUE_SOON;
  } else {
    status = STATUS.OK;
  }

  // Edge cases 1 and 2 — dead stock versus nothing at all.
  if (status === STATUS.NO_DEMAND) {
    if (onHand <= 0 && onOrderQty <= 0) {
      // Nothing sells, nothing in stock, nothing coming: there is no
      // decision to make, so the row does not belong on a buyer's screen.
      return null;
    }
    notes.push({ code: 'idle_stock', params: { onHand } });
    orderQty = 0;
    orderQtyRounding = { code: 'none' };
  }

  // Edge case 5 — a stock/order row whose key is not in the catalogue. It is
  // included (the stock is real) but flagged, because an item with no name or
  // supplier cannot actually be ordered until someone identifies it.
  const unmatched = !row.item_number && !row.item_name;
  if (unmatched) {
    notes.push({ code: 'unmatched_code' });
  }

  const unitCost = num(row.cost_ex_vat, 0);
  const estimatedCostExVat = unitCost > 0 ? orderQty * unitCost : null;
  if (orderQty > 0 && estimatedCostExVat !== null) {
    notes.push({ code: 'cost_estimate' });
  }

  return {
    sku: row.sku,
    itemNumber: row.item_number ?? null,
    itemName: row.item_name ?? null,
    category: row.category ?? null,
    subcategory: row.subcategory ?? null,
    supplier: row.supplier ?? null,
    supplierCode: row.supplier_code ?? null,

    status,
    unmatched,

    // inputs, so the row can show its own working
    velocityDaily,
    velocityBasis,
    thinHistory,
    staleDemand,
    /** Availability is at or below zero — cover is 0, not a negative number. */
    alreadyOut,
    qtyInWindow,
    warehouseQty,
    storeQty,
    onHand,
    onOrderQty,
    onOrderLineCount: num(row.on_order_line_count),
    onOrderLastDate: iso(toDate(row.on_order_last_date)),
    onOrderIsUnverified,
    committedQty,
    netAvailable,

    // parameters, each with where it came from
    leadTimeDays,
    leadTimeSource,
    reviewDays,
    safetyStock,
    safetyStockSource,
    unitsPerCarton: carton || null,

    // results
    reorderPoint,
    daysOfCover,
    orderByDate: iso(orderByDate),
    daysLate,
    placeOrderBy: iso(placeOrderBy),
    runoutDate: iso(runoutDate),
    arrivesIfOrderedToday: iso(arrivesIfOrderedToday),
    stockoutGapDays,
    targetStock,
    rawQty,
    orderQty,
    orderQtyRounding,
    estimatedCostExVat,

    dataThrough: iso(dataThrough),
    firstSold: iso(firstSold),
    lastSold: iso(lastSold),
    notes,
  };
}

/**
 * Compute a whole list, dropping the rows that do not belong on it, and
 * sort most-urgent-first.
 *
 * Ordering: overdue (longest overdue first) → due soon (earliest first) →
 * ok → no demand. That is the order a buyer works in, and it means the
 * default view answers "what do I do today" without touching a filter.
 */
function computeRecommendations(rows, settings, context = {}) {
  const out = [];
  for (const row of rows || []) {
    const rec = computeRecommendation(row, settings, context);
    if (rec) out.push(rec);
  }

  out.sort(compareUrgency);
  return out;
}

/**
 * FORWARD-LOOKING urgency — the one ordering every surface shares.
 *
 * The old rule (overdue first, most-late first) was true and useless: with an
 * unconfigured lead time, 86% of a real due list collapsed onto one identical
 * "93 days late" and the tiebreak was cost — a wall of long-dead rows that
 * buried every "in stock, runs out Thursday" line the buyer actually wanted.
 *
 * The new rule ranks by WHEN STOCK RUNS OUT, soonest first (already-out items
 * carry the earliest runout and lead naturally); ties — the entire already-
 * out cohort shares one runout — break by how fast money is bleeding
 * (velocity × unit cost per day), then by order value. Items the engine wants
 * ordered (due) come before adequately-stocked ones, which come before
 * no-demand rows.
 */
function compareUrgency(a, b) {
  const band = r => (r.status === STATUS.OVERDUE || r.status === STATUS.DUE_SOON) ? 0
    : r.status === STATUS.OK ? 1 : 2;
  if (band(a) !== band(b)) return band(a) - band(b);

  const runout = r => r.runoutDate ?? '9999-12-31';
  if (runout(a) !== runout(b)) return runout(a) < runout(b) ? -1 : 1;

  const bleed = r => {
    const unit = r.orderQty > 0 && r.estimatedCostExVat != null ? r.estimatedCostExVat / r.orderQty : 0;
    return (r.velocityDaily ?? 0) * unit;
  };
  const byBleed = bleed(b) - bleed(a);
  if (byBleed !== 0) return byBleed;

  const byValue = (b.estimatedCostExVat ?? 0) - (a.estimatedCostExVat ?? 0);
  if (byValue !== 0) return byValue;
  // Last resort: a stable, meaningless-but-repeatable key, so two runs over
  // the same data produce the same page rather than shuffling under the
  // buyer between refreshes.
  return String(a.sku).localeCompare(String(b.sku));
}

/** Headline counts for the summary tiles. Derived, never separately queried. */
function summarize(recommendations) {
  const s = {
    orderNow: 0, dueSoon: 0, ok: 0, noDemand: 0,
    estimatedTotalExVat: 0,
    estimatedTotalAllExVat: 0,
  };
  for (const r of recommendations) {
    if (r.status === STATUS.OVERDUE) s.orderNow++;
    else if (r.status === STATUS.DUE_SOON) s.dueSoon++;
    else if (r.status === STATUS.OK) s.ok++;
    else s.noDemand++;

    if (!r.estimatedCostExVat) continue;
    s.estimatedTotalAllExVat += r.estimatedCostExVat;

    // The headline total covers what the screen LISTS - overdue and due soon -
    // and nothing else, so a buyer who adds up the supplier rows arrives at the
    // number in the header.
    //
    // It used to sum every row with a quantity, which quietly included items
    // that are adequately stocked but whose next order falls beyond the
    // horizon: an item can be comfortably covered for the delivery time and
    // still need a quantity computed for the review period after it. On
    // ZolStock that was 182 items and 65,076 shekels of daylight between the
    // header and the list under it - small enough to look like a rounding
    // error, which is exactly what makes it corrosive on a page whose whole
    // job is being reconcilable.
    if (r.status === STATUS.OVERDUE || r.status === STATUS.DUE_SOON) {
      s.estimatedTotalExVat += r.estimatedCostExVat;
    }
  }
  return s;
}

module.exports = {
  STATUS,
  AVAILABLE_WINDOWS,
  computeRecommendation,
  computeRecommendations,
  compareUrgency,
  summarize,
  // exported for the offline battery
  pickWindow,
};
