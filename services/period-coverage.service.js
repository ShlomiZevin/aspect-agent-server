/**
 * Is the most recent period in this answer actually complete?
 *
 * These datasets are periodic exports, so the newest month in the data is
 * almost always a few days long. Comparing it to a full month is not a small
 * imprecision — it is a wrong conclusion. Chat reported one store "falling
 * ₪1,306,264 to ₪167,208 (-87%)" between May and June when June held four
 * days: the arithmetic was right and the finding was invented.
 *
 * WHY THIS IS COMPUTED, NOT WRITTEN. Reports already caveat this well most of
 * the time, because the synthesis prompt asks for it — which means it holds
 * only as long as the model chooses to comply, and it never reached chat at
 * all. `dataThroughDate` is already resolved per dataset by DataReloadService,
 * so completeness is a deterministic fact about the data. It is emitted as a
 * structural field that the UI renders unconditionally, rather than a sentence
 * a model may drop.
 *
 * Generic: no schema knowledge, no dataset list. A dataset whose data happens
 * to end on the last day of a month simply has no partial period, and every
 * caller sees null.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysInMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function toUTCDate(value) {
  if (!value) return null;
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The trailing month of the data, when it is incomplete.
 *
 * @param {string} dataThroughDate - 'YYYY-MM-DD', the newest date in the data.
 * @returns {{period, periodStart, expectedEnd, actualEnd, daysCovered, daysExpected, pctCovered}|null}
 */
function trailingPartialPeriod(dataThroughDate) {
  const end = toUTCDate(dataThroughDate);
  if (!end) return null;

  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() + 1;
  const daysExpected = daysInMonth(year, month);
  const daysCovered = end.getUTCDate();
  if (daysCovered >= daysExpected) return null; // the month is complete

  const mm = String(month).padStart(2, '0');
  return {
    period: `${year}-${mm}`,
    periodStart: `${year}-${mm}-01`,
    expectedEnd: `${year}-${mm}-${String(daysExpected).padStart(2, '0')}`,
    actualEnd: String(dataThroughDate).slice(0, 10),
    daysCovered,
    daysExpected,
    pctCovered: Math.round((daysCovered / daysExpected) * 100),
  };
}

/**
 * Does this answer actually involve the partial period? A banner on a question
 * about 2024 is noise, and noise trains people to ignore banners.
 *
 * Checks the result values and the SQL text for the period, which covers the
 * three shapes that occur: a date column, a 'YYYY-MM' month label, and a
 * literal date range in the query.
 */
function touchesPeriod(period, { rows = [], sql = '' } = {}) {
  if (!period) return false;
  const { period: ym, periodStart, expectedEnd } = period;

  if (typeof sql === 'string' && sql.includes(ym)) return true;
  if (typeof sql === 'string' && (sql.includes(periodStart) || sql.includes(expectedEnd))) return true;

  // Only the first rows are inspected: a result that involves the trailing
  // period essentially always shows it near the top (ordered by date or by
  // value), and scanning a million rows to decide whether to show a banner
  // would cost more than the answer.
  for (const row of rows.slice(0, 200)) {
    for (const value of Object.values(row || {})) {
      if (value == null) continue;
      const s = typeof value === 'string' ? value : (value instanceof Date ? value.toISOString() : String(value));
      if (s.length >= 7 && s.slice(0, 7) === ym) return true;
    }
  }
  return false;
}

/**
 * @returns {{partial: true, ...period, note: string}|null} the structural
 *   coverage fact for an answer, or null when nothing is partial or the
 *   answer does not involve the partial period.
 */
function computeCoverage({ dataThroughDate, sql = '', rows = [] } = {}) {
  const period = trailingPartialPeriod(dataThroughDate);
  if (!period) return null;
  if (!touchesPeriod(period, { rows, sql })) return null;

  return {
    partial: true,
    ...period,
    note: `${period.period} covers only ${period.daysCovered} of ${period.daysExpected} days (data ends ${period.actualEnd}). Totals for that period are not comparable to a full month.`,
  };
}

module.exports = { trailingPartialPeriod, touchesPeriod, computeCoverage };
