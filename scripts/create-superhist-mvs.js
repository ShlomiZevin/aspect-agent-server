/**
 * Create materialized views for the superhist schema.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE MONEY MEANS HERE, measured on the first delivery (2026-09-02).
 *
 * REVENUE IS WHAT MEMBERS PAID. A line's total is exactly quantity x unit
 * price, on all 634,556 product lines, and an order's total is the sum of its
 * line totals plus shipping on 19,045 of 19,062 orders. So the line total is
 * the charge, and it needs no derivation — unlike zolstock, nothing here is a
 * list-price estimate.
 *
 * SUBSIDY IS NOT A DISCOUNT. It is the Histadrut's contribution — the value of
 * the member benefit — and it is NOT deducted from what the member pays.
 * Verified: subtracting it from line totals reconciles with the order total on
 * 12 of 19,062 orders, versus 19,045 when it is left alone. It is carried as
 * its own measure (`subsidy`) so "how much did the union fund" is answerable,
 * and it must never be subtracted from revenue.
 *
 * SHIPPING IS A SEPARATE ROW KIND. One per order, no product, no quantity.
 * Every view below reads `line_kind = 'product'`; shipping is aggregated on its
 * own in mv_orders_daily so "revenue" never silently includes delivery fees.
 *
 * VAT: the delivered `tax` column is 0.0000 on all 654,370 lines, so nothing
 * here can be split into ex-VAT and inc-VAT. Prices are as charged. Column
 * names say `_inc_vat` to stop a downstream query presenting them as ex-VAT
 * figures comparable with another client's.
 *
 * NO PRODUCT CATEGORY VIEW, deliberately. `products.category_id` is populated
 * on 547 of 16,537 products (3.3%) and every one of them points at a SINGLE id;
 * the categories file is 110 marketing collections ("חגיגת שבועות"), not a
 * taxonomy. A "sales by category" view would answer a question the data cannot
 * support. The dataset manifest refuses it instead.
 *
 * Every view carries a UNIQUE index. Not decoration: without one, REFRESH
 * MATERIALIZED VIEW cannot run CONCURRENTLY, and a plain refresh takes ACCESS
 * EXCLUSIVE — a full read outage on that view for its whole duration.
 *
 * Building logic lives in scripts/lib/mv-builder.js; this file is the list.
 *
 * Run: node scripts/create-superhist-mvs.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createMVsForSchema } = require('./lib/mv-builder');

const SCHEMA = 'superhist';

/**
 * One deduplicated row per item.
 *
 * DISTINCT ON keeps one row per item_id; ordering by item_id then updated_at
 * DESC makes the choice deterministic across rebuilds rather than dependent on
 * physical row order. The same defect, unnoticed, inflated hypertoy revenue by
 * 44.6% — a duplicated dimension row multiplies every fact it joins.
 */
// catalogue_price (מחיר מוצר) was DROPPED from the export on 2026-09-23 and
// must not be named here — an MV that references a missing column fails the
// whole Phase 2, which is exactly how that night's reload broke.
const ITEM_DIM = schema => `
  SELECT DISTINCT ON (item_id)
         item_id, item_name, sku, stock_qty,
         supplier_name, unit_cost,
         catalogue_subsidy, view_count, product_status
    FROM ${schema}.products
   WHERE item_id IS NOT NULL
   ORDER BY item_id, updated_at DESC NULLS LAST`;

/**
 * Order totals, derived from the lines. The export dropped its own order-total
 * column on 2026-09-23, so it is rebuilt here: every line of the order —
 * products, shipping, and the NEGATIVE coupon and discount lines — which is
 * what the member actually paid.
 */
const ORDER_TOTALS = schema => `
  SELECT order_id, SUM(line_total) AS order_total
    FROM ${schema}.order_lines
   GROUP BY order_id`;

/**
 * Product lines joined to their order and the item master.
 *
 * The date lives on the ORDER, not the line, so every time-based measure has to
 * come through this join — there is no date on the fact table itself.
 *
 * GROSS PROFIT follows the client's own Qlik formula exactly (Measures file,
 * "Profit / רווח גולמי"): SUM(line_total - line_cost). Subsidy is NOT added —
 * so on subsidised items it is routinely negative (27% of product lines sell
 * below cost in the 2026-09-23 delivery). That is the client's definition;
 * matching it is what lets our number reconcile with their dashboard.
 */
const SALES = schema => `
  SELECT o.order_date,
         l.order_id,
         o.customer_id,
         o.order_status,
         o.payment_method,
         o.shipping_method,
         l.item_id,
         l.quantity,
         l.line_total                          AS revenue_inc_vat,
         l.line_cost                           AS cost,
         l.line_total - l.line_cost            AS gross_profit,
         l.subsidy                             AS subsidy,
         i.item_name, i.sku, i.supplier_name
    FROM ${schema}.order_lines l
    JOIN ${schema}.orders o ON o.order_id = l.order_id
    LEFT JOIN (${ITEM_DIM(schema)}) i ON i.item_id = l.item_id
   WHERE l.line_kind = 'product'`;

function mvs(schema) {
  return [
    // ── mv_orders_daily — one row per day ────────────────────────────────────
    // The headline view: "revenue this week", "how many orders yesterday".
    // Shipping is summed SEPARATELY from product revenue, so neither can hide
    // inside the other.
    {
      name: 'mv_orders_daily',
      sql: `
        SELECT o.order_date,
               COUNT(DISTINCT o.order_id)                          AS order_count,
               COUNT(DISTINCT o.customer_id)                       AS customer_count,
               COALESCE(SUM(k.order_total), 0)                     AS order_total_inc_vat,
               COALESCE(SUM(k.product_revenue), 0)                 AS product_revenue_inc_vat,
               COALESCE(SUM(k.cost), 0)                            AS cost,
               COALESCE(SUM(k.gross_profit), 0)                    AS gross_profit,
               COALESCE(SUM(k.subsidy), 0)                         AS subsidy,
               COALESCE(SUM(k.units), 0)                           AS units,
               COALESCE(SUM(k.shipping_total), 0)                  AS shipping_inc_vat,
               COALESCE(SUM(k.coupon_total), 0)                    AS coupons,
               COALESCE(SUM(k.discount_total), 0)                  AS discounts,
               COUNT(DISTINCT o.order_id) FILTER (WHERE k.coupon_total <> 0) AS orders_with_coupon
          FROM ${schema}.orders o
          LEFT JOIN (
            SELECT order_id,
                   SUM(line_total)                                          AS order_total,
                   SUM(line_total) FILTER (WHERE line_kind = 'product')     AS product_revenue,
                   SUM(line_cost)  FILTER (WHERE line_kind = 'product')     AS cost,
                   SUM(line_total - line_cost) FILTER (WHERE line_kind = 'product') AS gross_profit,
                   SUM(subsidy)    FILTER (WHERE line_kind = 'product')     AS subsidy,
                   SUM(quantity)   FILTER (WHERE line_kind = 'product')     AS units,
                   SUM(line_total) FILTER (WHERE line_kind = 'shipping')    AS shipping_total,
                   SUM(line_total) FILTER (WHERE line_kind = 'coupon')      AS coupon_total,
                   SUM(line_total) FILTER (WHERE line_kind = 'discount')    AS discount_total
              FROM ${schema}.order_lines
             GROUP BY order_id
          ) k ON k.order_id = o.order_id
         WHERE o.order_date IS NOT NULL
         GROUP BY o.order_date`,
      indexes: [{ name: 'uq_mv_orders_daily', col: 'order_date', unique: true }],
    },

    // ── mv_sales_daily_item — day x item ─────────────────────────────────────
    // Top sellers over any window. The delivery is 42 days x 3,202 sold items,
    // so this stays small; revisit the grain if the history ever reaches years.
    {
      name: 'mv_sales_daily_item',
      sql: `
        SELECT order_date,
               item_id,
               MAX(item_name)               AS item_name,
               MAX(sku)                     AS sku,
               MAX(supplier_name)           AS supplier_name,
               COUNT(DISTINCT order_id)     AS order_count,
               SUM(quantity)                AS units,
               SUM(revenue_inc_vat)         AS revenue_inc_vat,
               SUM(cost)                    AS cost,
               SUM(gross_profit)            AS gross_profit,
               SUM(subsidy)                 AS subsidy
          FROM (${SALES(schema)}) s
         WHERE order_date IS NOT NULL AND item_id IS NOT NULL
         GROUP BY order_date, item_id`,
      indexes: [{ name: 'uq_mv_sales_daily_item', col: 'order_date, item_id', unique: true }],
    },

    // ── mv_sales_item — lifetime per item ────────────────────────────────────
    // "Best sellers", "what did we never sell". Carries catalogue stock so the
    // stock-versus-demand question does not need a second join.
    //
    // FULL OUTER JOIN, not a LEFT JOIN from the catalogue. Measured on the
    // first load: 141 of the 1,481 items that actually sold have NO row in the
    // products file — ₪706,753 across 46,768 lines, 8% of all revenue. Starting
    // from the catalogue dropped every one of them, so "top sellers" would have
    // been quietly missing items with 3,207 lines against them. Both sides are
    // kept and `in_catalogue` says which is which, because an item that sells
    // and is not in the catalogue is a fact worth surfacing, not one to hide.
    {
      name: 'mv_sales_item',
      sql: `
        WITH sold AS (
          SELECT item_id,
                 COUNT(DISTINCT order_id)  AS order_count,
                 SUM(quantity)             AS units,
                 SUM(revenue_inc_vat)      AS revenue_inc_vat,
                 SUM(cost)                 AS cost,
                 SUM(gross_profit)         AS gross_profit,
                 SUM(subsidy)              AS subsidy,
                 MIN(order_date)           AS first_sold,
                 MAX(order_date)           AS last_sold
            FROM (${SALES(schema)}) s
           WHERE item_id IS NOT NULL
           GROUP BY item_id
        )
        SELECT COALESCE(i.item_id, sold.item_id)     AS item_id,
               i.item_name,
               i.sku,
               i.supplier_name,
               i.stock_qty,
               i.unit_cost,
               i.catalogue_subsidy,
               i.view_count,
               (i.item_id IS NOT NULL)               AS in_catalogue,
               COALESCE(sold.order_count, 0)         AS order_count,
               COALESCE(sold.units, 0)               AS units,
               COALESCE(sold.revenue_inc_vat, 0)     AS revenue_inc_vat,
               COALESCE(sold.cost, 0)                AS cost,
               COALESCE(sold.gross_profit, 0)        AS gross_profit,
               COALESCE(sold.subsidy, 0)             AS subsidy,
               sold.first_sold,
               sold.last_sold
          FROM (${ITEM_DIM(schema)}) i
          FULL OUTER JOIN sold ON sold.item_id = i.item_id`,
      indexes: [{ name: 'uq_mv_sales_item', col: 'item_id', unique: true }],
    },

    // ── mv_customers — one row per member ────────────────────────────────────
    // 15,881 members over 19,062 orders: repeat rate is the question this
    // client will ask first, and it needs no fact scan to answer.
    {
      name: 'mv_customers',
      sql: `
        SELECT o.customer_id,
               COUNT(DISTINCT o.order_id)   AS order_count,
               SUM(t.order_total)           AS spend_inc_vat,
               MIN(o.order_date)            AS first_order,
               MAX(o.order_date)            AS last_order
          FROM ${schema}.orders o
          LEFT JOIN (${ORDER_TOTALS(schema)}) t ON t.order_id = o.order_id
         WHERE o.customer_id IS NOT NULL
         GROUP BY o.customer_id`,
      indexes: [{ name: 'uq_mv_customers', col: 'customer_id', unique: true }],
    },

    // ── mv_sales_daily_supplier — day x supplier ─────────────────────────────
    // Added 2026-09-23 with the supplier and cost columns. Supplier is filled
    // on every item that has sold, so this covers 100% of product revenue; the
    // '(unknown)' bucket exists for the day an unmapped item first sells, not
    // because it is expected to be large.
    {
      name: 'mv_sales_daily_supplier',
      sql: `
        SELECT order_date,
               COALESCE(NULLIF(supplier_name, ''), '(unknown)') AS supplier_name,
               COUNT(DISTINCT order_id)     AS order_count,
               COUNT(DISTINCT item_id)      AS item_count,
               SUM(quantity)                AS units,
               SUM(revenue_inc_vat)         AS revenue_inc_vat,
               SUM(cost)                    AS cost,
               SUM(gross_profit)            AS gross_profit,
               SUM(subsidy)                 AS subsidy
          FROM (${SALES(schema)}) s
         WHERE order_date IS NOT NULL
         GROUP BY order_date, COALESCE(NULLIF(supplier_name, ''), '(unknown)')`,
      indexes: [{ name: 'uq_mv_sales_daily_supplier', col: 'order_date, supplier_name', unique: true }],
    },

    // ── mv_orders_by_status — day x status ───────────────────────────────────
    // Both status columns, side by side and both named, because they disagree
    // on 7,176 of 19,062 orders. A view that silently picked one would make
    // "how many completed" answerable two ways with no way to tell which
    // arrived.
    {
      name: 'mv_orders_by_status',
      sql: `
        SELECT o.order_date,
               COALESCE(o.order_status, '(none)')   AS order_status,
               COALESCE(o.display_status, '(none)') AS display_status,
               COUNT(*)                             AS order_count,
               SUM(t.order_total)                   AS order_total_inc_vat
          FROM ${schema}.orders o
          LEFT JOIN (${ORDER_TOTALS(schema)}) t ON t.order_id = o.order_id
         WHERE o.order_date IS NOT NULL
         GROUP BY o.order_date, COALESCE(o.order_status, '(none)'), COALESCE(o.display_status, '(none)')`,
      indexes: [{
        name: 'uq_mv_orders_by_status',
        col: 'order_date, order_status, display_status',
        unique: true,
      }],
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

module.exports = { createMVs, mvs };
