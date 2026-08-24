/**
 * "What is the newest date this schema actually holds?" — one answer, shared.
 *
 * These datasets are periodic exports and are routinely weeks or months behind
 * wall-clock time, so `CURRENT_DATE` is the wrong anchor for every relative
 * expression a user types ("last 7 days", "this month", "recently"). Insights
 * already anchored to the real end date because it had DataReloadService to
 * hand; chat did not, so the same question gave a correct answer in one
 * surface and an empty one in the other.
 *
 * Kept here, in services/, rather than in insights/ because both surfaces need
 * it and nothing in services/ may depend on a product folder.
 *
 * FUTURE DATES ARE EXCLUDED DELIBERATELY. zolstock's wholesale rows carry
 * dates months ahead of today; a bare MAX() would anchor "recently" to a date
 * that has not happened yet and return nothing.
 */

/** Fact table per schema. A schema absent from this map simply gets no answer. */
const KNOWN_FACT_TABLES = {
  hypertoy: 'facts',
  thestock: 'facts',
  zolstock: 'facts',
  newdeli: 'facts',
  zer4u: 'sales',
  tevanaot: 'sales',
};

/** Date column candidates, most specific first. */
// Priority-ordered: fact-grain columns first. 'month' and 'cal_date' are
// LAST on purpose (Stage 3) — they only resolve for relations that carry no
// day-grain column at all (monthly roll-up MVs, calendar dimensions), so the
// data-status panel can show their stored period instead of "snapshot".
// pickDateColumn takes the first match, so appending here cannot change any
// existing fact-table resolution.
const DATE_COLUMNS = ['transaction_date', 'sale_date', 'order_date', 'row_date', 'cal_date', 'month'];

const TTL_MS = 30 * 60 * 1000; // the answer can only change when a load lands
const cache = new Map(); // schema -> { at, value }
const inflight = new Map(); // schema -> Promise, so a burst of chat turns makes one query

async function columnsOf(pool, schema, relname) {
  const { rows } = await pool.query(
    `SELECT a.attname FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, relname]
  );
  return rows.map(r => r.attname);
}

function pickDateColumn(cols) {
  return DATE_COLUMNS.find(d => cols.includes(d)) || null;
}

/**
 * @returns {Promise<string|null>} 'YYYY-MM-DD', or null when the schema has no
 *   known fact table or no recognisable date column. Never throws: a failure
 *   to resolve must degrade to the previous behaviour, not break the query.
 */
async function resolveDataThrough(pool, schema, { force = false } = {}) {
  if (!pool || !schema) return null;

  const hit = cache.get(schema);
  if (!force && hit && (Date.now() - hit.at) < TTL_MS) return hit.value;
  if (inflight.has(schema)) return inflight.get(schema);

  const promise = (async () => {
    try {
      const factTable = KNOWN_FACT_TABLES[schema];
      if (!factTable) return null;
      const dateCol = pickDateColumn(await columnsOf(pool, schema, factTable));
      if (!dateCol) return null;

      // MAX on an indexed date column is a backward index scan, not a table
      // scan — cheap enough to sit on the chat path behind this cache.
      const { rows } = await pool.query(
        `SELECT MAX("${dateCol}")::text AS m FROM ${schema}.${factTable} WHERE "${dateCol}" <= CURRENT_DATE`
      );
      const value = rows[0]?.m || null;
      cache.set(schema, { at: Date.now(), value });
      return value;
    } catch (err) {
      console.warn(`⚠️  data-through lookup failed for ${schema}: ${err.message}`);
      cache.set(schema, { at: Date.now(), value: null });
      return null;
    } finally {
      inflight.delete(schema);
    }
  })();

  inflight.set(schema, promise);
  return promise;
}

/**
 * Both ends of the data, not just the newest.
 *
 * Knowing only where the data ENDS lets a planner confidently propose a window
 * that predates the dataset entirely. Measured 2026-08-19: zer4u's
 * "steepest revenue decline" chip planned July 2026 against July 2025, but
 * zer4u.sales begins 2026-03-01 — so the comparison period does not exist, the
 * query returned zero rows, and the investigation failed as "data not
 * available" when the real fault was the question.
 *
 * @returns {Promise<{first: string|null, last: string|null}>} never throws.
 */
/**
 * The date span of ONE relation, with the same outlier resistance as the
 * dataset-level range. Exported because the data-health panel needs it per
 * table, and a second implementation would drift from this one.
 *
 * @returns {Promise<{first, last, dateColumn}>}
 */
async function rangeForRelation(pool, schema, relname) {
  const out = { first: null, last: null, dateColumn: null };
  try {
    const dateCol = pickDateColumn(await columnsOf(pool, schema, relname));
    if (!dateCol) return out;
    out.dateColumn = dateCol;
    const { first, last } = await boundedRange(pool, schema, relname, dateCol);
    out.first = first;
    out.last = last;
  } catch { /* best effort */ }
  return out;
}

async function boundedRange(pool, schema, relname, dateCol) {
  const { rows } = await pool.query(
    `SELECT MIN("${dateCol}")::text AS first, MAX("${dateCol}")::text AS last
       FROM ${schema}.${relname} WHERE "${dateCol}" <= CURRENT_DATE`
  );
  let first = rows[0]?.first || null;
  const last = rows[0]?.last || null;
  try {
    const { rows: st } = await pool.query(
      `SELECT histogram_bounds::text::text[] AS b
         FROM pg_stats WHERE schemaname = $1 AND tablename = $2 AND attname = $3`,
      [schema, relname, dateCol]
    );
    const bound = st[0]?.b?.[0];
    if (bound && first && bound > first) {
      const { rows: cnt } = await pool.query(
        `SELECT count(*) FILTER (WHERE "${dateCol}" < $1)::bigint AS before,
                count(*) FILTER (WHERE "${dateCol}" IS NOT NULL)::bigint AS dated
           FROM ${schema}.${relname} WHERE "${dateCol}" <= CURRENT_DATE`,
        [bound]
      );
      const before = Number(cnt[0]?.before || 0);
      const dated = Number(cnt[0]?.dated || 0);
      if (dated > 0 && before / dated < 0.0005) first = bound;
    }
  } catch { /* statistics are an optimisation, never a requirement */ }
  return { first, last };
}

async function resolveDataRange(pool, schema, { force = false } = {}) {
  if (!pool || !schema) return { first: null, last: null };

  const key = `range:${schema}`;
  const hit = cache.get(key);
  if (!force && hit && (Date.now() - hit.at) < TTL_MS) return hit.value;

  let value = { first: null, last: null };
  try {
    const factTable = KNOWN_FACT_TABLES[schema];
    if (factTable) {
      const dateCol = pickDateColumn(await columnsOf(pool, schema, factTable));
      if (dateCol) {
        // MIN and MAX together: both are index scans on an indexed date column,
        // and one round trip keeps this cheap enough to sit behind the cache.
        const { rows } = await pool.query(
          `SELECT MIN("${dateCol}")::text AS first, MAX("${dateCol}")::text AS last
             FROM ${schema}.${factTable} WHERE "${dateCol}" <= CURRENT_DATE`
        );
        let first = rows[0]?.first || null;
        const last = rows[0]?.last || null;

        // MIN is not robust. zolstock has ONE row dated 1988-01-01 and a
        // handful of stale purchase orders — 45 rows out of 26,918,153
        // (0.0002%) — which drags the reported start back 37 years. Telling a
        // planner the data begins in 1988 is worse than telling it nothing.
        //
        // The planner's statistics already contain the answer: ANALYZE builds
        // its histogram from a sample, so a 1-in-600,000 outlier is almost
        // never in it, and the first bound sits at the start of the real data.
        // It costs a catalog read, not a scan. If the histogram is missing
        // (never analyzed, or the column is in most-common-values) MIN stands.
        try {
          const { rows: st } = await pool.query(
            `SELECT histogram_bounds::text::text[] AS b
               FROM pg_stats WHERE schemaname = $1 AND tablename = $2 AND attname = $3`,
            [schema, factTable, dateCol]
          );
          const bound = st[0]?.b?.[0];
          if (bound && first && bound > first) {
            // The histogram bound is a SAMPLE minimum, not a percentile, so on
            // its own it over-corrects: it moved hypertoy's start forward five
            // months and discarded real history. So it is only a candidate —
            // accept it only if the rows it would discard are genuinely
            // negligible. One indexed range count decides it.
            const { rows: cnt } = await pool.query(
              `SELECT count(*) FILTER (WHERE "${dateCol}" < $1)::bigint AS before,
                      count(*) FILTER (WHERE "${dateCol}" IS NOT NULL)::bigint AS dated
                 FROM ${schema}.${factTable} WHERE "${dateCol}" <= CURRENT_DATE`,
              [bound]
            );
            const before = Number(cnt[0]?.before || 0);
            const dated = Number(cnt[0]?.dated || 0);
            // 0.05% — comfortably above zolstock's 45-in-26.9M (0.0002%) tail
            // and far below any real month of trading.
            if (dated > 0 && before / dated < 0.0005) first = bound;
          }
        } catch { /* statistics are an optimisation, never a requirement */ }

        value = { first, last };
      }
    }
  } catch (err) {
    console.warn(`⚠️  data-range lookup failed for ${schema}: ${err.message}`);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { resolveDataThrough, resolveDataRange, rangeForRelation, columnsOf, KNOWN_FACT_TABLES, DATE_COLUMNS, pickDateColumn };
