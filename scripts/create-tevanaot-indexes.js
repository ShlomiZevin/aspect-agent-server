/**
 * Create indexes for the tevanaot (Teva Naot) schema.
 *
 * The heavy sales aggregations are served by mv_sales / mv_sales_daily
 * (see create-tevanaot-mvs.js). Indexes here cover the dimension JOIN keys and
 * direct lookups on the raw fact/dimension tables.
 *
 * All building logic lives in scripts/lib/index-builder.js — this file is just
 * the index list specific to tevanaot.
 *
 * Run: node scripts/create-tevanaot-indexes.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createIndexesForSchema } = require('./lib/index-builder');

const SCHEMA = 'tevanaot';

const INDEXES = [
  // ── sales (~2.7M raw rows; queries normally go through mv_sales) ───────────
  { name: 'idx_sales_invoice_number', table: 'sales', col: '"invoice_number"' },
  { name: 'idx_sales_pos_cust_num',   table: 'sales', col: '"pos_cust_num"' },

  // ── parts — product master (JOIN on part; filters by attributes) ──────────
  { name: 'idx_parts_part',          table: 'parts', col: '"part"' },
  { name: 'idx_parts_sku',           table: 'parts', col: '"sku"' },
  { name: 'idx_parts_barcode',       table: 'parts', col: '"barcode"' },
  { name: 'idx_parts_model_code',    table: 'parts', col: '"model_code"' },
  { name: 'idx_parts_family_code',   table: 'parts', col: '"family_code"' },
  { name: 'idx_parts_supplier_code', table: 'parts', col: '"supplier_code"' },

  // ── inventory — current stock (BRANCH-PART key) ───────────────────────────
  { name: 'idx_inventory_key', table: 'inventory', col: '"branch_part_key"' },

  // ── inventory_in_date — stock at end-of-month (DATE-BRANCH-PART key) ───────
  { name: 'idx_inventory_in_date_key', table: 'inventory_in_date', col: '"end_month_branch_part_key"' },

  // ── orders — customer orders (PART-CUST-DATE key) ─────────────────────────
  { name: 'idx_orders_key',          table: 'orders', col: '"part_cust_date_key"' },
  { name: 'idx_orders_customer_ord', table: 'orders', col: '"customer_order"' },

  // ── customers ─────────────────────────────────────────────────────────────
  { name: 'idx_customers_customer_id', table: 'customers', col: '"customer_id"' },
  { name: 'idx_customers_cust',        table: 'customers', col: '"cust"' },

  // ── sites — store / warehouse master ──────────────────────────────────────
  { name: 'idx_sites_warhs',      table: 'sites', col: '"warhs"' },
  { name: 'idx_sites_store_code', table: 'sites', col: '"store_code"' },
  { name: 'idx_sites_branch',     table: 'sites', col: '"branch"' },

  // ── purchase_orders + suppliers ───────────────────────────────────────────
  { name: 'idx_purchase_orders_part', table: 'purchase_orders', col: '"part"' },
  { name: 'idx_purchase_orders_sup',  table: 'purchase_orders', col: '"sup"' },
  { name: 'idx_suppliers_sup',        table: 'suppliers', col: '"sup"' },

  // ── sales_rate — velocity (BRANCH-PART key) ───────────────────────────────
  { name: 'idx_sales_rate_key', table: 'sales_rate', col: '"branch_part_salesrate_key"' },
];

async function createIndexes(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog
    ? (msg) => emitLog('creating_indexes', msg)
    : (msg) => console.log(msg);

  await createIndexesForSchema({
    pool: getPool(),
    schema,
    indexes: INDEXES,
    statementTimeoutMs: 1800000, // 30 min per index
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createIndexes().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createIndexes };
