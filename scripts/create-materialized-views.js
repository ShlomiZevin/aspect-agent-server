/**
 * Create materialized views for fast queries
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

async function createViews() {
  const client = await pool.connect();

  try {
    console.log('🔧 Creating materialized views for fast aggregations...\n');

    // 1. Sales by store
    console.log('1. Creating mv_sales_by_store...');

    await client.query('DROP MATERIALIZED VIEW IF EXISTS zer4u.mv_sales_by_store CASCADE');

    await client.query(`
      CREATE MATERIALIZED VIEW zer4u.mv_sales_by_store AS
      SELECT
        s."מס.חנות SALES"::integer as store_number,
        st."שם חנות" as store_name,
        COUNT(*) as transaction_count,
        SUM(s."מכירה ללא מע""מ"::numeric) as total_revenue,
        AVG(s."מכירה ללא מע""מ"::numeric) as avg_revenue
      FROM zer4u.sales s
      LEFT JOIN zer4u.stores st ON s."מס.חנות SALES"::integer = st."מס.חנות"
      WHERE s."מכירה ללא מע""מ" IS NOT NULL
      GROUP BY s."מס.חנות SALES", st."שם חנות"
    `);

    await client.query('CREATE INDEX ON zer4u.mv_sales_by_store (store_number)');
    await client.query('CREATE INDEX ON zer4u.mv_sales_by_store (total_revenue DESC)');

    console.log('  ✅ Done\n');

    // 2. Sales by customer
    console.log('2. Creating mv_sales_by_customer...');

    await client.query('DROP MATERIALIZED VIEW IF EXISTS zer4u.mv_sales_by_customer CASCADE');

    await client.query(`
      CREATE MATERIALIZED VIEW zer4u.mv_sales_by_customer AS
      SELECT
        s."מס.לקוח"::integer as customer_number,
        c."שם לקוח" as customer_name,
        COUNT(*) as purchase_count,
        SUM(s."מכירה ללא מע""מ"::numeric) as total_purchases
      FROM zer4u.sales s
      LEFT JOIN zer4u.customers c ON s."מס.לקוח"::integer = c."מס.לקוח"
      WHERE s."מכירה ללא מע""מ" IS NOT NULL
      GROUP BY s."מס.לקוח", c."שם לקוח"
    `);

    await client.query('CREATE INDEX ON zer4u.mv_sales_by_customer (customer_number)');
    await client.query('CREATE INDEX ON zer4u.mv_sales_by_customer (total_purchases DESC)');

    console.log('  ✅ Done\n');

    // 3. Sales by product
    console.log('3. Creating mv_sales_by_product...');

    await client.query('DROP MATERIALIZED VIEW IF EXISTS zer4u.mv_sales_by_product CASCADE');

    await client.query(`
      CREATE MATERIALIZED VIEW zer4u.mv_sales_by_product AS
      SELECT
        s."קוד פריט SALES" as item_code,
        i."שם פריט" as item_name,
        SUM(s."כמות ברמת שורה"::numeric) as total_quantity,
        SUM(s."מכירה ללא מע""מ"::numeric) as total_revenue
      FROM zer4u.sales s
      LEFT JOIN zer4u.items i ON s."קוד פריט SALES" = i."קוד פריט"
      WHERE s."כמות ברמת שורה" IS NOT NULL
      GROUP BY s."קוד פריט SALES", i."שם פריט"
    `);

    await client.query('CREATE INDEX ON zer4u.mv_sales_by_product (item_code)');
    await client.query('CREATE INDEX ON zer4u.mv_sales_by_product (total_quantity DESC)');

    console.log('  ✅ Done\n');

    console.log('✅ All materialized views created!\n');

    // Test query
    console.log('📊 Testing: Top 5 stores by revenue...\n');

    const result = await client.query(`
      SELECT
        store_number,
        store_name,
        total_revenue,
        transaction_count
      FROM zer4u.mv_sales_by_store
      WHERE total_revenue IS NOT NULL
      ORDER BY total_revenue DESC
      LIMIT 5
    `);

    result.rows.forEach((row, i) => {
      console.log(`${i+1}. ${row.store_name} (${row.store_number}): ₪${parseFloat(row.total_revenue).toLocaleString()}`);
      console.log(`   Transactions: ${row.transaction_count}`);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

createViews();
