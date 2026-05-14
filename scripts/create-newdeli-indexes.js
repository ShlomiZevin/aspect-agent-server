/**
 * Create indexes for the newdeli schema.
 *
 * All actual building logic lives in scripts/lib/index-builder.js — this file
 * is just the index list specific to newdeli.
 *
 * newdeli.facts is ~3.7M rows; plain indexes are enough (no covering indexes
 * or materialized views needed).
 *
 * Run: node scripts/create-newdeli-indexes.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createIndexesForSchema } = require('./lib/index-builder');

const SCHEMA = 'newdeli';

const INDEXES = [
  // ── facts (~3.7M rows) ────────────────────────────────────────────────────
  { name: 'idx_facts_branch_id',    table: 'facts', col: '"branch_id"' },
  { name: 'idx_facts_order_date',   table: 'facts', col: '"order_date"' },
  { name: 'idx_facts_date_key',     table: 'facts', col: '"date_key"' },
  { name: 'idx_facts_order_id',     table: 'facts', col: '"order_id"' },
  { name: 'idx_facts_order_type',   table: 'facts', col: '"order_type"' },
  { name: 'idx_facts_status',       table: 'facts', col: '"status"' },
  { name: 'idx_facts_year_month',   table: 'facts', col: '"year_month"' },
  { name: 'idx_facts_hour',         table: 'facts', col: '"hour"' },
  { name: 'idx_facts_year',         table: 'facts', col: '"year"' },
  { name: 'idx_facts_branch_month', table: 'facts', col: '"branch_id", "year_month"' },
  { name: 'idx_facts_status_month', table: 'facts', col: '"status", "year_month"' },

  // ── order_items ───────────────────────────────────────────────────────────
  { name: 'idx_order_items_order_id', table: 'order_items', col: '"order_id"' },

  // ── branches ──────────────────────────────────────────────────────────────
  { name: 'idx_branches_branch_id', table: 'branches', col: '"branch_id"' },

  // ── orders_all + order_items_all + payments (POS exports) ─────────────────
  { name: 'idx_orders_all_id',      table: 'orders_all',      col: '"orderId"' },
  { name: 'idx_order_items_all_id', table: 'order_items_all', col: '"orderLineId"' },
  { name: 'idx_payments_id',        table: 'payments',        col: '"paymentId"' },
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
    statementTimeoutMs: 600000, // 10 min per index — facts is only 3.7M rows here
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createIndexes().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createIndexes };
