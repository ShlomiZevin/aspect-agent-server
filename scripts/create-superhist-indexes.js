/**
 * Create the derived line_kind column and indexes for the superhist schema.
 *
 * Index building itself lives in scripts/lib/index-builder.js — this file is
 * the superhist-specific list, plus one schema step that has to happen between
 * the COPY and the indexes.
 *
 * Run: node scripts/create-superhist-indexes.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const { createIndexesForSchema } = require('./lib/index-builder');

const SCHEMA = 'superhist';

/**
 * The delivered order-line file concatenates TWO kinds of row and ships no
 * discriminator — the kind is implied by which columns are populated.
 *
 * Measured on the first delivery: 654,370 rows, of which 634,556 are product
 * lines and 19,814 are SHIPPING rows — one per order. A shipping row has an
 * empty line id, no quantity and no price, and carries the shipping method's
 * NAME in the column where a product id belongs ("משלוח עד הבית חינם בקנייה
 * מ..."). Left implicit, that is a trap with two sharp edges: a naive
 * `COUNT(*)` overstates items sold by 3%, and a join to products silently drops
 * exactly those rows, so `SUM(line_total)` over the join is
 * short of the order totals with nothing to say why.
 *
 * So the discriminator is materialised once, at load time, as a STORED
 * generated column. Every downstream query — including the LLM-generated SQL
 * that is the whole product — can then say `WHERE line_kind = 'product'`
 * instead of reconstructing a NULL pattern it has no reason to know about.
 */
const LINE_KIND_SQL = `
  ALTER TABLE %SCHEMA%.order_lines
    ADD COLUMN "line_kind" TEXT
    GENERATED ALWAYS AS (
      CASE
        WHEN "order_line_id" IS NOT NULL AND "order_line_id" <> '' THEN 'product'
        ELSE 'shipping'
      END
    ) STORED`;

/**
 * From 2026-09-23 the source ships its own kind for non-product rows (`cshev`,
 * loaded as `extra_kind`), and it shows the two-way split above was hiding
 * money: of the 135,586 "shipping" rows, 14,041 are COUPONS (-₪604K) and 8,886
 * are free-shipping BENEFITS / cart discounts (-₪134K) — negative amounts that
 * were silently netting down "shipping income". When the column is present the
 * kind is taken from it; the old rule stays as the fallback for an older file.
 *
 *   product   — a purchased item (unchanged)
 *   shipping  — delivery charge (shipping, product_shipping)
 *   coupon    — coupon redemption, negative
 *   discount  — free-shipping benefit or cart discount, negative
 */
const LINE_KIND_WITH_EXTRA_SQL = `
  ALTER TABLE %SCHEMA%.order_lines
    ADD COLUMN "line_kind" TEXT
    GENERATED ALWAYS AS (
      CASE
        WHEN "order_line_id" IS NOT NULL AND "order_line_id" <> '' THEN 'product'
        WHEN "extra_kind" = 'coupon' THEN 'coupon'
        WHEN "extra_kind" IN ('bgfnttl', 'cartdis') THEN 'discount'
        ELSE 'shipping'
      END
    ) STORED`;

const INDEXES = [
  // ── order_lines (654,370 rows, two row kinds) ──────────────────────────────
  // Composite first: almost every real query is "product lines of these
  // orders", and the kind filter belongs in the same index as the join key.
  { name: 'idx_order_lines_kind_order', table: 'order_lines', col: '"line_kind", "order_id"' },
  { name: 'idx_order_lines_order',      table: 'order_lines', col: '"order_id"' },
  { name: 'idx_order_lines_item',       table: 'order_lines', col: '"item_id"' },

  // ── orders (19,062 rows) ───────────────────────────────────────────────────
  // Small today, but the date is what every trend question filters on and the
  // table grows by roughly 450 orders a day.
  { name: 'idx_orders_order_id',        table: 'orders', col: '"order_id"' },
  { name: 'idx_orders_date',            table: 'orders', col: '"order_date"' },
  { name: 'idx_orders_customer',        table: 'orders', col: '"customer_id"' },
  { name: 'idx_orders_status',          table: 'orders', col: '"order_status"' },

  // ── products (16,537 rows) ─────────────────────────────────────────────────
  { name: 'idx_products_item_id',       table: 'products', col: '"item_id"' },
  { name: 'idx_products_sku',           table: 'products', col: '"sku"' },

  // ── categories (110 rows) — tiny, indexed for planner stability ───────────
  { name: 'idx_categories_id',          table: 'categories', col: '"category_id"' },

  // ── calendar (367 rows) ────────────────────────────────────────────────────
  { name: 'idx_calendar_date',          table: 'calendar', col: '"date"' },
];

async function createIndexes(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog
    ? (msg) => emitLog('creating_indexes', msg)
    : (msg) => console.log(msg);

  const pool = getPool();

  // The generated column must exist BEFORE idx_order_lines_kind_order is built
  // on it.
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 3600000');
    const { rows } = await client.query(
      `SELECT 1 FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'order_lines' AND a.attname = 'line_kind'
          AND a.attnum > 0 AND NOT a.attisdropped`,
      [schema]
    );
    if (rows.length === 0) {
      const t0 = Date.now();
      const { rows: extra } = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'order_lines' AND column_name = 'extra_kind'`,
        [schema]
      );
      const sql = extra.length ? LINE_KIND_WITH_EXTRA_SQL : LINE_KIND_SQL;
      log(`Adding derived line_kind column to order_lines (one table rewrite, ${extra.length ? 'from extra_kind' : 'legacy two-way'})...`);
      await client.query(sql.replace(/%SCHEMA%/g, schema));
      log(`line_kind added in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      log('line_kind already present — skipping.');
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

module.exports = { createIndexes, INDEXES, LINE_KIND_SQL };
