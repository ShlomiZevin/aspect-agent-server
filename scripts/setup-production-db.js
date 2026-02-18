/**
 * Setup production database - indexes and materialized views
 * Run this ONCE after deployment
 */

require('dotenv').config({ path: '.env.production' });
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

async function setupProduction() {
  const client = await pool.connect();

  try {
    console.log('🚀 Setting up Production Database\n');
    console.log(`Host: ${process.env.DB_HOST}`);
    console.log(`Database: ${process.env.DB_NAME}\n`);

    // Step 1: Create expression indexes
    console.log('Step 1: Creating Expression Indexes...\n');

    const indexes = [
      'CREATE INDEX IF NOT EXISTS zer4u_idx_sales_store_as_int ON zer4u.sales (CAST("מס.חנות SALES" AS INTEGER))',
      'CREATE INDEX IF NOT EXISTS zer4u_idx_sales_customer_as_int ON zer4u.sales (CAST("מס.לקוח" AS INTEGER))',
      'CREATE INDEX IF NOT EXISTS zer4u_idx_sales_date ON zer4u.sales ("תאריך מקורי SALES")',
      'CREATE INDEX IF NOT EXISTS zer4u_idx_stores_number ON zer4u.stores ("מס.חנות")',
      'CREATE INDEX IF NOT EXISTS zer4u_idx_customers_number ON zer4u.customers ("מס.לקוח")',
      'CREATE INDEX IF NOT EXISTS zer4u_idx_items_code ON zer4u.items ("קוד פריט")'
    ];

    for (const sql of indexes) {
      const indexName = sql.match(/zer4u_idx_\w+/)[0];
      console.log(`Creating ${indexName}...`);
      await client.query(sql);
      console.log(`  ✅ Done`);
    }

    console.log('\n✅ All indexes created\n');

    // Step 2: Create materialized views
    console.log('Step 2: Creating Materialized Views...\n');

    // Drop existing views
    console.log('Dropping old views if exist...');
    await client.query('DROP MATERIALIZED VIEW IF EXISTS zer4u.mv_sales_by_store CASCADE');
    await client.query('DROP MATERIALIZED VIEW IF EXISTS zer4u.mv_sales_by_customer CASCADE');
    await client.query('DROP MATERIALIZED VIEW IF EXISTS zer4u.mv_sales_by_product CASCADE');

    // Create mv_sales_by_store
    console.log('Creating mv_sales_by_store...');
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
    console.log('  ✅ Done');

    // Create mv_sales_by_customer
    console.log('Creating mv_sales_by_customer...');
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
    console.log('  ✅ Done');

    // Create mv_sales_by_product
    console.log('Creating mv_sales_by_product...');
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
    console.log('  ✅ Done');

    console.log('\n✅ All materialized views created\n');

    // Test query
    console.log('Step 3: Testing...\n');
    const result = await client.query(`
      SELECT store_number, store_name, total_revenue, transaction_count
      FROM zer4u.mv_sales_by_store
      WHERE total_revenue IS NOT NULL
      ORDER BY total_revenue DESC
      LIMIT 5
    `);

    console.log('Top 5 stores by revenue:');
    result.rows.forEach((row, i) => {
      const revenue = parseFloat(row.total_revenue);
      console.log(`${i+1}. ${row.store_name} - ₪${revenue.toLocaleString('en-US', {maximumFractionDigits: 0})}`);
    });

    console.log('\n🎉 Production database setup complete!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setupProduction();
