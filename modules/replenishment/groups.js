/**
 * Smart Replenishment — the item-grouping classifier.
 *
 * Deterministic, pure, settings-driven. Turns one computed recommendation row
 * (+ its signals) into a suggested group. Runs at READ time so a threshold
 * edit in the admin settings applies instantly — the signals view carries raw
 * measures only, never a baked-in verdict.
 *
 * Precedence (validated on live zolstock 2026-09-05, group sizes in the spec):
 *   data-doubt → seasonality → trend → history → confidence.
 *
 * GROUPS are stable ids; the screen renders its own labels ("Needs checking"
 * for `suspicious`). A buyer's verdict (assigned group) always beats the
 * computed suggestion — that resolution lives in the read path, not here.
 */

const GROUPS = {
  ORDER_NOW: 'order_now',
  SUSPICIOUS: 'suspicious',
  OUT_OF_SEASON: 'out_of_season',
  FADING: 'fading',
  NEW: 'new',
};

/** Uniform share of a year that 90 days is — the seasonal baseline. */
const UNIFORM_90 = 90 / 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} rec      engine output row (velocity, availability, flags)
 * @param {object} row      the base+signals DB row (qty windows, py_* fields,
 *                          in_stock_file, on_order_last_date)
 * @param {object} settings resolved module settings
 * @param {object} ctx      { today: Date|string, excludedSupplier?: boolean }
 * @returns {{group: string, reasonCode: string, detail: object}}
 */
function classify(rec, row, settings, ctx = {}) {
  const num = (v) => (v === null || v === undefined ? 0 : Number(v));
  const fadingRatio = numSetting(settings.paceFadingRatio, 0.5);
  const minUnits = numSetting(settings.seasonalMinUnits, 200);
  const lowShareRatio = numSetting(settings.seasonalLowShare, 0.5); // vs uniform
  const staleDays = numSetting(settings.staleOnOrderDays, 180);
  const absentMeansZero = settings.absentStockMeansZero !== false;

  // ── data-doubt first: a row we should not confidently order from ──
  if (ctx.excludedSupplier) {
    return out(GROUPS.SUSPICIOUS, 'excluded_supplier', {});
  }
  if (rec.unmatched) {
    return out(GROUPS.SUSPICIOUS, 'not_in_catalogue', {});
  }
  if (rec.netAvailable < 0) {
    return out(GROUPS.SUSPICIOUS, 'negative_availability', { netAvailable: rec.netAvailable });
  }
  if (rec.onOrderQty > 0 && row.on_order_last_date) {
    const ageDays = (dateOf(ctx.today) - dateOf(row.on_order_last_date)) / DAY_MS;
    if (ageDays > staleDays) {
      return out(GROUPS.SUSPICIOUS, 'stale_open_order', { orderAgeDays: Math.round(ageDays) });
    }
  }
  if (!absentMeansZero && row.in_stock_file === false && num(row.qty_sold_90d) > 0) {
    // The client said the warehouse export is PARTIAL: a selling item absent
    // from it has UNKNOWN stock, and ordering on unknown stock needs a human.
    return out(GROUPS.SUSPICIOUS, 'stock_not_tracked', {});
  }

  // ── seasonality: the item's own prior year says the coming 90 days are its
  //    dead season ──
  const pyYear = num(row.py_year_units);
  const pyNext90 = num(row.py_next90_units);
  if (pyYear >= minUnits) {
    const share = pyNext90 / pyYear;
    if (share < UNIFORM_90 * lowShareRatio) {
      return out(GROUPS.OUT_OF_SEASON, 'low_prior_year_share', {
        priorYearUnits: pyYear, priorYearNext90: pyNext90,
        share: round3(share), uniform: round3(UNIFORM_90),
      });
    }
  }

  // ── trend: recent pace collapsed vs the configured window ──
  const v28 = num(row.qty_sold_28d) / 28;
  const v90 = num(row.qty_sold_90d) / 90;
  if (v90 > 0 && v28 < v90 * fadingRatio) {
    return out(GROUPS.FADING, 'recent_pace_collapsed', {
      v28: round3(v28), v90: round3(v90), ratio: round3(v90 ? v28 / v90 : 0),
    });
  }

  // ── history: too thin to trust ──
  if (rec.thinHistory) {
    return out(GROUPS.NEW, 'thin_history', {});
  }

  return out(GROUPS.ORDER_NOW, 'steady_or_rising', {});
}

function out(group, reasonCode, detail) {
  return { group, reasonCode, detail };
}
function numSetting(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function dateOf(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * One sentence per reason, for `notes[]`/the screen's badges. Coded like the
 * engine's notes: the code is the claim, the words are a rendering.
 */
const REASON_TEXT = {
  excluded_supplier: 'This supplier is excluded from ordering by configuration.',
  not_in_catalogue: 'This code is not in the item catalogue — it cannot be ordered until identified.',
  negative_availability: 'Reservations exceed stock — the figures need verification before ordering.',
  stale_open_order: 'An open purchase order here is months old and may have been delivered.',
  stock_not_tracked: 'This selling item is absent from the warehouse stock file — stock unknown.',
  low_prior_year_share: 'Last year, the coming 90 days were this item\'s quiet season.',
  recent_pace_collapsed: 'Sales in the last 4 weeks collapsed versus the 90-day pace — the season may be ending.',
  thin_history: 'Too little sales history to trust the pace yet.',
  steady_or_rising: 'Steady or rising demand with clean data.',
};

module.exports = { GROUPS, classify, REASON_TEXT, UNIFORM_90 };
