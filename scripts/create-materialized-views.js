/**
 * Create materialized views for fast queries
 * Supports optional schemaName parameter for shadow schema reload
 */

require('dotenv').config();
const { Pool } = require('pg');

async function createViews(schemaName = 'zer4u') {
  // Pool created inside function so multiple sequential calls are safe
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });

  const client = await pool.connect();
  const s = schemaName;

  try {
    console.log(`🔧 Creating materialized views for ${s}...\n`);

    // 1. Sales by store
    console.log('1. Creating mv_sales_by_store...');
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_store CASCADE`);
    await client.query(`
      CREATE MATERIALIZED VIEW ${s}.mv_sales_by_store AS
      SELECT
        s."מס.חנות SALES"::integer as store_number,
        st."שם חנות" as store_name,
        COUNT(*) as transaction_count,
        SUM(s."מכירה ללא מע""מ"::numeric) as total_revenue,
        AVG(s."מכירה ללא מע""מ"::numeric) as avg_revenue
      FROM ${s}.sales s
      LEFT JOIN ${s}.stores st ON s."מס.חנות SALES"::integer = st."מס.חנות"
      WHERE s."מכירה ללא מע""מ" IS NOT NULL
      GROUP BY s."מס.חנות SALES", st."שם חנות"
    `);
    await client.query(`CREATE INDEX ON ${s}.mv_sales_by_store (store_number)`);
    await client.query(`CREATE INDEX ON ${s}.mv_sales_by_store (total_revenue DESC)`);
    console.log('  ✅ Done\n');

    // 2. Sales by customer
    console.log('2. Creating mv_sales_by_customer...');
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_customer CASCADE`);
    await client.query(`
      CREATE MATERIALIZED VIEW ${s}.mv_sales_by_customer AS
      SELECT
        s."מס.לקוח"::integer as customer_number,
        c."שם לקוח" as customer_name,
        COUNT(*) as purchase_count,
        SUM(s."מכירה ללא מע""מ"::numeric) as total_purchases
      FROM ${s}.sales s
      LEFT JOIN ${s}.customers c ON s."מס.לקוח"::integer = c."מס.לקוח"
      WHERE s."מכירה ללא מע""מ" IS NOT NULL
      GROUP BY s."מס.לקוח", c."שם לקוח"
    `);
    await client.query(`CREATE INDEX ON ${s}.mv_sales_by_customer (customer_number)`);
    await client.query(`CREATE INDEX ON ${s}.mv_sales_by_customer (total_purchases DESC)`);
    console.log('  ✅ Done\n');

    // 3. Sales by product
    console.log('3. Creating mv_sales_by_product...');
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_product CASCADE`);
    await client.query(`
      CREATE MATERIALIZED VIEW ${s}.mv_sales_by_product AS
      SELECT
        s."קוד פריט SALES" as item_code,
        i."שם פריט" as item_name,
        SUM(s."כמות ברמת שורה"::numeric) as total_quantity,
        SUM(s."מכירה ללא מע""מ"::numeric) as total_revenue
      FROM ${s}.sales s
      LEFT JOIN ${s}.items i ON s."קוד פריט SALES" = i."קוד פריט"
      WHERE s."כמות ברמת שורה" IS NOT NULL
      GROUP BY s."קוד פריט SALES", i."שם פריט"
    `);
    await client.query(`CREATE INDEX ON ${s}.mv_sales_by_product (item_code)`);
    await client.query(`CREATE INDEX ON ${s}.mv_sales_by_product (total_quantity DESC)`);
    console.log('  ✅ Done\n');

    // 4. Sales by year (requires parse_date_ddmmyyyy from createIndexes)
    console.log('4. Creating mv_sales_by_year...');
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_year CASCADE`);
    await client.query(`
      CREATE MATERIALIZED VIEW ${s}.mv_sales_by_year AS
      SELECT
        EXTRACT(YEAR FROM ${s}.parse_date_ddmmyyyy("תאריך מקורי SALES"))::integer AS sale_year,
        COUNT(*) AS transaction_count,
        SUM("מכירה ללא מע""מ"::numeric) AS total_revenue,
        AVG("מכירה ללא מע""מ"::numeric) AS avg_revenue,
        SUM("עלות ללא מע""מ"::numeric) AS total_cost
      FROM ${s}.sales
      WHERE "תאריך מקורי SALES" IS NOT NULL
        AND "מכירה ללא מע""מ" IS NOT NULL
        AND "מכירה ללא מע""מ" != ''
      GROUP BY sale_year
      ORDER BY sale_year
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_year_pk
      ON ${s}.mv_sales_by_year (sale_year)
    `);
    console.log('  ✅ Done\n');

    // 5. Sales by month
    console.log('5. Creating mv_sales_by_month...');
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_month CASCADE`);
    await client.query(`
      CREATE MATERIALIZED VIEW ${s}.mv_sales_by_month AS
      SELECT
        TO_CHAR(${s}.parse_date_ddmmyyyy("תאריך מקורי SALES"), 'YYYY-MM') AS year_month,
        EXTRACT(YEAR  FROM ${s}.parse_date_ddmmyyyy("תאריך מקורי SALES"))::integer AS sale_year,
        EXTRACT(MONTH FROM ${s}.parse_date_ddmmyyyy("תאריך מקורי SALES"))::integer AS sale_month,
        COUNT(*) AS transaction_count,
        SUM("מכירה ללא מע""מ"::numeric) AS total_revenue,
        AVG("מכירה ללא מע""מ"::numeric) AS avg_revenue
      FROM ${s}.sales
      WHERE "תאריך מקורי SALES" IS NOT NULL
        AND "מכירה ללא מע""מ" IS NOT NULL
        AND "מכירה ללא מע""מ" != ''
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
    console.log('  ✅ Done\n');

    // 6. Sales by store + month
    console.log('6. Creating mv_sales_by_store_month...');
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${s}.mv_sales_by_store_month CASCADE`);
    await client.query(`
      CREATE MATERIALIZED VIEW ${s}.mv_sales_by_store_month AS
      SELECT
        ${s}.to_int_safe(s."מס.חנות SALES") AS store_number,
        st."שם חנות" AS store_name,
        TO_CHAR(${s}.parse_date_ddmmyyyy(s."תאריך מקורי SALES"), 'YYYY-MM') AS year_month,
        EXTRACT(YEAR  FROM ${s}.parse_date_ddmmyyyy(s."תאריך מקורי SALES"))::integer AS sale_year,
        EXTRACT(MONTH FROM ${s}.parse_date_ddmmyyyy(s."תאריך מקורי SALES"))::integer AS sale_month,
        COUNT(*) AS transaction_count,
        SUM(s."מכירה ללא מע""מ"::numeric) AS total_revenue
      FROM ${s}.sales s
      LEFT JOIN ${s}.stores st
        ON ${s}.to_int_safe(s."מס.חנות SALES") = st."מס.חנות"
      WHERE s."תאריך מקורי SALES" IS NOT NULL
        AND s."מכירה ללא מע""מ" IS NOT NULL
        AND s."מכירה ללא מע""מ" != ''
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
    console.log('  ✅ Done\n');

    console.log('✅ All 6 materialized views created!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
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
