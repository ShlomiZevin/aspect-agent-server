/**
 * Create indexes for the tevanaot (Teva Naot) schema.
 *
 * Index philosophy (kept deliberately minimal — see the indexing post-mortem):
 *   - Heavy SALES aggregations are served by mv_sales / mv_sales_daily
 *     (create-tevanaot-mvs.js), which carry their OWN indexes. The raw `sales`
 *     table is never queried directly, so it needs no indexes here.
 *   - The composite synthetic keys (inventory.branch_part_key,
 *     inventory_in_date.end_month_branch_part_key, orders.part_cust_date_key,
 *     sales_rate.branch_part_salesrate_key) are NEVER equality-matched — the SQL
 *     resolves them with split_part/regexp (a scan, not a seek). A btree on the
 *     raw key is therefore useless. An index on inventory_in_date's ~5M-row
 *     long-text key in particular took ~50min+ to build and bought nothing.
 *   - Dimension tables customers (~57KB), sites (~216KB), suppliers (~178B),
 *     purchase_orders (~626KB) are tiny — Postgres hash-joins them with no index.
 *
 * What's left: only `parts` is a large dimension (~2GB CSV). It is JOINed by
 * `part` from the aggregated top-N sales result (a seek), and looked up by sku /
 * barcode for "find this product". Those three are the only indexes worth building.
 *
 * Building logic lives in scripts/lib/index-builder.js.
 * Run: node scripts/create-tevanaot-indexes.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createIndexesForSchema } = require('./lib/index-builder');

const SCHEMA = 'tevanaot';

const INDEXES = [
  // ── parts — the only large dimension (~2GB CSV) ───────────────────────────
  { name: 'idx_parts_part',    table: 'parts', col: '"part"' },     // JOIN key from mv_sales.part (top-N seek)
  { name: 'idx_parts_sku',     table: 'parts', col: '"sku"' },      // "find product by SKU"
  { name: 'idx_parts_barcode', table: 'parts', col: '"barcode"' },  // "find product by barcode"
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
    statementTimeoutMs: 1800000, // 30 min per index (parts indexes build in <2min)
    log,
  });

  if (!targetSchema) await endPool();
}

if (require.main === module) {
  createIndexes().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createIndexes };
