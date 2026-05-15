/**
 * Create materialized views for the thestock schema.
 *
 * MVs precompute aggregates over thestock.facts (~40M rows) so the LLM can
 * answer "top products / top stores / top cashiers / revenue by period"
 * questions by reading thousands of rows instead of millions.
 *
 * Building logic lives in scripts/lib/mv-builder.js; this file is just
 * the MV list specific to thestock.
 *
 * Run: node scripts/create-thestock-mvs.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createMVsForSchema } = require('./lib/mv-builder');

const SCHEMA = 'thestock';

// Helper to substitute the target schema into the MV body so MVs can be
// built on either thestock (live) or thestock_new (shadow during reload).
function mvs(schema) {
  return [
    // ── mv_sales_daily — daily totals (~1,800 rows) ──────────────────────────
    // For "total revenue this year / month / week" and trend queries.
    {
      name: 'mv_sales_daily',
      sql: `
        SELECT
          transaction_date,
          COUNT(*)                AS line_count,
          SUM(qty_sold)           AS total_qty,
          SUM(sales_ex_vat)       AS revenue_ex_vat,
          SUM(sales_inc_vat)      AS revenue_inc_vat,
          SUM(loyalty_count)      AS loyalty_count
        FROM ${schema}.facts
        WHERE record_type = 'מכירות'
        GROUP BY transaction_date
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_date', col: 'transaction_date' },
      ],
    },

    // ── mv_sales_daily_sku — daily × sku (~5-10M rows) ───────────────────────
    // For "top selling products by period". JOIN to products for descriptions
    // and cost AFTER aggregating.
    {
      name: 'mv_sales_daily_sku',
      sql: `
        SELECT
          transaction_date,
          sku,
          SUM(qty_sold)      AS total_qty,
          SUM(sales_ex_vat)  AS revenue_ex_vat,
          SUM(sales_inc_vat) AS revenue_inc_vat,
          COUNT(*)           AS line_count
        FROM ${schema}.facts
        WHERE record_type = 'מכירות' AND sku IS NOT NULL AND sku <> ''
        GROUP BY transaction_date, sku
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_sku_date', col: 'transaction_date' },
        { name: 'idx_mv_sales_daily_sku_sku',  col: 'sku' },
      ],
    },

    // ── mv_sales_daily_store — daily × warehouse (~300K rows) ────────────────
    // For "top stores by period" and store performance trends.
    {
      name: 'mv_sales_daily_store',
      sql: `
        SELECT
          transaction_date,
          warehouse_code,
          SUM(qty_sold)      AS total_qty,
          SUM(sales_ex_vat)  AS revenue_ex_vat,
          SUM(sales_inc_vat) AS revenue_inc_vat,
          COUNT(*)           AS line_count
        FROM ${schema}.facts
        WHERE record_type = 'מכירות' AND warehouse_code IS NOT NULL AND warehouse_code <> ''
        GROUP BY transaction_date, warehouse_code
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_store_date',  col: 'transaction_date' },
        { name: 'idx_mv_sales_daily_store_wh',    col: 'warehouse_code' },
      ],
    },

    // ── mv_sales_daily_cashier — daily × cashier (~900K rows) ────────────────
    // For "top cashiers by period". Same column shape as the other sales MVs
    // (total_qty / revenue_ex_vat / revenue_inc_vat / line_count) so the LLM
    // does not trip when generalizing patterns across MVs.
    {
      name: 'mv_sales_daily_cashier',
      sql: `
        SELECT
          transaction_date,
          cashier,
          SUM(qty_sold)      AS total_qty,
          SUM(sales_ex_vat)  AS revenue_ex_vat,
          SUM(sales_inc_vat) AS revenue_inc_vat,
          COUNT(*)           AS line_count
        FROM ${schema}.facts
        WHERE record_type = 'מכירות' AND cashier IS NOT NULL AND cashier <> ''
        GROUP BY transaction_date, cashier
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_cashier_date', col: 'transaction_date' },
      ],
    },
  ];
}

async function createMVs(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog
    ? (msg) => emitLog('creating_views', msg)
    : (msg) => console.log(msg);

  await createMVsForSchema({
    pool: getPool(),
    schema,
    mvs: mvs(schema),
    statementTimeoutMs: 3600000, // 60 min per MV — biggest aggregates over 40M facts
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createMVs().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createMVs };
