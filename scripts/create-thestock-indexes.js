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

const INDEXES = [
  // ── facts ─────────────────────────────────────────────────────────────────
  // Composite — workhorse filter for "record_type='מכירות' AND date BETWEEN ..."
  { name: 'idx_facts_rt_date',          table: 'facts', col: '"record_type", "transaction_date"' },
  // Standalone columns — for JOINs and ad-hoc filters not covered by MVs
  { name: 'idx_facts_sku',              table: 'facts', col: '"sku"' },
  { name: 'idx_facts_transaction_date', table: 'facts', col: '"transaction_date"' },
  { name: 'idx_facts_warehouse_code',   table: 'facts', col: '"warehouse_code"' },
  { name: 'idx_facts_transaction_id',   table: 'facts', col: '"transaction_id"' },
  { name: 'idx_facts_customer_id',      table: 'facts', col: '"customer_id"' },
  { name: 'idx_facts_cashier',          table: 'facts', col: '"cashier"' },

  // ── payments (~9.8M rows) ─────────────────────────────────────────────────
  { name: 'idx_payments_transaction_id',   table: 'payments', col: '"transaction_id"' },
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
