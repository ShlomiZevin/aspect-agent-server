/**
 * Create Indexes for Zer4U Schema
 *
 * Creates indexes on key columns for faster queries:
 * - ID columns (kod_*, *_id, *_code)
 * - Date columns (*date*, *_dt, תאריך*)
 * - Foreign key columns
 * - Frequently filtered columns
 */

require('dotenv').config();
const { Pool } = require('pg');

const SCHEMA_NAME = 'zer4u';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10
});

// Index rules based on column name patterns
const INDEX_PATTERNS = [
  // ID and code columns
  { pattern: /^kod_/i, priority: 1, type: 'btree' },           // kod_prit, kod_lkoch
  { pattern: /_kod$/i, priority: 1, type: 'btree' },           // prit_kod
  { pattern: /^.*קוד.*/i, priority: 1, type: 'btree' },        // קוד פריט, קוד לקוח
  { pattern: /_id$/i, priority: 1, type: 'btree' },            // customer_id, item_id
  { pattern: /^id$/i, priority: 1, type: 'btree' },            // id
  { pattern: /_code$/i, priority: 1, type: 'btree' },          // store_code, item_code
  { pattern: /^code$/i, priority: 1, type: 'btree' },          // code

  // Date columns
  { pattern: /date/i, priority: 2, type: 'btree' },            // date, creation_date
  { pattern: /_dt$/i, priority: 2, type: 'btree' },            // sale_dt, order_dt
  { pattern: /^תאריך/i, priority: 2, type: 'btree' },          // תאריך מכירה
  { pattern: /תאריך$/i, priority: 2, type: 'btree' },          // תאריך

  // Common business columns
  { pattern: /^store/i, priority: 3, type: 'btree' },          // store, store_num
  { pattern: /^customer/i, priority: 3, type: 'btree' },       // customer, customer_num
  { pattern: /^item/i, priority: 3, type: 'btree' },           // item, item_num
  { pattern: /^מס.*חנות/i, priority: 3, type: 'btree' },       // מספר חנות
  { pattern: /^.*לקוח/i, priority: 3, type: 'btree' },         // לקוח, מספר לקוח
  { pattern: /^.*פריט/i, priority: 3, type: 'btree' },         // פריט, מספר פריט
];

async function createIndexes() {
  console.log('🔧 Creating indexes for Zer4U schema...\n');
  console.log('═'.repeat(80));

  try {
    const client = await pool.connect();

    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
      ORDER BY table_name
    `, [SCHEMA_NAME]);

    console.log(`📋 Found ${tablesResult.rows.length} tables\n`);

    let totalIndexes = 0;
    let totalTime = 0;

    for (let i = 0; i < tablesResult.rows.length; i++) {
      const tableName = tablesResult.rows[i].table_name;
      console.log(`[${i + 1}/${tablesResult.rows.length}] 🔍 ${tableName}`);

      // Get columns for this table
      const columnsResult = await client.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [SCHEMA_NAME, tableName]);

      // Find columns that match index patterns
      const indexableColumns = [];
      for (const col of columnsResult.rows) {
        const columnName = col.column_name;

        for (const pattern of INDEX_PATTERNS) {
          if (pattern.pattern.test(columnName)) {
            indexableColumns.push({
              column: columnName,
              priority: pattern.priority,
              type: pattern.type
            });
            break; // Only match first pattern
          }
        }
      }

      if (indexableColumns.length === 0) {
        console.log(`  ⏭️  No indexable columns found\n`);
        continue;
      }

      // Sort by priority and create indexes
      indexableColumns.sort((a, b) => a.priority - b.priority);

      console.log(`  📊 Creating ${indexableColumns.length} indexes...`);

      for (const idx of indexableColumns) {
        const indexName = `idx_${tableName}_${idx.column}`.toLowerCase()
          .replace(/[^a-z0-9_]/g, '_')
          .replace(/_{2,}/g, '_')
          .substring(0, 63); // PostgreSQL limit

        try {
          const startTime = Date.now();

          await client.query(`
            CREATE INDEX IF NOT EXISTS "${indexName}"
            ON ${SCHEMA_NAME}.${tableName} USING ${idx.type} ("${idx.column}")
          `);

          const elapsed = Date.now() - startTime;
          totalTime += elapsed;
          totalIndexes++;

          console.log(`    ✅ ${idx.column} (${elapsed}ms)`);
        } catch (error) {
          console.log(`    ⚠️  ${idx.column} - ${error.message}`);
        }
      }

      console.log('');
    }

    client.release();

    console.log('═'.repeat(80));
    console.log('📈 SUMMARY:');
    console.log(`  Total indexes created: ${totalIndexes}`);
    console.log(`  Total time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log('═'.repeat(80));
    console.log('\n✅ Indexes created successfully!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  createIndexes()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { createIndexes };
