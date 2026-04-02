/**
 * Create materialized views for fast queries.
 * Uses column-aliases.js to resolve actual Hebrew column names at runtime.
 * Views with missing required columns are skipped with a warning — not fatal.
 * Supports optional schemaName parameter for shadow schema reload.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { resolveColumns, col } = require('./column-aliases');

async function createViews(schemaName = 'zer4u', emitLog = null) {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });

  const client = await pool.connect();
  const s = schemaName;
  const log = (msg) => { console.log(msg); if (emitLog) emitLog('creating_views', msg); };

  try {
    log(`Creating materialized views for ${s}...`);

    // Resolve actual column names from information_schema
    const r = await resolveColumns(pool, schemaName);

    // Drop orphaned composite types left by previously aborted runs.
    await client.query(`
      DO $$ DECLARE rec RECORD;
      BEGIN
        FOR rec IN
          SELECT t.typname
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = '${s}' AND t.typtype = 'c' AND t.typname LIKE 'mv_%'
        LOOP
          EXECUTE 'DROP TYPE IF EXISTS ${s}.' || quote_ident(rec.typname) || ' CASCADE';
        END LOOP;
      END $$
    `);

    let created = 0;
    let skipped = 0;

    // Helper: check all required concepts, return missing list or null if all present
    function missing(concepts) {
      const absent = concepts.filter(c => !r[c]);
      return absent.length > 0 ? absent : null;
    }

    // Helper: run a single view creation, catch and log on error
    async function makeView(name, num, total, fn) {
      log(`[${num}/${total}] Creating ${name}...`);
      try {
        await fn();
        log(`[${num}/${total}] ${name} done`);
        created++;
      } catch (err) {
        log(`[${num}/${total}] ${name} FAILED — ${err.message}`);
        skipped++;
      }
    }

    const TOTAL = 6;

    // 1. Sales by store
    const miss1 = missing(['sales.store_id', 'stores.store_id', 'stores.store_name', 'sales.revenue']);
    if (miss1) {
      log(`[1/${TOTAL}] SKIP mv_sales_by_store — missing columns: ${miss1.join(', ')}`);
      skipped++;
    } else {
      await makeView('mv_sales_by_store', 1, TOTAL, async () => {
        await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_store CASCADE`);
        await client.query(`
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
            AND s.${col(r, 'sales.revenue')} != ''
          GROUP BY ${s}.to_int_safe(s.${col(r, 'sales.store_id')}), st.${col(r, 'stores.store_name')}
        `);
        await client.query(`CREATE INDEX ON ${s}.mv_sales_by_store (store_number)`);
        await client.query(`CREATE INDEX ON ${s}.mv_sales_by_store (total_revenue DESC)`);
      });
    }

    // 2. Sales by customer
    const miss2 = missing(['sales.customer_id', 'customers.customer_id', 'customers.customer_name', 'sales.revenue']);
    if (miss2) {
      log(`[2/${TOTAL}] SKIP mv_sales_by_customer — missing columns: ${miss2.join(', ')}`);
      skipped++;
    } else {
      await makeView('mv_sales_by_customer', 2, TOTAL, async () => {
        await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_customer CASCADE`);
        await client.query(`
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
            AND s.${col(r, 'sales.revenue')} != ''
          GROUP BY ${s}.to_int_safe(s.${col(r, 'sales.customer_id')}), c.${col(r, 'customers.customer_name')}
        `);
        await client.query(`CREATE INDEX ON ${s}.mv_sales_by_customer (customer_number)`);
        await client.query(`CREATE INDEX ON ${s}.mv_sales_by_customer (total_purchases DESC)`);
      });
    }

    // 3. Sales by product
    const miss3 = missing(['sales.item_code', 'items.item_code', 'items.item_name', 'sales.quantity', 'sales.revenue']);
    if (miss3) {
      log(`[3/${TOTAL}] SKIP mv_sales_by_product — missing columns: ${miss3.join(', ')}`);
      skipped++;
    } else {
      await makeView('mv_sales_by_product', 3, TOTAL, async () => {
        await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_product CASCADE`);
        await client.query(`
          CREATE MATERIALIZED VIEW ${s}.mv_sales_by_product AS
          SELECT
            s.${col(r, 'sales.item_code')} AS item_code,
            i.${col(r, 'items.item_name')} AS item_name,
            SUM(s.${col(r, 'sales.quantity')}::numeric) AS total_quantity,
            SUM(s.${col(r, 'sales.revenue')}::numeric) AS total_revenue
          FROM ${s}.sales s
          LEFT JOIN ${s}.items i ON s.${col(r, 'sales.item_code')} = i.${col(r, 'items.item_code')}
          WHERE s.${col(r, 'sales.quantity')} IS NOT NULL
            AND s.${col(r, 'sales.quantity')} != ''
          GROUP BY s.${col(r, 'sales.item_code')}, i.${col(r, 'items.item_name')}
        `);
        await client.query(`CREATE INDEX ON ${s}.mv_sales_by_product (item_code)`);
        await client.query(`CREATE INDEX ON ${s}.mv_sales_by_product (total_quantity DESC)`);
      });
    }

    // 4. Sales by year
    const miss4 = missing(['sales.date', 'sales.revenue', 'sales.cost']);
    if (miss4) {
      log(`[4/${TOTAL}] SKIP mv_sales_by_year — missing columns: ${miss4.join(', ')}`);
      skipped++;
    } else {
      await makeView('mv_sales_by_year', 4, TOTAL, async () => {
        await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_year CASCADE`);
        await client.query(`
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
            AND ${col(r, 'sales.revenue')} != ''
          GROUP BY sale_year
          ORDER BY sale_year
        `);
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_year_pk
          ON ${s}.mv_sales_by_year (sale_year)
        `);
      });
    }

    // 5. Sales by month
    const miss5 = missing(['sales.date', 'sales.revenue']);
    if (miss5) {
      log(`[5/${TOTAL}] SKIP mv_sales_by_month — missing columns: ${miss5.join(', ')}`);
      skipped++;
    } else {
      await makeView('mv_sales_by_month', 5, TOTAL, async () => {
        await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_month CASCADE`);
        await client.query(`
          CREATE MATERIALIZED VIEW ${s}.mv_sales_by_month AS
          SELECT
            TO_CHAR(${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}), 'YYYY-MM') AS year_month,
            EXTRACT(YEAR  FROM ${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}))::integer AS sale_year,
            EXTRACT(MONTH FROM ${s}.parse_date_ddmmyyyy(${col(r, 'sales.date')}))::integer AS sale_month,
            COUNT(*) AS transaction_count,
            SUM(${col(r, 'sales.revenue')}::numeric) AS total_revenue,
            AVG(${col(r, 'sales.revenue')}::numeric) AS avg_revenue
          FROM ${s}.sales
          WHERE ${col(r, 'sales.date')} IS NOT NULL
            AND ${col(r, 'sales.revenue')} IS NOT NULL
            AND ${col(r, 'sales.revenue')} != ''
          GROUP BY year_month, sale_year, sale_month
          ORDER BY year_month
        `);
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_month_pk
          ON ${s}.mv_sales_by_month (year_month)
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_mv_sales_by_month_year
          ON ${s}.mv_sales_by_month (sale_year)
        `);
      });
    }

    // 6. Sales by store + month
    const miss6 = missing(['sales.store_id', 'stores.store_id', 'stores.store_name', 'sales.date', 'sales.revenue']);
    if (miss6) {
      log(`[6/${TOTAL}] SKIP mv_sales_by_store_month — missing columns: ${miss6.join(', ')}`);
      skipped++;
    } else {
      await makeView('mv_sales_by_store_month', 6, TOTAL, async () => {
        await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_store_month CASCADE`);
        await client.query(`
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
            AND s.${col(r, 'sales.revenue')} != ''
          GROUP BY store_number, store_name, year_month, sale_year, sale_month
          ORDER BY store_number, year_month
        `);
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_store_month_pk
          ON ${s}.mv_sales_by_store_month (store_number, year_month)
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_mv_sales_by_store_month_year
          ON ${s}.mv_sales_by_store_month (sale_year)
        `);
      });
    }

    log(`Materialized views done: ${created} created, ${skipped} skipped`);

  } catch (error) {
    console.error('Error creating materialized views:', error.message);
    console.error(error.stack);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  createViews()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { createViews };
