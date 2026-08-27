/**
 * Create materialized views for the zolstock schema.
 *
 * MVs precompute aggregates over zolstock.facts (29,910,277 rows) so the LLM
 * answers "top items / top stores / revenue / margin / trend" questions by
 * reading thousands of rows instead of tens of millions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MONEY IS DERIVED HERE, AND ONLY HERE.
 *
 * The 2026-08-19 four-file delivery removed every monetary column from the fact
 * data — no line total, no cost of sales, no discount, no campaign. What
 * survives is `items.consumer_price` (populated on 99.6% of items) and
 * `items.cost_ex_vat` (98.7%). So revenue and margin are computed as
 * quantity × list price, which means:
 *
 *   THESE ARE LIST-PRICE ESTIMATES, NOT TAKINGS. They exclude discounts,
 *   promotions and any price override at the till. Column names say so
 *   (`revenue_list_ex_vat`, not `revenue`) precisely so a downstream query
 *   cannot quietly present them as actual revenue.
 *
 * VAT: verified against the delivered item master at exactly 18%
 * (26.02 / 22.05 = 1.1800). `consumer_price` is the shelf price and therefore
 * VAT-inclusive, so ex-VAT revenue divides it by 1.18 — which is what makes it
 * comparable with `cost_ex_vat` on the same row. Mixing the two bases would
 * overstate margin by roughly 18 points.
 *
 * GRAIN CHOICES, measured rather than assumed.
 *
 *   - There is NO daily-by-item view. Distinct (date, store, item) exceeds
 *     16.7M of 26.9M sales rows, so a daily item view would barely compress the
 *     base table while costing 800MB+ — that grain is what made item questions
 *     take 566 seconds and time out in chat. Monthly and lifetime views
 *     collapse the same questions to thousands of rows.
 *   - Every view is deduplicated against the item master with DISTINCT ON.
 *     1,859 item numbers repeat in `items`, contributing 4,953 extra rows — a
 *     silent 1.7% inflation on any naive join. The same defect, unnoticed,
 *     inflated hypertoy revenue by 44.6%.
 *
 * Every view carries a UNIQUE index. That is not decoration: without one,
 * `REFRESH MATERIALIZED VIEW` cannot run CONCURRENTLY, and a plain refresh
 * takes ACCESS EXCLUSIVE — a full read outage on that view for its whole
 * duration. See insights/services/mv-refresh.service.js.
 *
 * Building logic lives in scripts/lib/mv-builder.js; this file is the list.
 *
 * Run: node scripts/create-zolstock-mvs.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createMVsForSchema } = require('./lib/mv-builder');

const SCHEMA = 'zolstock';

/** Israeli VAT, confirmed against items.cost / items.cost_ex_vat. */
const VAT = '1.18';

/**
 * One deduplicated row per item, with the price fields the money columns need.
 * DISTINCT ON keeps the first row per item_number; ordering by item_number then
 * consumer_price DESC makes that choice deterministic across rebuilds rather
 * than dependent on physical row order.
 */
const ITEM_DIM = schema => `
  SELECT DISTINCT ON (item_number)
         item_number, item_name, category, subcategory, item_family,
         -- TWO supplier columns, and the obvious name is the wrong one.
         -- items.positive_supplier is the SUPPLYING COMPANY, which is what a
         -- buyer means by "ספק" and what "sales by supplier" must group by.
         -- items.supplier is the manufacturer/importer, and its Latin values
         -- are stored CHARACTER-REVERSED in the export ('GNIDART SBD' is
         -- "DBS TRADING"), so it is unusable as a name.
         -- Until now the sales views carried the manufacturer under the name
         -- `supplier`, so every "sales by supplier" answer grouped by the
         -- wrong dimension and displayed reversed text. `supplier` now means
         -- what everyone reading it assumed it meant; the old value is still
         -- available as `manufacturer` for anyone who genuinely wants it.
         positive_supplier AS supplier,
         supplier          AS manufacturer,
         sku, consumer_price, cost_ex_vat, safety_stock
    FROM ${schema}.items
   WHERE item_number IS NOT NULL
   ORDER BY item_number, consumer_price DESC NULLS LAST`;

/** Sales rows only, with money derived from the item master. */
const SALES = schema => `
  SELECT f.row_date,
         f.store_number,
         f.item_number_sales AS item_number,
         f.qty_sold,
         f.qty_sold * i.consumer_price / ${VAT}                        AS revenue_list_ex_vat,
         f.qty_sold * (i.consumer_price / ${VAT} - i.cost_ex_vat)      AS profit_list_ex_vat,
         i.item_name, i.category, i.subcategory, i.item_family,
         i.supplier, i.manufacturer, i.sku
    FROM ${schema}.facts f
    LEFT JOIN (${ITEM_DIM(schema)}) i ON i.item_number = f.item_number_sales
   WHERE f.record_type = 'sales'`;

function mvs(schema) {
  return [
    // ── mv_sales_daily — one row per day (~600) ──────────────────────────────
    // Totals and trends: "revenue this month", "how are we tracking".
    {
      name: 'mv_sales_daily',
      sql: `
        SELECT row_date,
               COUNT(*)                     AS line_count,
               SUM(qty_sold)                AS total_qty,
               SUM(revenue_list_ex_vat)     AS revenue_list_ex_vat,
               SUM(profit_list_ex_vat)      AS profit_list_ex_vat
          FROM (${SALES(schema)}) s
         GROUP BY row_date`,
      indexes: [{ name: 'uq_mv_sales_daily', col: 'row_date', unique: true }],
    },

    // ── mv_sales_daily_store — day × store (~600 × 96 ≈ 58k) ─────────────────
    {
      name: 'mv_sales_daily_store',
      sql: `
        SELECT s.row_date,
               s.store_number,
               st.store_name,
               COUNT(*)                     AS line_count,
               SUM(s.qty_sold)              AS total_qty,
               SUM(s.revenue_list_ex_vat)   AS revenue_list_ex_vat,
               SUM(s.profit_list_ex_vat)    AS profit_list_ex_vat
          FROM (${SALES(schema)}) s
          LEFT JOIN ${schema}.stores st ON st.store_number = s.store_number
         GROUP BY s.row_date, s.store_number, st.store_name`,
      indexes: [
        { name: 'uq_mv_sales_daily_store', col: 'row_date, store_number', unique: true },
        { name: 'idx_mv_sales_daily_store_store', col: 'store_number' },
      ],
    },

    // ── mv_sales_monthly_item — month × item (~20 months × 139k items) ───────
    // The view that makes item questions answerable inside chat's 15s budget.
    {
      name: 'mv_sales_monthly_item',
      sql: `
        SELECT DATE_TRUNC('month', s.row_date)::date AS month,
               s.item_number,
               MIN(s.item_name)             AS item_name,
               MIN(s.category)              AS category,
               MIN(s.subcategory)           AS subcategory,
               MIN(s.item_family)           AS item_family,
               MIN(s.supplier)              AS supplier,
               MIN(s.manufacturer)          AS manufacturer,
               MIN(s.sku)                   AS sku,
               SUM(s.qty_sold)              AS total_qty,
               SUM(s.revenue_list_ex_vat)   AS revenue_list_ex_vat,
               SUM(s.profit_list_ex_vat)    AS profit_list_ex_vat
          FROM (${SALES(schema)}) s
         WHERE s.row_date IS NOT NULL
         GROUP BY 1, 2`,
      indexes: [
        { name: 'uq_mv_sales_monthly_item', col: 'month, item_number', unique: true },
        { name: 'idx_mv_sales_monthly_item_item', col: 'item_number' },
      ],
    },

    // ── mv_sales_item_total — lifetime per item (~139k rows) ─────────────────
    // "Top 10 items by quantity / revenue" with no period filter reads this and
    // nothing else.
    {
      name: 'mv_sales_item_total',
      sql: `
        SELECT s.item_number,
               MIN(s.item_name)             AS item_name,
               MIN(s.category)              AS category,
               MIN(s.subcategory)           AS subcategory,
               MIN(s.item_family)           AS item_family,
               MIN(s.supplier)              AS supplier,
               MIN(s.manufacturer)          AS manufacturer,
               MIN(s.sku)                   AS sku,
               COUNT(*)                     AS line_count,
               MIN(s.row_date)              AS first_sold,
               MAX(s.row_date)              AS last_sold,
               SUM(s.qty_sold)              AS total_qty,
               SUM(s.revenue_list_ex_vat)   AS revenue_list_ex_vat,
               SUM(s.profit_list_ex_vat)    AS profit_list_ex_vat
          FROM (${SALES(schema)}) s
         GROUP BY s.item_number`,
      indexes: [
        { name: 'uq_mv_sales_item_total', col: 'item_number', unique: true },
        { name: 'idx_mv_sales_item_total_qty', col: 'total_qty DESC' },
      ],
    },

    // ── mv_sales_monthly_category — month × category (~20 × 47) ──────────────
    // Category and margin questions, which the old model could not answer at
    // all because no category dimension was joined.
    {
      name: 'mv_sales_monthly_category',
      sql: `
        SELECT DATE_TRUNC('month', s.row_date)::date AS month,
               COALESCE(s.category, '(ללא קטגוריה)') AS category,
               SUM(s.qty_sold)              AS total_qty,
               SUM(s.revenue_list_ex_vat)   AS revenue_list_ex_vat,
               SUM(s.profit_list_ex_vat)    AS profit_list_ex_vat
          FROM (${SALES(schema)}) s
         WHERE s.row_date IS NOT NULL
         GROUP BY 1, 2`,
      indexes: [{ name: 'uq_mv_sales_monthly_category', col: 'month, category', unique: true }],
    },

    // ── mv_store_inventory — item-level store stock (433,424 usable rows) ─────
    // Deliberately restricted to rows that carry a sku. The other 2,549,776
    // store-inventory rows have no item key and no date, so they cannot be
    // attributed to a product; including them would inflate every stock figure
    // with quantities nobody can trace. They remain in `facts` for audit.
    {
      name: 'mv_store_inventory',
      sql: `
        SELECT f.store_number,
               st.store_name,
               f.sku,
               MIN(i.item_number)           AS item_number,
               MIN(i.item_name)             AS item_name,
               MIN(i.category)              AS category,
               SUM(f.store_inventory_qty)   AS store_qty,
               MIN(i.safety_stock)          AS safety_stock
          FROM ${schema}.facts f
          LEFT JOIN (SELECT DISTINCT ON (sku) sku, item_number, item_name, category, safety_stock
                       FROM ${schema}.items WHERE sku IS NOT NULL
                      ORDER BY sku, item_number) i ON i.sku = f.sku
          LEFT JOIN ${schema}.stores st ON st.store_number = f.store_number
         WHERE f.record_type = 'store_inventory' AND f.sku IS NOT NULL
         GROUP BY f.store_number, st.store_name, f.sku`,
      indexes: [
        { name: 'uq_mv_store_inventory', col: 'store_number, sku', unique: true },
        { name: 'idx_mv_store_inventory_sku', col: 'sku' },
      ],
    },

    // ── mv_warehouse_inventory — central stock per sku (~8.9k rows) ──────────
    {
      name: 'mv_warehouse_inventory',
      sql: `
        SELECT f.sku,
               MIN(i.item_number)           AS item_number,
               MIN(i.item_name)             AS item_name,
               MIN(i.category)              AS category,
               SUM(f.warehouse_qty)         AS warehouse_qty,
               MIN(i.safety_stock)          AS safety_stock,
               MIN(i.consumer_price)        AS consumer_price,
               SUM(f.warehouse_qty * i.cost_ex_vat) AS stock_value_at_cost_ex_vat
          FROM ${schema}.facts f
          LEFT JOIN (SELECT DISTINCT ON (sku) sku, item_number, item_name, category, safety_stock,
                            consumer_price, cost_ex_vat
                       FROM ${schema}.items WHERE sku IS NOT NULL
                      ORDER BY sku, item_number) i ON i.sku = f.sku
         WHERE f.record_type = 'warehouse_inventory'
         GROUP BY f.sku`,
      indexes: [{ name: 'uq_mv_warehouse_inventory', col: 'sku', unique: true }],
    },

    // ── mv_open_orders — customer and purchase orders (~12k rows) ────────────
    // Both order kinds in one view with an `order_kind` discriminator, because
    // every question about them ("what is on order", "what is due in") wants
    // them side by side.
    {
      name: 'mv_open_orders',
      sql: `
        SELECT 'customer'::text          AS order_kind,
               f.customer_order_id       AS order_id,
               f.row_date,
               f.sku,
               f.store_number,
               f.priority_customer_number,
               SUM(f.customer_order_qty) AS qty
          FROM ${schema}.facts f
         WHERE f.record_type = 'customer_order'
         GROUP BY 1, 2, 3, 4, 5, 6
        UNION ALL
        SELECT 'purchase'::text,
               f.purchase_order_id,
               f.row_date,
               f.sku,
               NULL::text,
               NULL::text,
               SUM(f.purchase_order_qty)
          FROM ${schema}.facts f
         WHERE f.record_type = 'purchase_order'
         GROUP BY 1, 2, 3, 4, 5, 6`,
      indexes: [
        { name: 'uq_mv_open_orders', col: 'order_kind, order_id, row_date, sku, store_number, priority_customer_number', unique: true },
        { name: 'idx_mv_open_orders_sku', col: 'sku' },
      ],
    },
  ];
}

async function createMVs(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog
    ? (msg) => emitLog('creating_mvs', msg)
    : (msg) => console.log(msg);

  await createMVsForSchema({
    pool: getPool(),
    schema,
    mvs: mvs(schema),
    statementTimeoutMs: 3600000, // 60 min per view
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createMVs().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createMVs, mvs, VAT };
