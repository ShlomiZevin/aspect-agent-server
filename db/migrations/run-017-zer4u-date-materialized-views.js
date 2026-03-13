/**
 * Migration 017: Add date-based materialized views for Zer4U
 *
 * Creates pre-aggregated views for fast time-based queries:
 *   - mv_sales_by_month  → "sales for 2025", "sales by month", "monthly trend"
 *   - mv_sales_by_year   → "total sales for 2025", "year over year"
 *   - mv_sales_by_store_month → "store performance per month"
 *
 * Without these views, time-range aggregations on 9.5M rows timeout.
 *
 * Requires Cloud SQL Proxy running:
 *   cloud-sql-proxy.exe aspect-agents:europe-west1:aspect-agents-db --port=5432
 *
 * Usage:
 *   node db/migrations/run-017-zer4u-date-materialized-views.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DB_HOST_PROXY
    ? {
        host: process.env.DB_HOST_PROXY,
        port: parseInt(process.env.DB_PORT_PROXY || '5432', 10),
        database: process.env.DB_NAME || 'agents_platform_db',
        user: process.env.DB_USER || 'agent_admin',
        password: process.env.DB_PASSWORD,
      }
    : { connectionString: process.env.DATABASE_URL }
);

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running migration 017: Zer4U date materialized views...');

    // ─── mv_sales_by_year ───────────────────────────────────────────────────
    console.log('\n1. Creating mv_sales_by_year...');
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS zer4u.mv_sales_by_year AS
      SELECT
        EXTRACT(YEAR FROM zer4u.parse_date_ddmmyyyy("תאריך מקורי SALES"))::integer AS sale_year,
        COUNT(*)                                                          AS transaction_count,
        SUM("מכירה ללא מע""מ"::numeric)                                   AS total_revenue,
        AVG("מכירה ללא מע""מ"::numeric)                                   AS avg_revenue,
        SUM("עלות ללא מע""מ"::numeric)                                    AS total_cost
      FROM zer4u.sales
      WHERE "תאריך מקורי SALES" IS NOT NULL
        AND "מכירה ללא מע""מ" IS NOT NULL
        AND "מכירה ללא מע""מ" != ''
      GROUP BY sale_year
      ORDER BY sale_year
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_year_pk
      ON zer4u.mv_sales_by_year (sale_year)
    `);
    console.log('   ✅ mv_sales_by_year created');

    // ─── mv_sales_by_month ──────────────────────────────────────────────────
    console.log('\n2. Creating mv_sales_by_month...');
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS zer4u.mv_sales_by_month AS
      SELECT
        TO_CHAR(zer4u.parse_date_ddmmyyyy("תאריך מקורי SALES"), 'YYYY-MM') AS year_month,
        EXTRACT(YEAR  FROM zer4u.parse_date_ddmmyyyy("תאריך מקורי SALES"))::integer AS sale_year,
        EXTRACT(MONTH FROM zer4u.parse_date_ddmmyyyy("תאריך מקורי SALES"))::integer AS sale_month,
        COUNT(*)                                                              AS transaction_count,
        SUM("מכירה ללא מע""מ"::numeric)                                       AS total_revenue,
        AVG("מכירה ללא מע""מ"::numeric)                                       AS avg_revenue
      FROM zer4u.sales
      WHERE "תאריך מקורי SALES" IS NOT NULL
        AND "מכירה ללא מע""מ" IS NOT NULL
        AND "מכירה ללא מע""מ" != ''
      GROUP BY year_month, sale_year, sale_month
      ORDER BY year_month
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_month_pk
      ON zer4u.mv_sales_by_month (year_month)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mv_sales_by_month_year
      ON zer4u.mv_sales_by_month (sale_year)
    `);
    console.log('   ✅ mv_sales_by_month created');

    // ─── mv_sales_by_store_month ────────────────────────────────────────────
    console.log('\n3. Creating mv_sales_by_store_month...');
    await client.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS zer4u.mv_sales_by_store_month AS
      SELECT
        zer4u.to_int_safe(s."מס.חנות SALES")                                  AS store_number,
        st."שם חנות"                                                           AS store_name,
        TO_CHAR(zer4u.parse_date_ddmmyyyy(s."תאריך מקורי SALES"), 'YYYY-MM')  AS year_month,
        EXTRACT(YEAR  FROM zer4u.parse_date_ddmmyyyy(s."תאריך מקורי SALES"))::integer AS sale_year,
        EXTRACT(MONTH FROM zer4u.parse_date_ddmmyyyy(s."תאריך מקורי SALES"))::integer AS sale_month,
        COUNT(*)                                                               AS transaction_count,
        SUM(s."מכירה ללא מע""מ"::numeric)                                      AS total_revenue
      FROM zer4u.sales s
      LEFT JOIN zer4u.stores st
        ON zer4u.to_int_safe(s."מס.חנות SALES") = st."מס.חנות"
      WHERE s."תאריך מקורי SALES" IS NOT NULL
        AND s."מכירה ללא מע""מ" IS NOT NULL
        AND s."מכירה ללא מע""מ" != ''
      GROUP BY store_number, store_name, year_month, sale_year, sale_month
      ORDER BY store_number, year_month
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_sales_by_store_month_pk
      ON zer4u.mv_sales_by_store_month (store_number, year_month)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mv_sales_by_store_month_year
      ON zer4u.mv_sales_by_store_month (sale_year)
    `);
    console.log('   ✅ mv_sales_by_store_month created');

    // ─── Row counts ──────────────────────────────────────────────────────────
    const yearCount  = await client.query('SELECT COUNT(*) FROM zer4u.mv_sales_by_year');
    const monthCount = await client.query('SELECT COUNT(*) FROM zer4u.mv_sales_by_month');
    const smCount    = await client.query('SELECT COUNT(*) FROM zer4u.mv_sales_by_store_month');

    console.log('\n📊 Row counts:');
    console.log(`   mv_sales_by_year         : ${yearCount.rows[0].count} rows`);
    console.log(`   mv_sales_by_month        : ${monthCount.rows[0].count} rows`);
    console.log(`   mv_sales_by_store_month  : ${smCount.rows[0].count} rows`);

    console.log('\n✅ Migration 017 complete!');
    console.log('\nNext steps:');
    console.log('  1. Run: node db/migrations/run-017-zer4u-date-materialized-views.js  (this file)');
    console.log('  2. Deploy server (schema description auto-regenerates on first query)');

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
