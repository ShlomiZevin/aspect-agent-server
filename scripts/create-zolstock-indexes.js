/**
 * Create the derived record_type column and indexes for the zolstock schema.
 *
 * Index building itself lives in scripts/lib/index-builder.js — this file is
 * the zolstock-specific list, plus one schema step that has to happen between
 * the COPY and the indexes.
 *
 * Heavy aggregation (top items / stores, revenue, margin, trends) is served by
 * materialized views (create-zolstock-mvs.js), not by covering indexes. What is
 * indexed here are the join keys and the row-kind filter.
 *
 * Run: node scripts/create-zolstock-indexes.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createIndexesForSchema } = require('./lib/index-builder');

const SCHEMA = 'zolstock';

/**
 * The delivered fact file concatenates five kinds of row and ships NO
 * discriminator column — the kind is implied by which columns are populated.
 * Leaving that implicit is what produced silently-empty answers before: a
 * question about stock filtered on a date that inventory rows never carry, the
 * predicate could not match, and the result was indistinguishable from "your
 * business has no such records".
 *
 * So the discriminator is materialised once, at load time, as a STORED
 * generated column. It costs one table rewrite during Phase 2 and makes every
 * downstream query — including LLM-generated SQL, which is the whole product —
 * able to say `WHERE record_type = 'sales'` instead of reconstructing a
 * five-way NULL pattern it has no reason to know.
 *
 * Order matters: sales is tested first because it is 90% of the table, and
 * store_inventory before warehouse because a store-inventory row never has a
 * warehouse but the reverse test would misclassify nothing either way.
 */
const RECORD_TYPE_SQL = `
  ALTER TABLE %SCHEMA%.facts
    ADD COLUMN "record_type" TEXT
    GENERATED ALWAYS AS (
      CASE
        WHEN "qty_sold" IS NOT NULL AND "item_number_sales" IS NOT NULL THEN 'sales'
        WHEN "store_inventory_qty" IS NOT NULL                          THEN 'store_inventory'
        WHEN "warehouse" IS NOT NULL                                    THEN 'warehouse_inventory'
        WHEN "customer_order_id" IS NOT NULL                            THEN 'customer_order'
        WHEN "purchase_order_id" IS NOT NULL                            THEN 'purchase_order'
        ELSE 'unknown'
      END
    ) STORED`;

const INDEXES = [
  // ── facts (29,910,277 rows, five row kinds) ────────────────────────────────
  // Composite first: nearly every real query is "this kind of row, in this
  // date range", and sales alone is 26.9M of the table.
  { name: 'idx_facts_rt_date',        table: 'facts', col: '"record_type", "row_date"' },
  { name: 'idx_facts_row_date',       table: 'facts', col: '"row_date"' },
  { name: 'idx_facts_store_number',   table: 'facts', col: '"store_number"' },
  // The sales item key — joins items.item_number at 99.9%.
  { name: 'idx_facts_item_sales',     table: 'facts', col: '"item_number_sales"' },
  // The replenishment item key — a DIFFERENT identifier system, joins items.sku.
  { name: 'idx_facts_sku',            table: 'facts', col: '"sku"' },

  // ── items (303,508 rows) — carries the only prices in the dataset ──────────
  { name: 'idx_items_item_number',    table: 'items', col: '"item_number"' },
  { name: 'idx_items_sku',            table: 'items', col: '"sku"' },
  { name: 'idx_items_category',       table: 'items', col: '"category"' },

  // ── stores (139 rows) — tiny, but the join key earns an index for planner
  //    stability rather than for speed ──────────────────────────────────────
  { name: 'idx_stores_store_number',  table: 'stores', col: '"store_number"' },

  // ── calendar (733 rows) ────────────────────────────────────────────────────
  { name: 'idx_calendar_cal_date',    table: 'calendar', col: '"cal_date"' },
];

async function createIndexes(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog
    ? (msg) => emitLog('creating_indexes', msg)
    : (msg) => console.log(msg);

  const pool = getPool();

  // The generated column must exist BEFORE idx_facts_rt_date is built on it.
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 3600000');
    const { rows } = await client.query(
      `SELECT 1 FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'facts' AND a.attname = 'record_type'
          AND a.attnum > 0 AND NOT a.attisdropped`,
      [schema]
    );
    if (rows.length === 0) {
      const t0 = Date.now();
      log('Adding derived record_type column to facts (one table rewrite)...');
      await client.query(RECORD_TYPE_SQL.replace(/%SCHEMA%/g, schema));
      log(`record_type added in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      log('record_type already present — skipping.');
    }
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }

  await createIndexesForSchema({
    pool,
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

module.exports = { createIndexes, INDEXES, RECORD_TYPE_SQL };
