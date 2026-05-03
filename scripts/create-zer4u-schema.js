/**
 * Create Zer4U Schema Script
 *
 * Creates the Zer4U schema in PostgreSQL and all tables
 * based on the CSV analysis results
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const fs = require('fs').promises;
const path = require('path');

const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');

/**
 * @param {string} schemaName - target PostgreSQL schema name
 * @param {Array|null} schemas - pre-scanned schema definitions; if null, read from local JSON file (CLI use only)
 */
async function createSchema(schemaName = 'zer4u', schemas = null) {
  const pool = getPool({ max: 5 });
  const startTime = Date.now();
  console.log('Creating Zer4U schema in PostgreSQL...');

  const client = await pool.connect();

  try {
    // Step 1: Load analysis results
    if (!schemas) {
      // CLI fallback: read from local file
      const analysisData = await fs.readFile(ANALYSIS_FILE, 'utf8');
      schemas = JSON.parse(analysisData);
    }
    console.log(`Loaded ${schemas.length} table definitions`);

    // Step 2: Create schema
    console.log('🏗️  Step 2: Creating schema...');
    const step2Start = Date.now();
    // Terminate any lingering connections to this schema to avoid DROP waiting on rollback
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND query ILIKE '%${schemaName}%'
        AND pid <> pg_backend_pid()
    `).catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await client.query(`CREATE SCHEMA ${schemaName}`);
    console.log(`✅ Schema "${schemaName}" created (${Date.now() - step2Start}ms)\n`);

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
      console.log(`[${i + 1}/${schemas.length}] Creating: ${schemaName}.${tableName}`);

      try {
        const createTableSQL = generateCreateTableSQL(schemaName, schema);
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
    const dbUser = process.env.ZER4U_DB_USER || process.env.DB_USER;
    await client.query(`GRANT USAGE ON SCHEMA ${schemaName} TO ${dbUser}`);
    await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schemaName} TO ${dbUser}`);
    console.log(`✅ Permissions set (${Date.now() - step4Start}ms)\n`);

    // Step 5: Summary
    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
      ORDER BY table_name
    `, [schemaName]);

    const totalTime = Date.now() - startTime;
    console.log('═'.repeat(60));
    console.log('📈 SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Schema: ${schemaName}`);
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

  // UNLOGGED: no WAL → 2-3x faster COPY, instant crash cleanup (no rollback wait)
  const sql = `
CREATE UNLOGGED TABLE ${schemaName}.${tableName} (
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
