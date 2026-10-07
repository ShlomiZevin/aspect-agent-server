/**
 * Create indexes for the thestock schema.
 *
 * All actual building logic lives in scripts/lib/index-builder.js — this file
 * is just the index list specific to thestock.
 *
 * Heavy aggregation queries (top products / stores / cashiers / revenue by
 * date) are served by materialized views (see create-thestock-mvs.js), not
 * covering indexes. Indexes here cover ad-hoc lookups and JOINs.
 *
 * Run: node scripts/create-thestock-indexes.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createIndexesForSchema } = require('./lib/index-builder');

const SCHEMA = 'thestock';

// Pruned 2026-10-07. facts is 50M rows / 16 GB on db-g1-small, where every
// index costs 5-30 min of the nightly window and the index phase alone ran
// ~2h — long enough that Cloud Run regularly recycled the instance mid-run.
// Removed, with the evidence (pg_stat_user_indexes on the live schema plus
// every thestock query in slow_queries since 2026-05):
//   idx_facts_transaction_id    30 min  0 scans — payment questions join facts
//   idx_payments_transaction_id 11 min  0 scans   to payments over a whole
//                                                 month: a hash join, which
//                                                 never uses these.
//   idx_facts_customer_id       20 min  0 scans — customer questions are
//                                                 COUNT(DISTINCT) over a range.
//   idx_facts_cashier           13 min  0 scans — served by mv_sales_daily_cashier.
// If a real query needs one back, the Query Optimizer will flag it as slow.
//
// idx_facts_rt_date (record_type, transaction_date) over ALL rows was dropped
// the same day and brought back as a PARTIAL index: for sales (97% of rows)
// it adds nothing over idx_facts_transaction_date, but purchase-order lines
// (record_type IS NULL, ~7K rows), inventory snapshots ('מלאי') and targets are
// rare record types that only this index finds without scanning all 16 GB.
// Partial = only those ~1.3M rows are indexed, so it builds in minutes.
const INDEXES = [
  // ── facts ─────────────────────────────────────────────────────────────────
  // Date range — the workhorse filter for raw-facts questions MVs don't cover.
  { name: 'idx_facts_transaction_date', table: 'facts', col: '"transaction_date"' },
  // Non-sales record types (purchase orders, inventory, targets) by date.
  {
    name: 'idx_facts_rt_date_nonsales',
    table: 'facts',
    col: '"record_type", "transaction_date"',
    where: `"record_type" IS NULL OR "record_type" <> 'מכירות'`,
  },
  // SKU lookups ("how many of item X") — the most-used facts index.
  { name: 'idx_facts_sku',              table: 'facts', col: '"sku"' },
  { name: 'idx_facts_warehouse_code',   table: 'facts', col: '"warehouse_code"' },

  // ── payments (~12M rows) ──────────────────────────────────────────────────
  { name: 'idx_payments_payment_type',     table: 'payments', col: '"payment_type"' },
  { name: 'idx_payments_payment_type_code',table: 'payments', col: '"payment_type_code"' },

  // ── credits ───────────────────────────────────────────────────────────────
  { name: 'idx_credits_transaction_id', table: 'credits', col: '"transaction_id"' },

  // ── customers (~1.07M rows) ───────────────────────────────────────────────
  { name: 'idx_customers_customer_id', table: 'customers', col: '"customer_id"' },
  { name: 'idx_customers_national_id', table: 'customers', col: '"national_id"' },
  { name: 'idx_customers_city',        table: 'customers', col: '"city"' },

  // ── products ──────────────────────────────────────────────────────────────
  { name: 'idx_products_sku',             table: 'products', col: '"sku"' },
  { name: 'idx_products_barcode',         table: 'products', col: '"barcode"' },
  { name: 'idx_products_family_code',     table: 'products', col: '"family_code"' },
  { name: 'idx_products_supplier_code',   table: 'products', col: '"supplier_code"' },

  // ── warehouses ────────────────────────────────────────────────────────────
  { name: 'idx_warehouses_warehouse_code', table: 'warehouses', col: '"warehouse_code"' },
  { name: 'idx_warehouses_branch_code',    table: 'warehouses', col: '"branch_code"' },

  // ── inventory_c100 (~901K rows) ───────────────────────────────────────────
  { name: 'idx_inventory_c100_sku', table: 'inventory_c100', col: '"sku"' },

  // ── calendar / calendar_compare ───────────────────────────────────────────
  { name: 'idx_calendar_date',         table: 'calendar',         col: '"date"' },
  { name: 'idx_calendar_year_month',   table: 'calendar',         col: '"year_month"' },
  { name: 'idx_calendar_year',         table: 'calendar',         col: '"year"' },
  { name: 'idx_calendar_compare_date', table: 'calendar_compare', col: '"compare_date"' },
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
    statementTimeoutMs: 3600000, // 60 min per index — facts has 40M rows on db-g1-small
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createIndexes().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createIndexes };
