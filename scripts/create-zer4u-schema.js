/**
 * Create Zer4U Schema Script
 *
 * Creates the Zer4U schema in PostgreSQL and all tables
 * based on the CSV analysis results
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

const SCHEMA_NAME = 'zer4u';
const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5
});

async function createSchema() {
  const startTime = Date.now();
  console.log('🚀 Creating Zer4U schema in PostgreSQL...\n');
  console.log('⚡ OPTIMIZED FOR FAST LOADING:');
  console.log('  - NO primary keys');
  console.log('  - NO foreign keys');
  console.log('  - NO unique constraints');
  console.log('  - NO indexes\n');
  console.log('═'.repeat(60));

  const client = await pool.connect();

  try {
    // Step 1: Load analysis results
    console.log('\n📋 Step 1: Loading CSV analysis...');
    const step1Start = Date.now();
    const analysisData = await fs.readFile(ANALYSIS_FILE, 'utf8');
    const schemas = JSON.parse(analysisData);
    console.log(`✅ Loaded ${schemas.length} table definitions (${Date.now() - step1Start}ms)\n`);

    // Step 2: Create schema
    console.log('🏗️  Step 2: Creating schema...');
    const step2Start = Date.now();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    console.log(`✅ Schema "${SCHEMA_NAME}" created (${Date.now() - step2Start}ms)\n`);

    // Step 3: Create tables
    console.log('📊 Step 3: Creating tables...\n');
    const step3Start = Date.now();
    let tablesCreated = 0;

    for (let i = 0; i < schemas.length; i++) {
      const schema = schemas[i];

      if (schema.error) {
        console.log(`[${i + 1}/${schemas.length}] ⏭️  Skipping ${schema.fileName} (error during analysis)`);
        continue;
      }

      const tableName = schema.tableName;
      const tableStart = Date.now();
      console.log(`[${i + 1}/${schemas.length}] Creating: ${SCHEMA_NAME}.${tableName}`);

      try {
        const createTableSQL = generateCreateTableSQL(SCHEMA_NAME, schema);
        await client.query(createTableSQL);
        tablesCreated++;
        console.log(`  ✅ ${schema.columns.length} columns (${Date.now() - tableStart}ms)\n`);
      } catch (error) {
        console.error(`  ❌ Error: ${error.message}\n`);
      }
    }

    console.log(`✅ ${tablesCreated} tables created (${Date.now() - step3Start}ms)\n`);

    // Step 4: Grant permissions
    console.log('🔒 Step 4: Setting permissions...');
    const step4Start = Date.now();
    await client.query(`GRANT USAGE ON SCHEMA ${SCHEMA_NAME} TO ${process.env.DB_USER}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${SCHEMA_NAME} TO ${process.env.DB_USER}`);
    console.log(`✅ Permissions set (${Date.now() - step4Start}ms)\n`);

    // Step 5: Summary
    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
      ORDER BY table_name
    `, [SCHEMA_NAME]);

    const totalTime = Date.now() - startTime;
    console.log('═'.repeat(60));
    console.log('📈 SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Schema: ${SCHEMA_NAME}`);
    console.log(`Tables created: ${result.rows.length}`);
    console.log(`Total time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log('═'.repeat(60));
    console.log('\n📋 Tables:');
    result.rows.forEach((row, idx) => {
      console.log(`  ${(idx + 1).toString().padStart(2)}. ${row.table_name}`);
    });

    console.log('\n✅ Schema creation complete!');
    console.log(`\nNext step: node scripts/load-csv-to-db.js\n`);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Generate CREATE TABLE SQL statement
 * OPTIMIZED FOR FAST LOADING - NO CONSTRAINTS!
 */
function generateCreateTableSQL(schemaName, tableSchema) {
  const tableName = tableSchema.tableName;
  const columns = tableSchema.columns;

  // ALL columns are nullable for fast loading
  // NO primary keys, NO foreign keys, NO unique constraints
  const columnDefs = columns.map(col => {
    const sanitizedName = sanitizeColumnName(col.name);
    return `  "${sanitizedName}" ${col.type} NULL`;
  });

  const sql = `
CREATE TABLE ${schemaName}.${tableName} (
${columnDefs.join(',\n')}
);
  `.trim();

  return sql;
}

/**
 * Sanitize column names for PostgreSQL
 */
function sanitizeColumnName(name) {
  // Keep original name but escape special characters
  // PostgreSQL allows almost any name if quoted
  return name
    .replace(/\0/g, '') // Remove null bytes
    .replace(/"/g, '""') // Escape double quotes by doubling them
    .trim();
}

// Run if called directly
if (require.main === module) {
  createSchema()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { createSchema };
