/**
 * Smart Replenishment — canonical view templates.
 *
 * These are hand-verified SQL shapes, parameterized by the binding. The LLM
 * chooses which columns go into the holes; it never writes the SQL. That
 * split is decision D3 and it is what makes the generated infrastructure
 * reviewable once instead of per client.
 *
 * ── The correctness rules baked in here (ZS-2), each from a real incident ──
 *
 * 1. DEDUPE THE CATALOG BEFORE EVERY JOIN. Duplicate item rows once inflated
 *    another client's revenue by 44.6% (₪190.7M against a true ₪131.8M).
 *    Every catalog CTE below is `GROUP BY <key>` + `MAX()`, never a bare
 *    JOIN and never an untied DISTINCT ON — an untied DISTINCT ON picks an
 *    arbitrary duplicate, so the same question returns different answers
 *    depending on how the query happens to be written.
 *
 * 2. ANCHOR TO THE DEMAND MAX DATE, NEVER CURRENT_DATE. These feeds are
 *    periodic exports and can be months behind; a trailing window measured
 *    from the clock is silently empty. `data_through` is computed once in a
 *    CTE and every window is measured back from it.
 *
 * 3. TWO ITEM KEYS. Demand rows key on the sales key, stock and orders on
 *    the replenishment key, and they are NOT interchangeable — joining sales
 *    on the replenishment key returns almost nothing, which reads to a user
 *    as "this product never sold" when it sold 71,421 units. Demand is
 *    bridged through the catalog into the replenishment grain by `bridge`.
 *
 * 4. UNIQUE INDEX ON EVERY VIEW. Required for REFRESH … CONCURRENTLY;
 *    without it a refresh takes ACCESS EXCLUSIVE and blocks live queries.
 *
 * 5. NULLS LAST on value orderings. Postgres sorts NULLs FIRST on DESC, so
 *    a "top N by value" query returns blank rows at the top otherwise.
 *    (Applied by consumers; the views carry the columns that need it.)
 *
 * Rendering is a pure function of (schemaName, binding) — no DB, no clock,
 * no randomness — so the golden-DDL test can assert it byte for byte.
 */

const { isSafeIdentifier, isSafeRowFilter } = require('./binding-contract');

/** Trailing demand windows, in days. Fixed: the engine names them by length. */
const WINDOWS = [28, 90, 365];

/**
 * Guard every interpolation. The binding comes from an LLM, and while
 * binding-contract.validateBinding() already refuses unsafe identifiers,
 * this is the layer that actually builds SQL — it refuses again rather than
 * assuming an earlier check ran. Cheap, and it removes "did validation
 * happen on this path?" as a question a reviewer has to answer.
 */
function ident(value, where) {
  if (!isSafeIdentifier(value)) {
    throw new Error(`replenishment/templates: unsafe identifier for ${where}: ${JSON.stringify(value)}`);
  }
  return value;
}

function filter(value, where) {
  if (!isSafeRowFilter(value)) {
    throw new Error(`replenishment/templates: unsafe row filter for ${where}: ${JSON.stringify(value)}`);
  }
  return value || null;
}

/** `WHERE a AND b`, skipping empties — keeps rendered SQL free of `AND TRUE`. */
function where(...clauses) {
  const kept = clauses.filter(Boolean);
  return kept.length ? `WHERE ${kept.join(' AND ')}` : '';
}

/**
 * A nullable column reference: if the binding does not declare the column,
 * render a typed NULL so the view keeps a stable column list either way.
 * A view whose shape depends on the client's data completeness would make
 * every downstream consumer defensive.
 */
function optionalCol(col, alias, type, where_) {
  return col
    ? `MAX(${ident(col, where_)}) AS ${alias}`
    : `NULL::${type} AS ${alias}`;
}

// ── mv_replenishment_base ────────────────────────────────────────────────

function renderReplenishmentBase(schemas, b) {
  const s = ident(schemas.target, 'targetSchema');
  const q = ident(schemas.source, 'sourceSchema');

  const dTable = ident(b.demand.table, 'demand.table');
  const dDate = ident(b.demand.dateCol, 'demand.dateCol');
  const dQty = ident(b.demand.qtyCol, 'demand.qtyCol');
  const dKey = ident(b.demand.itemKey, 'demand.itemKey');
  const dFilter = filter(b.demand.rowFilter, 'demand.rowFilter');

  const cTable = ident(b.catalog.table, 'catalog.table');
  const cKey = ident(b.catalog.itemKey, 'catalog.itemKey');
  const rKey = ident(b.catalog.replenishmentKey, 'catalog.replenishmentKey');

  const wh = b.stock.warehouse;
  const whTable = ident(wh.table || b.demand.table, 'stock.warehouse.table');
  const whQty = ident(wh.qtyCol, 'stock.warehouse.qtyCol');
  const whKey = ident(wh.itemKey, 'stock.warehouse.itemKey');
  const whFilter = filter(wh.rowFilter, 'stock.warehouse.rowFilter');

  const st = b.stock.store;
  const onOrder = b.onOrder;
  const committed = b.committed;

  // Trailing windows, all measured back from data_through (rule 2).
  const windowCols = WINDOWS.map(n => `
           COALESCE(SUM(f.${dQty}) FILTER (
             WHERE f.${dDate} > dt.data_through - INTERVAL '${n} days'), 0) AS qty_sold_${n}d`).join(',');

  const storeCte = st ? `,
    store_stock AS (
      SELECT br.${ident(st.itemKey, 'stock.store.itemKey')} AS rkey,
             SUM(br.${ident(st.qtyCol, 'stock.store.qtyCol')}) AS store_qty_total
        FROM ${q}.${ident(st.table || b.demand.table, 'stock.store.table')} br
        ${where(filter(st.rowFilter, 'stock.store.rowFilter'), `br.${ident(st.itemKey, 'stock.store.itemKey')} IS NOT NULL`)}
       GROUP BY 1
    )` : '';

  const onOrderCte = onOrder ? `,
    on_order AS (
      SELECT o.${ident(onOrder.itemKey, 'onOrder.itemKey')} AS rkey,
             SUM(o.${ident(onOrder.qtyCol, 'onOrder.qtyCol')}) AS on_order_qty,
             COUNT(*) AS on_order_line_count,
             ${onOrder.dateCol ? `MAX(o.${ident(onOrder.dateCol, 'onOrder.dateCol')})` : 'NULL::date'} AS on_order_last_date
        FROM ${q}.${ident(onOrder.table || b.demand.table, 'onOrder.table')} o
        ${where(filter(onOrder.rowFilter, 'onOrder.rowFilter'), `o.${ident(onOrder.itemKey, 'onOrder.itemKey')} IS NOT NULL`)}
       GROUP BY 1
    )` : '';

  const committedCte = committed ? `,
    committed AS (
      SELECT c.${ident(committed.itemKey, 'committed.itemKey')} AS rkey,
             SUM(c.${ident(committed.qtyCol, 'committed.qtyCol')}) AS committed_qty
        FROM ${q}.${ident(committed.table || b.demand.table, 'committed.table')} c
        ${where(filter(committed.rowFilter, 'committed.rowFilter'), `c.${ident(committed.itemKey, 'committed.itemKey')} IS NOT NULL`)}
       GROUP BY 1
    )` : '';

  const sql = `
CREATE MATERIALIZED VIEW ${s}.mv_replenishment_base AS
  WITH data_through AS (
    SELECT MAX(${dDate}) AS data_through
      FROM ${q}.${dTable}
      ${where(dFilter)}
  ),
  -- Rule 1: dedupe the catalog. One row per replenishment key, MAX() over
  -- every attribute, never a bare JOIN.
  catalog AS (
    SELECT ${rKey} AS rkey,
           MAX(${cKey}) AS item_number,
           ${optionalCol(b.catalog.nameCol, 'item_name', 'text', 'catalog.nameCol')},
           ${optionalCol(b.catalog.categoryCol, 'category', 'text', 'catalog.categoryCol')},
           ${optionalCol(b.catalog.subcategoryCol, 'subcategory', 'text', 'catalog.subcategoryCol')},
           ${optionalCol(b.catalog.supplierCol, 'supplier', 'text', 'catalog.supplierCol')},
           ${optionalCol(b.catalog.supplierCodeCol, 'supplier_code', 'text', 'catalog.supplierCodeCol')},
           ${optionalCol(b.catalog.cartonCol, 'units_per_carton', 'numeric', 'catalog.cartonCol')},
           ${optionalCol(b.catalog.safetyCol, 'safety_stock_data', 'numeric', 'catalog.safetyCol')},
           ${optionalCol(b.catalog.priceCol, 'consumer_price', 'numeric', 'catalog.priceCol')},
           ${optionalCol(b.catalog.costCol, 'cost_ex_vat', 'numeric', 'catalog.costCol')}
      FROM ${q}.${cTable}
     WHERE ${rKey} IS NOT NULL
     GROUP BY ${rKey}
  ),
  -- Rule 3: demand keys on the SALES key; bridge it into the replenishment
  -- grain through the catalog, deduped the same way.
  bridge AS (
    SELECT ${cKey} AS item_number, MAX(${rKey}) AS rkey
      FROM ${q}.${cTable}
     WHERE ${rKey} IS NOT NULL AND ${cKey} IS NOT NULL
     GROUP BY ${cKey}
  ),
  demand AS (
    SELECT br.rkey,${windowCols},
           MIN(f.${dDate}) AS first_sold,
           MAX(f.${dDate}) AS last_sold
      FROM ${q}.${dTable} f
      JOIN bridge br ON br.item_number = f.${dKey}
     CROSS JOIN data_through dt
      ${where(dFilter)}
     GROUP BY br.rkey
  ),
  warehouse_stock AS (
    SELECT w.${whKey} AS rkey, SUM(w.${whQty}) AS warehouse_qty
      FROM ${q}.${whTable} w
      ${where(whFilter, `w.${whKey} IS NOT NULL`)}
     GROUP BY 1
  )${storeCte}${onOrderCte}${committedCte}
  SELECT c.rkey                                        AS sku,
         c.item_number,
         c.item_name,
         c.category,
         c.subcategory,
         c.supplier,
         c.supplier_code,
         c.units_per_carton,
         c.safety_stock_data,
         c.consumer_price,
         c.cost_ex_vat,
         COALESCE(ws.warehouse_qty, 0)                 AS warehouse_qty,
         ${st ? 'COALESCE(ss.store_qty_total, 0)' : '0::numeric'}       AS store_qty_total,
         ${onOrder ? 'COALESCE(oo.on_order_qty, 0)' : '0::numeric'}     AS on_order_qty,
         ${onOrder ? 'COALESCE(oo.on_order_line_count, 0)' : '0::bigint'} AS on_order_line_count,
         ${onOrder ? 'oo.on_order_last_date' : 'NULL::date'}            AS on_order_last_date,
         ${committed ? 'COALESCE(cm.committed_qty, 0)' : '0::numeric'}  AS committed_qty,
${WINDOWS.map(n => `         COALESCE(d.qty_sold_${n}d, 0)                 AS qty_sold_${n}d`).join(',\n')},
         d.first_sold,
         d.last_sold,
         dt.data_through
    FROM catalog c
   CROSS JOIN data_through dt
    LEFT JOIN demand d           ON d.rkey  = c.rkey
    LEFT JOIN warehouse_stock ws ON ws.rkey = c.rkey${st ? `
    LEFT JOIN store_stock ss     ON ss.rkey = c.rkey` : ''}${onOrder ? `
    LEFT JOIN on_order oo        ON oo.rkey = c.rkey` : ''}${committed ? `
    LEFT JOIN committed cm       ON cm.rkey = c.rkey` : ''}`.trim();

  return sql;
}

// ── mv_suppliers ─────────────────────────────────────────────────────────

/**
 * Grain: supplier. The supplier list builds itself from the data — nobody
 * types suppliers in, and a new one appears by itself on the next reload.
 *
 * Built ON TOP of mv_replenishment_base rather than re-scanning the fact
 * table: the base view is already the deduped, bridged, windowed truth, so
 * re-deriving any of it here would be a second place for the same rules to
 * drift out of step.
 */
function renderSuppliers(schemas, b) {
  const s = ident(schemas.target, 'targetSchema');
  const hasSupplier = Boolean(b.catalog.supplierCol);
  if (!hasSupplier) return null;

  return `
CREATE MATERIALIZED VIEW ${s}.mv_suppliers AS
  SELECT COALESCE(supplier, '(unattributed)')          AS supplier,
         MAX(supplier_code)                            AS supplier_code,
         COUNT(*)                                      AS sku_item_count,
         COUNT(*) FILTER (WHERE warehouse_qty > 0)     AS skus_with_stock,
         COUNT(*) FILTER (WHERE qty_sold_365d > 0)     AS skus_sold_365d,
         SUM(warehouse_qty)                            AS warehouse_units,
         SUM(warehouse_qty * COALESCE(cost_ex_vat, 0)) AS warehouse_value_ex_vat,
         SUM(qty_sold_365d)                            AS units_sold_365d,
         MAX(data_through)                             AS data_through
    FROM ${s}.mv_replenishment_base
   GROUP BY 1`.trim();
}

// ── indexes ──────────────────────────────────────────────────────────────

/**
 * Rule 4: a UNIQUE index on each view so REFRESH … CONCURRENTLY is possible.
 * Without one, a refresh takes ACCESS EXCLUSIVE and blocks every live query
 * against the view for its whole duration.
 */
function renderIndexes(schemas, b) {
  const s = ident(schemas.target, 'targetSchema');
  const out = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_replenishment_base_sku
    ON ${s}.mv_replenishment_base (sku)`,
    `CREATE INDEX IF NOT EXISTS idx_mv_replenishment_base_supplier
    ON ${s}.mv_replenishment_base (supplier)`,
  ];
  if (b.catalog.supplierCol) {
    out.push(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suppliers_supplier
    ON ${s}.mv_suppliers (supplier)`);
  }
  return out;
}

module.exports = { renderReplenishmentBase, renderSuppliers, renderIndexes, WINDOWS };
