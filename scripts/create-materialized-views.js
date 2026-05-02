/**
 * Create materialized views for fast queries.
 * Uses column-aliases.js to resolve actual Hebrew column names at runtime.
 * Views with missing required columns are skipped with a warning — not fatal.
 * Supports optional schemaName parameter for shadow schema reload.
 *
 * All 8 views run in parallel — each gets its own DB connection from the pool.
 * Max total time = slowest single view (~17 min) instead of sum of all (~55 min).
 */

require('dotenv').config();
const { getPool } = require('../services/db.zer4u');
const { resolveColumns, col } = require('./column-aliases');

async function createViews(schemaName = 'zer4u', emitLog = null) {
  const pool = getPool({ max: 12 });

  const s = schemaName;
  const log = (msg) => { console.log(msg); if (emitLog) emitLog('creating_views', msg); };

  let created = 0;
  let skipped = 0;

  try {
    log(`Creating materialized views for ${s}...`);

    const setupClient = await pool.connect();
    try {
      // Resolve actual column names from information_schema
      const r = await resolveColumns(pool, schemaName);

      // Drop orphaned composite types left by previously aborted runs.
      await setupClient.query(`
        DO $$ DECLARE rec RECORD;
        BEGIN
          FOR rec IN
            SELECT t.typname
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = '${s}' AND t.typtype = 'c' AND t.typname LIKE 'mv_%'
              AND NOT EXISTS (
                SELECT 1 FROM pg_class c
                WHERE c.oid = t.typrelid AND c.relkind = 'm'
              )
          LOOP
            EXECUTE 'DROP TYPE IF EXISTS ${s}.' || quote_ident(rec.typname) || ' CASCADE';
          END LOOP;
        END $$
      `);

      // Helper: check all required concepts, return missing list or null if all present
      function missing(concepts) {
        const absent = concepts.filter(c => !r[c]);
        return absent.length > 0 ? absent : null;
      }

      // Helper: run a single view in its own connection (parallel-safe)
      async function makeView(name, num, total, fn, workMem = '64MB') {
        const c = await pool.connect();
        const start = Date.now();
        log(`[${num}/${total}] Creating ${name}...`);
        try {
          // Disable statement timeout: MV creation on large tables takes up to 17 min.
          await c.query(`SET statement_timeout = 0`);
          await c.query(`SET work_mem = '${workMem}'`);
          await c.query(`SET max_parallel_workers_per_gather = 0`);
          await c.query(`SET max_parallel_maintenance_workers = 0`);
          await fn(c);
          const elapsed = ((Date.now() - start) / 1000).toFixed(0);
          log(`[${num}/${total}] ${name} done — ${elapsed}s`);
          created++;
        } catch (err) {
          log(`[${num}/${total}] ${name} FAILED — ${err.message}`);
          skipped++;
        } finally {
          c.release();
        }
      }

      const TOTAL = 8;
      const tasks = [];       // run in parallel (light MVs)
      const heavyTasks = [];  // run after parallel group (heavy MVs needing more work_mem)

      // 1. Sales by store
      const miss1 = missing(['sales.store_id', 'stores.store_id', 'stores.store_name', 'sales.revenue']);
      if (miss1) {
        log(`[1/${TOTAL}] SKIP mv_sales_by_store — missing columns: ${miss1.join(', ')}`);
        skipped++;
      } else {
        tasks.push(makeView('mv_sales_by_store', 1, TOTAL, async (c) => {
          await c.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_store CASCADE`);
          await c.query(`
            CREATE MATERIALIZED VIEW ${s}.mv_sales_by_store AS
            SELECT
              ${s}.to_int_safe(s.${col(r, 'sales.store_id')}) AS store_number,
              st.${col(r, 'stores.store_name')} AS store_name,
              COUNT(*) AS transaction_count,
              SUM(s.${col(r, 'sales.revenue')}::numeric) AS total_revenue,
              AVG(s.${col(r, 'sales.revenue')}::numeric) AS avg_revenue
            FROM ${s}.sales s
            LEFT JOIN ${s}.stores st
              ON ${s}.to_int_safe(s.${col(r, 'sales.store_id')}) = ${s}.to_int_safe(st.${col(r, 'stores.store_id')})
            WHERE s.${col(r, 'sales.revenue')} IS NOT NULL
            GROUP BY ${s}.to_int_safe(s.${col(r, 'sales.store_id')}), st.${col(r, 'stores.store_name')}
          `);
          await c.query(`CREATE INDEX ON ${s}.mv_sales_by_store (store_number)`);
          await c.query(`CREATE INDEX ON ${s}.mv_sales_by_store (total_revenue DESC)`);
        }));
      }

      // 2. Sales by customer
      const miss2 = missing(['sales.customer_id', 'customers.customer_id', 'customers.customer_name', 'sales.revenue']);
      if (miss2) {
        log(`[2/${TOTAL}] SKIP mv_sales_by_customer — missing columns: ${miss2.join(', ')}`);
        skipped++;
      } else {
        tasks.push(makeView('mv_sales_by_customer', 2, TOTAL, async (c) => {
          await c.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_customer CASCADE`);
          await c.query(`
            CREATE MATERIALIZED VIEW ${s}.mv_sales_by_customer AS
            SELECT
              ${s}.to_int_safe(s.${col(r, 'sales.customer_id')}) AS customer_number,
              c.${col(r, 'customers.customer_name')} AS customer_name,
              COUNT(*) AS purchase_count,
              SUM(s.${col(r, 'sales.revenue')}::numeric) AS total_purchases
            FROM ${s}.sales s
            LEFT JOIN ${s}.customers c
              ON ${s}.to_int_safe(s.${col(r, 'sales.customer_id')}) = ${s}.to_int_safe(c.${col(r, 'customers.customer_id')})
            WHERE s.${col(r, 'sales.revenue')} IS NOT NULL
            GROUP BY ${s}.to_int_safe(s.${col(r, 'sales.customer_id')}), c.${col(r, 'customers.customer_name')}
          `);
          await c.query(`CREATE INDEX ON ${s}.mv_sales_by_customer (customer_number)`);
          await c.query(`CREATE INDEX ON ${s}.mv_sales_by_customer (total_purchases DESC)`);
        }));
      }

      // 3. Sales by product
      const miss3 = missing(['sales.item_code', 'items.item_code', 'items.item_name', 'sales.quantity', 'sales.revenue']);
      if (miss3) {
        log(`[3/${TOTAL}] SKIP mv_sales_by_product — missing columns: ${miss3.join(', ')}`);
        skipped++;
      } else {
        tasks.push(makeView('mv_sales_by_product', 3, TOTAL, async (c) => {
          await c.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_product CASCADE`);
          await c.query(`
            CREATE MATERIALIZED VIEW ${s}.mv_sales_by_product AS
            SELECT
              s.${col(r, 'sales.item_code')} AS item_code,
              i.${col(r, 'items.item_name')} AS item_name,
              SUM(s.${col(r, 'sales.quantity')}::numeric) AS total_quantity,
              SUM(s.${col(r, 'sales.revenue')}::numeric) AS total_revenue
            FROM ${s}.sales s
            LEFT JOIN ${s}.items i ON s.${col(r, 'sales.item_code')} = i.${col(r, 'items.item_code')}
            WHERE s.${col(r, 'sales.quantity')} IS NOT NULL
            GROUP BY s.${col(r, 'sales.item_code')}, i.${col(r, 'items.item_name')}
          `);
          await c.query(`CREATE INDEX ON ${s}.mv_sales_by_product (item_code)`);
          await c.query(`CREATE INDEX ON ${s}.mv_sales_by_product (total_quantity DESC)`);
        }));
      }

      // 4. Sales by year
      const miss4 = missing(['sales.date', 'sales.revenue', 'sales.cost']);
      if (miss4) {
        log(`[4/${TOTAL}] SKIP mv_sales_by_year — missing columns: ${miss4.join(', ')}`);
        skipped++;
      } else {
        tasks.push(makeView('mv_sales_by_year', 4, TOTAL, async (c) => {
          await c.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_year CASCADE`);
          await c.query(`
            CREATE MATERIALIZED VIEW ${s}.mv_sales_by_year AS
            SELECT
              EXTRACT(YEAR FROM ${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}))::integer AS sale_year,
              COUNT(*) AS transaction_count,
              SUM(${col(r, 'sales.revenue')}::numeric) AS total_revenue,
              AVG(${col(r, 'sales.revenue')}::numeric) AS avg_revenue,
              SUM(${col(r, 'sales.cost')}::numeric) AS total_cost
            FROM ${s}.sales
            WHERE ${col(r, 'sales.date')} IS NOT NULL
              AND ${col(r, 'sales.revenue')} IS NOT NULL
            GROUP BY sale_year
            ORDER BY sale_year
          `);
          await c.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_year_pk
            ON ${s}.mv_sales_by_year (sale_year)
          `);
        }));
      }

      // 5. Sales by month
      const miss5 = missing(['sales.date', 'sales.revenue', 'sales.customer_id']);
      if (miss5) {
        log(`[5/${TOTAL}] SKIP mv_sales_by_month — missing columns: ${miss5.join(', ')}`);
        skipped++;
      } else {
        tasks.push(makeView('mv_sales_by_month', 5, TOTAL, async (c) => {
          await c.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_month CASCADE`);
          await c.query(`
            CREATE MATERIALIZED VIEW ${s}.mv_sales_by_month AS
            SELECT
              TO_CHAR(${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}), 'YYYY-MM') AS year_month,
              EXTRACT(YEAR  FROM ${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}))::integer AS sale_year,
              EXTRACT(MONTH FROM ${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}))::integer AS sale_month,
              COUNT(*) AS transaction_count,
              COUNT(DISTINCT ${s}.to_int_safe(${col(r, 'sales.customer_id')})) AS customer_count,
              SUM(${col(r, 'sales.revenue')}::numeric) AS total_revenue,
              AVG(${col(r, 'sales.revenue')}::numeric) AS avg_revenue
            FROM ${s}.sales
            WHERE ${col(r, 'sales.date')} IS NOT NULL
              AND ${col(r, 'sales.revenue')} IS NOT NULL
            GROUP BY year_month, sale_year, sale_month
            ORDER BY year_month
          `);
          await c.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_month_pk
            ON ${s}.mv_sales_by_month (year_month)
          `);
          await c.query(`
            CREATE INDEX IF NOT EXISTS idx_mv_sales_by_month_year
            ON ${s}.mv_sales_by_month (sale_year)
          `);
        }));
      }

      // 6. Sales by store + month
      const miss6 = missing(['sales.store_id', 'stores.store_id', 'stores.store_name', 'sales.date', 'sales.revenue']);
      if (miss6) {
        log(`[6/${TOTAL}] SKIP mv_sales_by_store_month — missing columns: ${miss6.join(', ')}`);
        skipped++;
      } else {
        tasks.push(makeView('mv_sales_by_store_month', 6, TOTAL, async (c) => {
          await c.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_store_month CASCADE`);
          await c.query(`
            CREATE MATERIALIZED VIEW ${s}.mv_sales_by_store_month AS
            SELECT
              ${s}.to_int_safe(s.${col(r, 'sales.store_id')}) AS store_number,
              st.${col(r, 'stores.store_name')} AS store_name,
              TO_CHAR(${s}.parse_date_ddmmyyyy(s.${col(r, 'sales.date')}), 'YYYY-MM') AS year_month,
              EXTRACT(YEAR  FROM ${s}.parse_date_ddmmyyyy(s.${col(r, 'sales.date')}))::integer AS sale_year,
              EXTRACT(MONTH FROM ${s}.parse_date_ddmmyyyy(s.${col(r, 'sales.date')}))::integer AS sale_month,
              COUNT(*) AS transaction_count,
              SUM(s.${col(r, 'sales.revenue')}::numeric) AS total_revenue
            FROM ${s}.sales s
            LEFT JOIN ${s}.stores st
              ON ${s}.to_int_safe(s.${col(r, 'sales.store_id')}) = ${s}.to_int_safe(st.${col(r, 'stores.store_id')})
            WHERE s.${col(r, 'sales.date')} IS NOT NULL
              AND s.${col(r, 'sales.revenue')} IS NOT NULL
            GROUP BY store_number, store_name, year_month, sale_year, sale_month
            ORDER BY store_number, year_month
          `);
          await c.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_store_month_pk
            ON ${s}.mv_sales_by_store_month (store_number, year_month)
          `);
          await c.query(`
            CREATE INDEX IF NOT EXISTS idx_mv_sales_by_store_month_year
            ON ${s}.mv_sales_by_store_month (sale_year)
          `);
        }));
      }

      // 7. Sales by day (last 90 days)
      const miss7 = missing(['sales.date', 'sales.revenue']);
      if (miss7) {
        log(`[7/${TOTAL}] SKIP mv_sales_by_day — missing columns: ${miss7.join(', ')}`);
        skipped++;
      } else {
        tasks.push(makeView('mv_sales_by_day', 7, TOTAL, async (c) => {
          await c.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_day CASCADE`);
          await c.query(`
            CREATE MATERIALIZED VIEW ${s}.mv_sales_by_day AS
            SELECT
              ${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}) AS sale_date,
              COUNT(*) AS transaction_count,
              SUM(${col(r, 'sales.revenue')}::numeric) AS total_revenue,
              AVG(${col(r, 'sales.revenue')}::numeric) AS avg_revenue
            FROM ${s}.sales
            WHERE ${col(r, 'sales.date')} IS NOT NULL
              AND ${col(r, 'sales.revenue')} IS NOT NULL
              AND ${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}) >= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY sale_date
            ORDER BY sale_date
          `);
          await c.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_day_pk
            ON ${s}.mv_sales_by_day (sale_date)
          `);
        }));
      }

      // 8. Inventory by item
      const miss8 = missing(['sales.item_code', 'items.item_code', 'items.item_name',
        'inventory.key', 'inventory.stock', 'inventory.value', 'min_inventory.min_stock']);
      if (miss8) {
        log(`[8/${TOTAL}] SKIP mv_inventory_by_item — missing columns: ${miss8.join(', ')}`);
        skipped++;
      } else {
        // Runs after parallel group with 512MB work_mem — avoids temp file spill
        // when deduplicating 9.9M sales rows and joining 22M inventory rows
        heavyTasks.push(makeView('mv_inventory_by_item', 8, TOTAL, async (c) => {
          await c.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_inventory_by_item CASCADE`);
          await c.query(`
            CREATE MATERIALIZED VIEW ${s}.mv_inventory_by_item AS
            SELECT
              s_agg.item_code,
              MAX(i.${col(r, 'items.item_name')}) AS item_name,
              SUM(inv.${col(r, 'inventory.stock')}::numeric) AS total_stock,
              SUM(inv.${col(r, 'inventory.value')}::numeric) AS total_value,
              MIN(CASE WHEN mi.${col(r, 'min_inventory.min_stock')} IS NOT NULL
                  THEN mi.${col(r, 'min_inventory.min_stock')}::numeric END) AS min_stock
            FROM (
              SELECT DISTINCT ${col(r, 'sales.item_code')} AS item_code,
                              ${col(r, 'sales.inventory_key')} AS "InventoryKey"
              FROM ${s}.sales
              WHERE ${col(r, 'sales.item_code')} IS NOT NULL
            ) s_agg
            JOIN ${s}.inventory inv ON inv.${col(r, 'inventory.key')} = s_agg."InventoryKey"
            JOIN ${s}.items i ON i.${col(r, 'items.item_code')} = s_agg.item_code
            LEFT JOIN ${s}.min_inventory mi ON mi.${col(r, 'min_inventory.key')} = inv.${col(r, 'inventory.key')}
            GROUP BY s_agg.item_code
          `);
          await c.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_inventory_by_item_pk
            ON ${s}.mv_inventory_by_item (item_code)
          `);
          await c.query(`
            CREATE INDEX IF NOT EXISTS idx_mv_inventory_by_item_stock
            ON ${s}.mv_inventory_by_item (total_stock)
          `);
        }, '512MB'));
      }

      // Phase A: run 7 light MVs in parallel (each gets 64MB work_mem)
      log(`Starting ${tasks.length} materialized views in parallel...`);
      await Promise.all(tasks);

      // Phase B: run heavy MVs sequentially with high work_mem (512MB each)
      if (heavyTasks.length > 0) {
        log(`Starting ${heavyTasks.length} heavy materialized view(s) sequentially...`);
        for (const t of heavyTasks) await t;
      }

    } finally {
      setupClient.release();
    }

    log(`Materialized views done: ${created} created, ${skipped} skipped`);

  } catch (error) {
    console.error('Error creating materialized views:', error.message);
    console.error(error.stack);
    throw error;
  } finally {
  }
}

// Run if called directly
if (require.main === module) {
  createViews()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { createViews };
