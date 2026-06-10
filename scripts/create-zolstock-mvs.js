/**
 * Create materialized views for the zolstock schema.
 *
 * MVs precompute aggregates over zolstock.facts (~39.5M rows) so the LLM can
 * answer "top products / top stores / top sellers / revenue & profit by period"
 * questions by reading thousands of rows instead of tens of millions.
 *
 * Unlike thestock, zolstock.facts DOES carry cost (`cogs`) on the sale line, so
 * profit is precomputed directly in the MVs (no products JOIN needed for margin).
 * Revenue figures are ex-VAT (`line_total`); `*_inc_vat` include VAT.
 *
 * Building logic lives in scripts/lib/mv-builder.js; this file is just
 * the MV list specific to zolstock.
 *
 * Run: node scripts/create-zolstock-mvs.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createMVsForSchema } = require('./lib/mv-builder');

const SCHEMA = 'zolstock';

// Helper to substitute the target schema into the MV body so MVs can be
// built on either zolstock (live) or zolstock_new (shadow during reload).
function mvs(schema) {
  return [
    // ── mv_sales_daily — daily totals (~1,500 rows) ──────────────────────────
    // For "total revenue / profit this year / month / week" and trend queries.
    {
      name: 'mv_sales_daily',
      sql: `
        SELECT
          transaction_date,
          COUNT(*)                  AS line_count,
          SUM(qty_sold)             AS total_qty,
          SUM(line_total)           AS revenue_ex_vat,
          SUM(line_total_inc_vat)   AS revenue_inc_vat,
          SUM(cogs)                 AS total_cogs,
          SUM(line_total - cogs)    AS profit_ex_vat
        FROM ${schema}.facts
        WHERE record_type = 'מכירות'
        GROUP BY transaction_date
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_date', col: 'transaction_date' },
      ],
    },

    // ── mv_sales_daily_item — daily × item (~5-10M rows) ─────────────────────
    // For "top selling products by period". JOIN to a products dimension for
    // descriptions AFTER aggregating, once that file is delivered.
    {
      name: 'mv_sales_daily_item',
      sql: `
        SELECT
          transaction_date,
          item_number,
          SUM(qty_sold)             AS total_qty,
          SUM(line_total)           AS revenue_ex_vat,
          SUM(line_total_inc_vat)   AS revenue_inc_vat,
          SUM(cogs)                 AS total_cogs,
          SUM(line_total - cogs)    AS profit_ex_vat,
          COUNT(*)                  AS line_count
        FROM ${schema}.facts
        WHERE record_type = 'מכירות' AND item_number IS NOT NULL AND item_number <> ''
        GROUP BY transaction_date, item_number
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_item_date', col: 'transaction_date' },
        { name: 'idx_mv_sales_daily_item_item', col: 'item_number' },
      ],
    },

    // ── mv_sales_daily_store — daily × store (~200K rows) ────────────────────
    // For "top stores by period" and store performance trends.
    {
      name: 'mv_sales_daily_store',
      sql: `
        SELECT
          transaction_date,
          store_number,
          SUM(qty_sold)             AS total_qty,
          SUM(line_total)           AS revenue_ex_vat,
          SUM(line_total_inc_vat)   AS revenue_inc_vat,
          SUM(cogs)                 AS total_cogs,
          SUM(line_total - cogs)    AS profit_ex_vat,
          COUNT(*)                  AS line_count
        FROM ${schema}.facts
        WHERE record_type = 'מכירות' AND store_number IS NOT NULL AND store_number <> ''
        GROUP BY transaction_date, store_number
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_store_date',  col: 'transaction_date' },
        { name: 'idx_mv_sales_daily_store_store', col: 'store_number' },
      ],
    },

    // ── mv_sales_daily_seller — daily × seller (~500K rows) ──────────────────
    // For "top sellers by period". Keeps both seller_id and name. Same column
    // shape as the other sales MVs so the LLM does not trip when generalizing.
    {
      name: 'mv_sales_daily_seller',
      sql: `
        SELECT
          transaction_date,
          seller_id,
          seller,
          SUM(qty_sold)             AS total_qty,
          SUM(line_total)           AS revenue_ex_vat,
          SUM(line_total_inc_vat)   AS revenue_inc_vat,
          SUM(cogs)                 AS total_cogs,
          SUM(line_total - cogs)    AS profit_ex_vat,
          COUNT(*)                  AS line_count
        FROM ${schema}.facts
        WHERE record_type = 'מכירות' AND seller_id IS NOT NULL AND seller_id <> ''
        GROUP BY transaction_date, seller_id, seller
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_seller_date',   col: 'transaction_date' },
        { name: 'idx_mv_sales_daily_seller_seller', col: 'seller_id' },
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
    statementTimeoutMs: 3600000, // 60 min per MV — biggest aggregates over ~35M sales rows
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createMVs().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createMVs };
