/**
 * Smart Replenishment — verification probes.
 *
 * Checkable measurements against the BUILT views, not vibes. Each probe
 * records pass/fail WITH THE NUMBERS, because that text is what the round
 * loop feeds back to the model ("61.9% < 95% threshold, binding mapped
 * item_number") and what a human reads when a run fails. A probe that only
 * says "failed" costs a round and teaches nothing.
 *
 * A PROBE THAT CANNOT FAIL IS NOT A PROBE. scripts/test-replenishment-probes.js
 * runs each of these against a deliberately mis-mapped binding and asserts it
 * goes red — a suite of probes that all pass because they are toothless is
 * worse than none, since it manufactures confidence.
 *
 * All probes are read-only and run inside the scratch schema the views were
 * built into, never against the live one.
 */

const { THRESHOLDS } = require('./binding-contract');

function probe(name, passed, detail, extra = {}) {
  return { probe: name, passed: Boolean(passed), detail, ...extra };
}

async function one(pool, sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows[0] || {};
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const pct = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * @param {object} ctx { pool, schemaName, verifySchema, binding, audit, round }
 * @returns {{passed: boolean, probes: object[]}}
 */
async function verify(ctx) {
  const { pool, binding, audit: auditDoc } = ctx;
  // Where the views were actually built. Falls back to the live schema only
  // for a manual re-verify; the init pipeline always passes a scratch schema.
  const vs = ctx.verifySchema || ctx.schemaName;
  const src = ctx.schemaName;
  const probes = [];

  // ── 1. the views exist and are populated ──
  const views = await pool.query(`
    SELECT matviewname AS name, ispopulated
      FROM pg_matviews WHERE schemaname = $1`, [vs]);
  const byName = Object.fromEntries(views.rows.map(r => [r.name, r.ispopulated]));

  const required = ['mv_replenishment_base'];
  if (binding.catalog?.supplierCol) required.push('mv_suppliers');
  const missing = required.filter(v => !(v in byName));
  const unpopulated = required.filter(v => v in byName && !byName[v]);

  probes.push(probe('views_exist', missing.length === 0 && unpopulated.length === 0,
    missing.length ? `missing: ${missing.join(', ')}`
      : unpopulated.length ? `not populated: ${unpopulated.join(', ')}`
      : `${required.length}/${required.length} views present and populated`));

  if (missing.length) {
    // Nothing downstream can be measured; return early rather than emit a
    // cascade of failures that all say the same thing.
    return { passed: false, probes };
  }

  // ── 2. the base view has a plausible number of rows ──
  const base = await one(pool, `SELECT COUNT(*)::bigint AS n FROM ${vs}.mv_replenishment_base`);
  const baseRows = num(base.n);
  probes.push(probe('base_row_count', baseRows >= THRESHOLDS.minBaseRows,
    `${baseRows.toLocaleString('en-GB')} rows (minimum ${THRESHOLDS.minBaseRows})`,
    { rows: baseRows }));

  // ── 3. the grain is unique ──
  // Not decorative: a duplicated grain means the dedup did not take, and every
  // total built on this view would be inflated. The 44.6% incident was exactly
  // this shape, and it went unnoticed because the numbers still looked
  // plausible.
  const dup = await one(pool, `
    SELECT COUNT(*)::bigint AS n FROM (
      SELECT sku FROM ${vs}.mv_replenishment_base GROUP BY sku HAVING COUNT(*) > 1
    ) d`);
  const dupes = num(dup.n);
  probes.push(probe('grain_is_unique', dupes === 0,
    dupes === 0
      ? `${baseRows.toLocaleString('en-GB')} rows, one per sku, 0 duplicates`
      : `${dupes.toLocaleString('en-GB')} sku values appear more than once — the catalogue dedup did not take`,
    { duplicateKeys: dupes }));

  // ── 4. the base view reconciles with what the audit measured ──
  //
  // Against DISTINCT keys, not rows-carrying-a-key. The view's grain is one
  // row per replenishment key, so on any catalogue that repeats keys — which
  // is precisely the `catalog_not_unique` quirk — those two numbers differ by
  // construction. Comparing against the row count failed the CORRECT ZolStock
  // binding at 14,762 vs 15,180 (2.8%), i.e. the probe would have blocked
  // every dataset the dedup exists for.
  const auditKey = auditDoc?.measurements?.chosenReplenishmentKey;
  const expected = auditKey?.distinctValues;
  if (expected) {
    const drift = Math.abs(baseRows - expected) / expected;
    probes.push(probe('reconciles_with_audit', drift <= 0.02,
      `view has ${baseRows.toLocaleString('en-GB')} rows against ${expected.toLocaleString('en-GB')} distinct keys measured by the audit (${pct(drift)} apart, tolerance 2.0%)`,
      { viewRows: baseRows, auditDistinctKeys: expected, drift }));
  }

  // ── 5. demand actually joined ──
  // THE probe the round loop exists for. A binding that maps the wrong item
  // key produces a view that builds cleanly and is entirely empty of demand —
  // it looks fine until someone notices every product "never sold".
  const dem = await one(pool, `
    SELECT COUNT(*) FILTER (WHERE qty_sold_365d > 0)::bigint AS with_demand,
           COUNT(*)::bigint AS total
      FROM ${vs}.mv_replenishment_base`);
  const withDemand = num(dem.with_demand);
  const velocityCoverage = num(dem.total) ? withDemand / num(dem.total) : 0;
  probes.push(probe('velocity_coverage', velocityCoverage >= THRESHOLDS.velocityCoverage,
    `${withDemand.toLocaleString('en-GB')} of ${num(dem.total).toLocaleString('en-GB')} rows have sales history (${pct(velocityCoverage)}, minimum ${pct(THRESHOLDS.velocityCoverage)})`,
    { withDemand, velocityCoverage }));

  // ── 6. demand-key join rate, measured against the raw fact rows ──
  if (binding.demand?.itemKey && binding.catalog?.itemKey && binding.catalog?.replenishmentKey) {
    const dFilter = binding.demand.rowFilter ? `WHERE ${binding.demand.rowFilter}` : '';
    const j = await one(pool, `
      WITH bridge AS (
        SELECT ${binding.catalog.itemKey} AS item_number
          FROM ${src}.${binding.catalog.table}
         WHERE ${binding.catalog.replenishmentKey} IS NOT NULL
           AND ${binding.catalog.itemKey} IS NOT NULL
         GROUP BY 1
      )
      SELECT COUNT(*)::bigint AS rows,
             COUNT(b.item_number)::bigint AS joined
        FROM ${src}.${binding.demand.table} f
        LEFT JOIN bridge b ON b.item_number = f.${binding.demand.itemKey}
        ${dFilter}`);
    const rows = num(j.rows);
    const joined = num(j.joined);
    // Measured among rows that CAN join: on this feed most sales rows are for
    // items with no replenishment key at all, which is a documented property
    // of the catalogue, not a mapping error. The probe judges whether the KEY
    // resolves, not whether the client's coverage is good.
    const rate = rows ? joined / rows : 0;
    probes.push(probe('demand_join_rate', joined > 0,
      joined > 0
        ? `${joined.toLocaleString('en-GB')} of ${rows.toLocaleString('en-GB')} demand rows resolve to a keyed item (${pct(rate)})`
        : `NO demand row resolves to a keyed item — the demand item key (${binding.demand.itemKey}) does not match the catalogue key (${binding.catalog.itemKey})`,
      { rows, joined, rate }));
  }

  // ── 7. spot aggregates reconcile with the raw tables, IN BOTH DIRECTIONS ──
  //
  // Inflation is the obvious failure (a fanned-out join), but COLLAPSE is the
  // dangerous one and it is silent: point a section at the wrong item key and
  // its rows all fail the `IS NOT NULL` filter, so the column becomes
  // COALESCE(NULL, 0) = 0 on every row. The view builds, the grain is right,
  // nothing errors.
  //
  // For stock that means every product reads as having none, and the engine
  // confidently recommends reordering the entire catalogue. An earlier
  // version of this probe only checked `view <= source`, and 0 <= 4,853,542
  // passed happily — the mis-mapped binding went green across the whole
  // suite.
  const sections = [
    ['warehouse', binding.stock?.warehouse, 'warehouse_qty'],
    ['on_order', binding.onOrder, 'on_order_qty'],
    ['committed', binding.committed, 'committed_qty'],
  ];

  for (const [label, section, viewCol] of sections) {
    if (!section) continue;   // not declared for this client — nothing to check
    const secFilter = section.rowFilter ? `WHERE ${section.rowFilter}` : '';
    const raw = await one(pool, `
      SELECT COALESCE(SUM(${section.qtyCol}), 0)::numeric AS total, COUNT(*)::bigint AS rows
        FROM ${src}.${section.table || binding.demand.table} ${secFilter}`);
    const viewTotal = await one(pool, `
      SELECT COALESCE(SUM(${viewCol}), 0)::numeric AS total,
             COUNT(*) FILTER (WHERE ${viewCol} <> 0)::bigint AS nonzero_rows
        FROM ${vs}.mv_replenishment_base`);

    const rawN = num(raw.total);
    const viewN = num(viewTotal.total);
    const nonzero = num(viewTotal.nonzero_rows);
    const share = rawN ? viewN / rawN : null;

    const inflated = rawN > 0 && viewN > rawN * (1 + THRESHOLDS.aggregateTolerance);
    // Collapsed: the source has quantity, the view has none anywhere. The
    // view legitimately carries only keys present in the catalogue, so a
    // SHORTFALL is expected — total absence is not.
    const collapsed = rawN > 0 && nonzero === 0;

    probes.push(probe(`${label}_reconciles`, !inflated && !collapsed,
      collapsed
        ? `source has ${rawN.toLocaleString('en-GB')} units across ${num(raw.rows).toLocaleString('en-GB')} rows but NO view row carries any — the ${label} item key (${section.itemKey}) does not match those rows`
        : inflated
          ? `view sums ${viewN.toLocaleString('en-GB')} against a source total of ${rawN.toLocaleString('en-GB')} — a join has fanned out`
          : `view ${viewN.toLocaleString('en-GB')} of source ${rawN.toLocaleString('en-GB')} units (${share === null ? 'n/a' : pct(share)}) across ${nonzero.toLocaleString('en-GB')} rows`,
      { rawTotal: rawN, viewTotal: viewN, nonzeroRows: nonzero, share }));
  }

  // ── 8. per-quirk assertions ──
  const quirks = binding.quirks || [];
  if (quirks.includes('catalog_not_unique')) {
    // The binding CLAIMS the catalogue repeats its key. Verify the rendered
    // SQL actually collapsed it, by comparing raw catalogue rows against the
    // view's grain.
    const rawCat = await one(pool, `
      SELECT COUNT(*)::bigint AS rows,
             COUNT(DISTINCT ${binding.catalog.replenishmentKey})::bigint AS distinct_keys
        FROM ${src}.${binding.catalog.table}
       WHERE ${binding.catalog.replenishmentKey} IS NOT NULL`);
    const dedupWorked = num(rawCat.rows) >= num(rawCat.distinct_keys) && baseRows <= num(rawCat.distinct_keys);
    probes.push(probe('dedup_applied', dedupWorked,
      `catalogue has ${num(rawCat.rows).toLocaleString('en-GB')} keyed rows over ${num(rawCat.distinct_keys).toLocaleString('en-GB')} distinct keys; view has ${baseRows.toLocaleString('en-GB')} rows`,
      { catalogueRows: num(rawCat.rows), distinctKeys: num(rawCat.distinct_keys) }));
  }

  if (quirks.includes('anchor_to_demand_max_date')) {
    const anchored = await one(pool, `
      SELECT COUNT(DISTINCT data_through)::bigint AS n, MAX(data_through) AS d
        FROM ${vs}.mv_replenishment_base`);
    probes.push(probe('anchored_to_data_date', num(anchored.n) === 1 && Boolean(anchored.d),
      anchored.d
        ? `every row carries one data-through date: ${String(anchored.d).slice(0, 10)}`
        : 'no data-through date on the view — windows would be measured from the clock',
      { dataThrough: anchored.d }));
  }

  // ── 9. the supplier view, if one was built ──
  if (binding.catalog?.supplierCol) {
    const sup = await one(pool, `
      SELECT COUNT(*)::bigint AS suppliers,
             COALESCE(SUM(sku_item_count), 0)::bigint AS items
        FROM ${vs}.mv_suppliers`);
    const supplierItems = num(sup.items);
    probes.push(probe('supplier_view_covers_base', supplierItems === baseRows,
      supplierItems === baseRows
        ? `${num(sup.suppliers).toLocaleString('en-GB')} suppliers covering all ${baseRows.toLocaleString('en-GB')} rows`
        : `supplier view accounts for ${supplierItems.toLocaleString('en-GB')} rows but the base view has ${baseRows.toLocaleString('en-GB')} — rows have been lost or duplicated`,
      { suppliers: num(sup.suppliers), coveredRows: supplierItems }));
  }

  return { passed: probes.every(p => p.passed), probes };
}

module.exports = { verify };
