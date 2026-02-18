/**
 * Create all necessary expression indexes for Zer4U queries
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

async function createAllIndexes() {
  const client = await pool.connect();

  const indexes = [
    {
      name: 'zer4u_idx_sales_store_as_int',
      sql: 'CREATE INDEX IF NOT EXISTS zer4u_idx_sales_store_as_int ON zer4u.sales (CAST("מס.חנות SALES" AS INTEGER))'
    },
    {
      name: 'zer4u_idx_sales_customer_as_int',
      sql: 'CREATE INDEX IF NOT EXISTS zer4u_idx_sales_customer_as_int ON zer4u.sales (CAST("מס.לקוח" AS INTEGER))'
    },
    {
      name: 'zer4u_idx_sales_date',
      sql: 'CREATE INDEX IF NOT EXISTS zer4u_idx_sales_date ON zer4u.sales ("תאריך מקורי SALES")'
    },
    {
      name: 'zer4u_idx_stores_number',
      sql: 'CREATE INDEX IF NOT EXISTS zer4u_idx_stores_number ON zer4u.stores ("מס.חנות")'
    },
    {
      name: 'zer4u_idx_customers_number',
      sql: 'CREATE INDEX IF NOT EXISTS zer4u_idx_customers_number ON zer4u.customers ("מס.לקוח")'
    },
    {
      name: 'zer4u_idx_items_code',
      sql: 'CREATE INDEX IF NOT EXISTS zer4u_idx_items_code ON zer4u.items ("קוד פריט")'
    }
  ];

  try {
    console.log('🔧 Creating all expression indexes...\n');

    for (const index of indexes) {
      console.log(`Creating: ${index.name}`);
      const startTime = Date.now();

      try {
        await client.query(index.sql);
        const duration = Date.now() - startTime;
        console.log(`  ✅ Done in ${(duration/1000).toFixed(1)}s\n`);
      } catch (err) {
        if (err.message.includes('already exists')) {
          console.log(`  ⏭️  Already exists\n`);
        } else {
          console.log(`  ❌ Error: ${err.message}\n`);
        }
      }
    }

    console.log('✅ All indexes created!\n');

    // Show all indexes
    console.log('📊 Current indexes on sales table:');
    const result = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'zer4u' AND tablename = 'sales'
      ORDER BY indexname
    `);

    result.rows.forEach(row => {
      console.log(`  - ${row.indexname}`);
    });

  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

createAllIndexes();
