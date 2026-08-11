/**
 * Create indexes for the zolstock schema.
 *
 * All actual building logic lives in scripts/lib/index-builder.js — this file
 * is just the index list specific to zolstock.
 *
 * Heavy aggregation queries (revenue / profit / top items / stores / sellers by
 * period) are served by materialized views (see create-zolstock-mvs.js), not by
 * covering indexes. Indexes here cover ad-hoc lookups and the record_type+date
 * filter on the wide facts table.
 *
 * Run: node scripts/create-zolstock-indexes.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createIndexesForSchema } = require('./lib/index-builder');

const SCHEMA = 'zolstock';

const INDEXES = [
  // ── facts (~39.5M rows, wide, mixes record types) ──────────────────────────
  // Composite — workhorse filter for "record_type='מכירות' AND date BETWEEN ..."
  { name: 'idx_facts_rt_date',         table: 'facts', col: '"record_type", "transaction_date"' },
  // Standalone columns — for JOINs and ad-hoc filters not covered by MVs
  { name: 'idx_facts_transaction_date',table: 'facts', col: '"transaction_date"' },
  { name: 'idx_facts_store_number',    table: 'facts', col: '"store_number"' },
  { name: 'idx_facts_item_number',     table: 'facts', col: '"item_number"' },
  { name: 'idx_facts_seller_id',       table: 'facts', col: '"seller_id"' },
  { name: 'idx_facts_customer_number', table: 'facts', col: '"customer_number"' },
  { name: 'idx_facts_sale_id',         table: 'facts', col: '"sale_id"' },

  // ── items (303,508 rows) — bridge between item_number (used on facts) and
  //    sku (used on recommendation_facts) ─────────────────────────────────────
  { name: 'idx_items_item_number', table: 'items', col: '"item_number"' },
  { name: 'idx_items_sku',         table: 'items', col: '"sku"' },

  // ── recommendation_facts (29,450,600 rows, mixed record kinds — see
  //    column-aliases-zolstock.js) — sku is the join key back to items ────────
  { name: 'idx_recommendation_facts_sku',       table: 'recommendation_facts', col: '"sku"' },
  { name: 'idx_recommendation_facts_date',      table: 'recommendation_facts', col: '"row_date"' },
  { name: 'idx_recommendation_facts_store',     table: 'recommendation_facts', col: '"store_number"' },
];

async function createIndexes(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog
    ? (msg) => emitLog('creating_indexes', msg)
    : (msg) => console.log(msg);

  if (INDEXES.length === 0) {
    log('No zolstock indexes defined yet — skipping (fill INDEXES in create-zolstock-indexes.js).');
    if (!targetSchema) await endPool();
    return;
  }

  await createIndexesForSchema({
    pool: getPool(),
    schema,
    indexes: INDEXES,
    statementTimeoutMs: 3600000, // 60 min per index
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createIndexes().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createIndexes };
