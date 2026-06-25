/**
 * Create materialized views for the tevanaot (Teva Naot) schema.
 *
 * Teva Naot is a QlikSense star-schema export: `sales` carries only measures and a
 * synthetic composite key `warhs_cust_part_date_key` = WARHS-CUST-PART-DATE, where
 * DATE is an Excel/Qlik serial number (e.g. '11-13-55396-44890'). Resolving that key
 * (regexp + serial→date) over ~2.7M rows on every chat question is too slow, so we
 * materialize a RESOLVED line-level sales view once, with typed/indexed columns:
 *
 *   mv_sales        — one row per sales line, key resolved to transaction_date / warhs
 *                     / part / cust + measures. JOIN parts/sites/customers off this.
 *   mv_sales_daily  — daily totals (built off mv_sales) for instant revenue/trend.
 *
 * Key resolution (PG-version-safe — uses regexp, NOT split_part negative index):
 *   - DATE  = trailing digits after the last '-'  → Excel serial → DATE '1899-12-30' + n
 *   - WARHS = first '-' field (store/warehouse code; positive for POS sales)
 *   - PART  = the non-dash field immediately before the trailing date
 *   - CUST  = the pos_cust_num column (cleaner than parsing the middle of the key,
 *             which can carry a negative placeholder like -99999)
 *
 * Building logic lives in scripts/lib/mv-builder.js; this file is just the MV list.
 *
 * Run: node scripts/create-tevanaot-mvs.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createMVsForSchema } = require('./lib/mv-builder');

const SCHEMA = 'tevanaot';

function mvs(schema) {
  return [
    // ── mv_sales — resolved line-level sales (~2.7M rows) ────────────────────
    {
      name: 'mv_sales',
      sql: `
        SELECT
          CASE WHEN warhs_cust_part_date_key ~ '-[0-9]+$'
               THEN DATE '1899-12-30' + ((regexp_match(warhs_cust_part_date_key, '-([0-9]+)$'))[1])::int
               ELSE NULL END                                            AS transaction_date,
          split_part(warhs_cust_part_date_key, '-', 1)                  AS warhs,
          (regexp_match(warhs_cust_part_date_key, '-([^-]+)-[0-9]+$'))[1] AS part,
          pos_cust_num                                                  AS cust,
          invoice_number,
          invoice_type,
          vat_pct,
          sale_price,
          qty_sold,
          sales_ex_vat,
          sales_inc_vat,
          doc_discount
        FROM ${schema}.sales
      `,
      indexes: [
        { name: 'idx_mv_sales_date',    col: 'transaction_date' },
        { name: 'idx_mv_sales_part',    col: 'part' },
        { name: 'idx_mv_sales_warhs',   col: 'warhs' },
        { name: 'idx_mv_sales_invoice', col: 'invoice_number' },
      ],
    },

    // ── mv_sales_daily — daily totals (~1,500 rows), built off mv_sales ──────
    {
      name: 'mv_sales_daily',
      sql: `
        SELECT
          transaction_date,
          COUNT(*)              AS line_count,
          SUM(qty_sold)         AS total_qty,
          SUM(sales_ex_vat)     AS revenue_ex_vat,
          SUM(sales_inc_vat)    AS revenue_inc_vat
        FROM ${schema}.mv_sales
        WHERE transaction_date IS NOT NULL
        GROUP BY transaction_date
      `,
      indexes: [
        { name: 'idx_mv_sales_daily_date', col: 'transaction_date' },
      ],
    },

    // ── mv_parts_dim — ONE row per part (deduped product dimension) ──────────
    // `parts` has ~16-50 rows per `part` value (one per size), so joining it raw
    // to sales fans measures out 16-50x. This MV collapses parts to one row per
    // `part` carrying only the PART-CONSTANT attributes (model / color / gender /
    // shoe_type / season / family — size/sku/barcode are size-level and excluded).
    // Attribute breakdowns JOIN this small (~tens-of-thousands rows) dim instead
    // of running DISTINCT ON over the multi-million-row parts table every query.
    {
      name: 'mv_parts_dim',
      sql: `
        SELECT DISTINCT ON (part)
          part, model_code, model_name, model_color_code, model_color_name,
          color, color_code, shoe_type, marketing_shoe_type, product_line,
          gender, collection, season, budget_line,
          family_code, family_description, family_type, family_type_description,
          supplier_code, supplier_name, item_status, quality, variety,
          consumer_price, consumer_price_inc_vat
        FROM ${schema}.parts
        WHERE part IS NOT NULL AND part <> ''
        ORDER BY part
      `,
      indexes: [
        { name: 'idx_mv_parts_dim_part', col: 'part' },
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
    statementTimeoutMs: 3600000, // 60 min per MV
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createMVs().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createMVs };
