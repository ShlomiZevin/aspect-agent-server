/**
 * Create Comprehensive Indexes for Zer4U Schema v2
 *
 * Optimized for common BI query patterns:
 * - Date range queries (last month, this week, trends)
 * - Store/product/customer filtering
 * - Revenue sorting and aggregations
 * - Composite indexes for multi-filter queries
 */

require('dotenv').config();
const { Pool } = require('pg');

function getSetupSQL(schemaName) {
  return `
-- Create immutable date parsing function for indexing
CREATE OR REPLACE FUNCTION ${schemaName}.parse_date_ddmmyyyy(text)
RETURNS date AS $$
  SELECT CASE
    WHEN $1 IS NULL OR $1 = '' THEN NULL
    ELSE TO_DATE($1, 'DD/MM/YYYY')
  END
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;

-- Create immutable numeric cast for indexing
CREATE OR REPLACE FUNCTION ${schemaName}.to_numeric_safe(text)
RETURNS numeric AS $$
  SELECT CASE
    WHEN $1 IS NULL OR $1 = '' THEN NULL
    ELSE $1::numeric
  END
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;

-- Create immutable integer cast for indexing
CREATE OR REPLACE FUNCTION ${schemaName}.to_int_safe(text)
RETURNS integer AS $$
  SELECT CASE
    WHEN $1 IS NULL OR $1 = '' THEN NULL
    ELSE $1::integer
  END
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;
`;
}

function getIndexes(schemaName) {
  const s = schemaName;
  return [
  // ============================================
  // SALES TABLE (9.4M rows) - Most Critical
  // ============================================

  // 1. DATE RANGE QUERIES - Most important for BI
  // Enables: "last month", "this week", "date range", "trends"
  {
    name: 'idx_sales_date_parsed',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_date_parsed
          ON ${s}.sales (${s}.parse_date_ddmmyyyy("תאריך מקורי SALES") DESC)`,
    reason: 'Date range queries with parsed date'
  },

  // 2. PRODUCT CODE - For product-specific queries
  {
    name: 'idx_sales_item_code',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_item_code
          ON ${s}.sales ("קוד פריט SALES")`,
    reason: 'Product lookups and joins'
  },

  // 3. REVENUE SORTING - For top/bottom queries
  {
    name: 'idx_sales_revenue',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_revenue
          ON ${s}.sales (${s}.to_numeric_safe("מכירה ללא מע""מ") DESC NULLS LAST)`,
    reason: 'Revenue sorting and filtering'
  },

  // 4. QUANTITY - For volume queries
  {
    name: 'idx_sales_quantity',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_quantity
          ON ${s}.sales (${s}.to_numeric_safe("כמות ברמת שורה") DESC NULLS LAST)`,
    reason: 'Quantity sorting and filtering'
  },

  // 5. STORE + DATE
  {
    name: 'idx_sales_store_date',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_store_date
          ON ${s}.sales (
            ${s}.to_int_safe("מס.חנות SALES"),
            ${s}.parse_date_ddmmyyyy("תאריך מקורי SALES") DESC
          )`,
    reason: 'Store + date range queries'
  },

  // 6. PRODUCT + DATE
  {
    name: 'idx_sales_product_date',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_product_date
          ON ${s}.sales (
            "קוד פריט SALES",
            ${s}.parse_date_ddmmyyyy("תאריך מקורי SALES") DESC
          )`,
    reason: 'Product + date range queries'
  },

  // 7. CUSTOMER + DATE
  {
    name: 'idx_sales_customer_date',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_customer_date
          ON ${s}.sales (
            ${s}.to_int_safe("מס.לקוח"),
            ${s}.parse_date_ddmmyyyy("תאריך מקורי SALES") DESC
          )`,
    reason: 'Customer + date range queries'
  },

  // 8. InventoryKey on SALES
  {
    name: 'idx_sales_inventory_key',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_inventory_key
          ON ${s}.sales ("InventoryKey")`,
    reason: 'JOIN: sales → inventory'
  },

  // 9. TargetKey on SALES
  {
    name: 'idx_sales_target_key',
    table: 'sales',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_target_key
          ON ${s}.sales ("TargetKey")`,
    reason: 'JOIN: sales → targets'
  },

  // 10. Inventory key
  {
    name: 'idx_inventory_key',
    table: 'inventory',
    sql: `CREATE INDEX IF NOT EXISTS idx_inventory_key
          ON ${s}.inventory ("InventoryKey")`,
    reason: 'JOIN: inventory ← sales'
  },

  // 11. Stock balance
  {
    name: 'idx_inventory_balance',
    table: 'inventory',
    sql: `CREATE INDEX IF NOT EXISTS idx_inventory_balance
          ON ${s}.inventory ("יתרת מלאי" DESC NULLS LAST)`,
    reason: 'Stock level queries'
  },

  // 12. Item group
  {
    name: 'idx_items_group',
    table: 'items',
    sql: `CREATE INDEX IF NOT EXISTS idx_items_group
          ON ${s}.items ("קבוצת פריט")`,
    reason: 'Product category filtering'
  },

  // 13. Item name
  {
    name: 'idx_items_name',
    table: 'items',
    sql: `CREATE INDEX IF NOT EXISTS idx_items_name
          ON ${s}.items ("שם פריט")`,
    reason: 'Product name lookups'
  },

  // 14. Customer name
  {
    name: 'idx_customers_name',
    table: 'customers',
    sql: `CREATE INDEX IF NOT EXISTS idx_customers_name
          ON ${s}.customers ("שם לקוח")`,
    reason: 'Customer name lookups'
  },

  // 15. Customer location
  {
    name: 'idx_customers_location',
    table: 'customers',
    sql: `CREATE INDEX IF NOT EXISTS idx_customers_location
          ON ${s}.customers ("ישוב")`,
    reason: 'Geographic customer analysis'
  }
  ];
}

async function createIndexes(schemaName = 'zer4u') {
  const INDEXES = getIndexes(schemaName);
  const SETUP_SQL = getSetupSQL(schemaName);
  const CONCURRENCY = 4;

  // Pool created inside function so multiple sequential calls are safe
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: CONCURRENCY + 2,
  });

  console.log('═'.repeat(70));
  console.log('🔧 ZER4U INDEX CREATION v2');
  console.log('═'.repeat(70));
  console.log(`\nTotal indexes to create: ${INDEXES.length}\n`);

  const client = await pool.connect();
  const results = { created: 0, skipped: 0, failed: 0, errors: [] };
  const startTotal = Date.now();

  try {
    // First, create the helper functions for IMMUTABLE expressions
    console.log('📦 Creating helper functions for IMMUTABLE index expressions...\n');
    await client.query(SETUP_SQL);
    console.log('   ✅ Helper functions created\n');
    console.log('─'.repeat(70));

    // List existing indexes
    console.log('📋 Checking existing indexes on sales table...\n');
    const existing = await client.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = 'sales'
    `, [schemaName]);
    console.log(`Found ${existing.rows.length} existing indexes\n`);

    console.log('─'.repeat(70));

    // Create indexes in parallel batches — each in its own connection with max memory
    const createOne = async (idx, i) => {
      const c = await pool.connect();
      const startTime = Date.now();
      try {
        await c.query(`SET maintenance_work_mem = '1GB'`);
        await c.query(idx.sql);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   ✅ [${i + 1}/${INDEXES.length}] ${idx.name} — ${duration}s`);
        results.created++;
      } catch (err) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        if (err.message.includes('already exists')) {
          console.log(`   ⏭️  [${i + 1}/${INDEXES.length}] ${idx.name} — already exists (${duration}s)`);
          results.skipped++;
        } else {
          console.log(`   ❌ [${i + 1}/${INDEXES.length}] ${idx.name} — ${err.message}`);
          results.failed++;
          results.errors.push({ index: idx.name, error: err.message });
        }
      } finally {
        c.release();
      }
    };

    for (let i = 0; i < INDEXES.length; i += CONCURRENCY) {
      const batch = INDEXES.slice(i, i + CONCURRENCY).map((idx, j) => createOne(idx, i + j));
      await Promise.all(batch);
    }

    // Summary
    const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);

    console.log('═'.repeat(70));
    console.log('📊 SUMMARY');
    console.log('═'.repeat(70));
    console.log(`✅ Created:  ${results.created}`);
    console.log(`⏭️  Skipped:  ${results.skipped}`);
    console.log(`❌ Failed:   ${results.failed}`);
    console.log(`⏱️  Total:    ${totalTime}s`);

    if (results.errors.length > 0) {
      console.log('\n⚠️  Errors:');
      results.errors.forEach(e => {
        console.log(`   - ${e.index}: ${e.error}`);
      });
    }

    // Show final index count
    console.log('\n📋 Final index count per table:');
    const finalCount = await client.query(`
      SELECT tablename, COUNT(*) as count
      FROM pg_indexes
      WHERE schemaname = $1
      GROUP BY tablename
      ORDER BY count DESC
    `, [schemaName]);
    finalCount.rows.forEach(row => {
      console.log(`   ${row.tablename}: ${row.count} indexes`);
    });

    console.log('\n═'.repeat(70));
    console.log('✅ Index creation complete!');
    console.log('═'.repeat(70));

  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// Also export a function to check index usage (run after queries)
async function checkIndexUsage(schemaName = 'zer4u') {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  const client = await pool.connect();

  try {
    console.log('\n📊 Index usage statistics:\n');

    const result = await client.query(`
      SELECT
        schemaname,
        relname as table_name,
        indexrelname as index_name,
        idx_scan as times_used,
        idx_tup_read as rows_read,
        idx_tup_fetch as rows_fetched
      FROM pg_stat_user_indexes
      WHERE schemaname = $1
      ORDER BY idx_scan DESC
      LIMIT 20
    `, [schemaName]);

    result.rows.forEach(row => {
      console.log(`${row.index_name}: ${row.times_used} scans, ${row.rows_read} rows read`);
    });

  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    checkIndexUsage();
  } else {
    createIndexes();
  }
}

module.exports = { createIndexes, checkIndexUsage, getIndexes };
