/**
 * Per-dataset measure ceilings, measured from the fact table itself.
 *
 * THE GAP THIS CLOSES. Every other guard in the pipeline checks a reported
 * figure against the query's OWN result. That cannot catch a query which is
 * itself wrong: a cartesian or fan-out join inflates the result, the digest
 * faithfully aggregates the inflated rows, and the verifier confirms the
 * numbers because they really are in the data it was shown. Observed on zer4u
 * 2026-08-10 — a `JOIN … ON TRUE` produced a headline of **₪362.9B revenue for
 * a florist chain** whose entire sales table totals ~₪51M. Nothing in the
 * pipeline knew that was impossible.
 *
 * A baseline is the one thing that makes it decidable: the unjoined,
 * unfiltered total of each additive measure on the fact table is a hard upper
 * bound for any figure a report can legitimately claim about that measure. Any
 * query that produces more has fanned out, full stop.
 *
 * Generic by construction — it reads each dataset's own fact table and columns
 * from the registry and the live catalog, so a new dataset is covered the day
 * it is registered, with no hand-written thresholds.
 */

const registry = require('../datasets/registry');

/** Fact table per schema. Falls back to the largest table when unknown. */
const KNOWN_FACT_TABLES = {
  hypertoy: 'facts',
  thestock: 'facts',
  zolstock: 'facts',
  newdeli: 'facts',
  zer4u: 'sales',
  tevanaot: 'sales',
};

/** Numeric columns worth bounding — money and quantity, not ids or ratios. */
const MEASURE_LIKE = /(revenue|sales|profit|cost|amount|value|qty|quantity|units|total|balance|target)/i;
const NOT_MEASURE = /(pct|percent|rate|ratio|_id$|_code$|_key$|date|year|month|day|week)/i;

const TTL_MS = 60 * 60 * 1000; // an hour — baselines only move on a data reload
const cache = new Map(); // datasetId -> { at, baselines: { column: absTotal } }

async function factTableFor(pool, schema) {
  if (KNOWN_FACT_TABLES[schema]) return KNOWN_FACT_TABLES[schema];
  const { rows } = await pool.query(
    `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.reltuples DESC LIMIT 1`,
    [schema]
  );
  return rows[0]?.relname || null;
}

/**
 * @returns {Promise<{table: string, totals: Object<string, number>}|null>}
 *   absolute grand total per measure column across the ENTIRE fact table.
 */
async function getBaselines(datasetId) {
  const hit = cache.get(datasetId);
  if (hit && (Date.now() - hit.at) < TTL_MS) return hit.value;

  const entry = registry.get(datasetId);
  if (!entry) return null;
  const pool = entry.getPool();
  const schema = entry.schemaName;

  try {
    const table = await factTableFor(pool, schema);
    if (!table) return null;

    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [schema, table]
    );
    const measures = cols
      .filter(c => /^(numeric|integer|bigint|double precision|real|smallint)$/i.test(c.data_type))
      .map(c => c.column_name)
      .filter(n => MEASURE_LIKE.test(n) && !NOT_MEASURE.test(n))
      .slice(0, 12);
    if (measures.length === 0) return null;

    // One pass, SUM of absolute values — a measure that is legitimately
    // negative in places (returns, adjustments) still bounds correctly.
    const selects = measures.map(m => `SUM(ABS("${m}"))::numeric AS "${m}"`).join(', ');
    const { rows } = await pool.query(`SELECT ${selects} FROM ${schema}.${table}`);
    const totals = {};
    for (const m of measures) {
      const v = parseFloat(rows[0][m]);
      if (Number.isFinite(v) && v > 0) totals[m] = v;
    }

    const value = { table, totals };
    cache.set(datasetId, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`⚠️  Could not compute measure baselines for ${datasetId}: ${err.message}`);
    return null;
  }
}

/**
 * Checks a query result's own grand totals against the fact-table ceiling.
 *
 * Deliberately lenient: it fires only when a total EXCEEDS the whole fact
 * table by a clear margin, which is arithmetically impossible rather than
 * merely surprising. A filtered query is always ≤ the baseline; a joined query
 * that exceeds it has multiplied rows. The 1.05 tolerance absorbs a query that
 * legitimately unions or unnests a little.
 *
 * @returns {Promise<{exceeded: boolean, findings: Array}>}
 */
async function checkAgainstBaselines(datasetId, digest) {
  if (!digest || digest.empty) return { exceeded: false, findings: [] };
  const base = await getBaselines(datasetId);
  if (!base) return { exceeded: false, findings: [] };

  const findings = [];
  for (const [col, total] of Object.entries(digest.grandTotals || {})) {
    const abs = Math.abs(total);
    if (!Number.isFinite(abs) || abs === 0) continue;

    // Match the result column to a baseline column by name similarity —
    // generated SQL aliases freely (total_revenue_ex_vat vs sales_ex_vat).
    const norm = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
    const target = norm(col);
    let bestKey = null, bestScore = 0;
    for (const key of Object.keys(base.totals)) {
      const k = norm(key);
      const score = target.includes(k) || k.includes(target) ? Math.min(k.length, target.length) : 0;
      if (score > bestScore) { bestScore = score; bestKey = key; }
    }
    if (!bestKey) continue;

    const ceiling = base.totals[bestKey];
    if (abs > ceiling * 1.05) {
      findings.push({
        column: col,
        reported: abs,
        ceiling,
        factor: abs / ceiling,
        baselineColumn: bestKey,
        table: base.table,
      });
    }
  }
  return { exceeded: findings.length > 0, findings };
}

module.exports = { getBaselines, checkAgainstBaselines };
