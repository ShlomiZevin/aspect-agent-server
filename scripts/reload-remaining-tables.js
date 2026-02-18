/**
 * Reload Remaining Tables (without sales)
 *
 * Load warehouse_inventory and items only
 */

require('dotenv').config();
const { Pool } = require('pg');
const gcsService = require('../services/gcs.service');
const fs = require('fs').promises;
const path = require('path');
const { from: copyFrom } = require('pg-copy-streams');
const { Transform } = require('stream');

const SCHEMA_NAME = 'zer4u';
const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');

// Only these two remaining tables
const REMAINING_TABLES = [
  'warehouse_inventory',
  'items'
];

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10
});

async function reloadRemainingTables() {
  console.log('🔧 Loading remaining tables (skipping sales)...\n');
  console.log('Tables to load:');
  REMAINING_TABLES.forEach(t => console.log(`  - ${t}`));
  console.log();

  try {
    // Load analysis
    const analysisData = await fs.readFile(ANALYSIS_FILE, 'utf8');
    const allSchemas = JSON.parse(analysisData);

    // Filter only remaining tables
    const schemas = allSchemas.filter(s => REMAINING_TABLES.includes(s.tableName));

    console.log(`📋 Found ${schemas.length} tables to load\n`);

    const client = await pool.connect();

    for (let i = 0; i < schemas.length; i++) {
      const schema = schemas[i];
      console.log(`\n[${i + 1}/${schemas.length}] 🔄 Processing: ${schema.tableName}`);

      try {
        // Step 1: Drop table
        console.log(`  🗑️  Dropping existing table...`);
        await client.query(`DROP TABLE IF EXISTS ${SCHEMA_NAME}.${schema.tableName}`);

        // Step 2: Recreate table with TEXT for all columns
        console.log(`  🏗️  Creating table...`);
        const createSQL = generateCreateTableSQL(schema);
        await client.query(createSQL);

        // Step 3: Load data
        console.log(`  📥 Loading data with COPY...`);
        const rows = await loadCSVFile(client, schema);
        console.log(`  ✅ Loaded ${rows.toLocaleString()} rows\n`);

      } catch (error) {
        console.error(`  ❌ Error: ${error.message}\n`);
      }
    }

    client.release();

    console.log('═'.repeat(60));
    console.log('✅ Remaining tables loaded!\n');
    console.log('Note: sales table still needs to be loaded separately');

  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

function generateCreateTableSQL(schema) {
  const tableName = schema.tableName;
  const columns = schema.columns;

  const columnDefs = columns.map(col => {
    const sanitizedName = sanitizeColumnName(col.name);
    return `  "${sanitizedName}" TEXT NULL`;
  });

  const sql = `
CREATE TABLE ${SCHEMA_NAME}.${tableName} (
${columnDefs.join(',\n')}
);
  `.trim();

  return sql;
}

async function loadCSVFile(client, schema) {
  const tableName = `${SCHEMA_NAME}.${schema.tableName}`;
  const filePath = schema.filePath;

  const columns = schema.columns.map(col =>
    sanitizeColumnName(col.name.replace(/^\uFEFF/, '').trim())
  );

  const columnNames = columns.map(c => `"${c}"`).join(', ');
  const copyQuery = `COPY ${tableName} (${columnNames}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`;

  const gcsStream = gcsService.getFileStream(filePath);
  const copyStream = client.query(copyFrom(copyQuery));

  let totalRows = 0;
  let lastLogTime = Date.now();
  const startTime = Date.now();

  const progressTransform = new Transform({
    transform(chunk, encoding, callback) {
      const newlines = chunk.toString().split('\n').length - 1;
      totalRows += newlines;

      const now = Date.now();
      if (now - lastLogTime > 2000) {
        const elapsed = (now - startTime) / 1000;
        const speed = Math.round(totalRows / elapsed);
        process.stdout.write(`  ⏳ ${totalRows.toLocaleString()} rows | ${speed.toLocaleString()} rows/s\r`);
        lastLogTime = now;
      }

      callback(null, chunk);
    }
  });

  await new Promise((resolve, reject) => {
    gcsStream
      .pipe(progressTransform)
      .pipe(copyStream)
      .on('finish', () => {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = Math.round(totalRows / elapsed);
        process.stdout.write(`  ✅ ${totalRows.toLocaleString()} rows | ${speed.toLocaleString()} rows/s | ${elapsed.toFixed(1)}s\n`);
        resolve();
      })
      .on('error', reject);

    gcsStream.on('error', reject);
    progressTransform.on('error', reject);
  });

  return Math.max(0, totalRows - 1);
}

function sanitizeColumnName(name) {
  return name
    .replace(/\0/g, '')
    .replace(/"/g, '""')
    .trim();
}

if (require.main === module) {
  reloadRemainingTables()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { reloadRemainingTables };
