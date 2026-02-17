/**
 * Load CSV Data to PostgreSQL Script
 *
 * Loads all CSV files from GCS into zer4u schema tables
 * Uses streaming for large files
 */

require('dotenv').config();
const { Pool } = require('pg');
const gcsService = require('../services/gcs.service');
const csv = require('csv-parser');
const { pipeline } = require('stream/promises');
const fs = require('fs').promises;
const path = require('path');

const SCHEMA_NAME = 'zer4u';
const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');
const BATCH_SIZE = 1000; // Insert in batches of 1000 rows

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10
});

async function loadAllCSVFiles() {
  console.log('🚀 Loading CSV data into PostgreSQL...\n');

  try {
    // Load analysis
    const analysisData = await fs.readFile(ANALYSIS_FILE, 'utf8');
    const schemas = JSON.parse(analysisData);

    console.log(`📋 Found ${schemas.length} tables to load\n`);

    let totalLoaded = 0;
    let totalFailed = 0;

    for (let i = 0; i < schemas.length; i++) {
      const schema = schemas[i];

      if (schema.error) {
        console.log(`[${i + 1}/${schemas.length}] ⏭️  Skipping ${schema.fileName} (analysis error)\n`);
        totalFailed++;
        continue;
      }

      console.log(`[${i + 1}/${schemas.length}] Loading: ${schema.fileName} -> ${schema.tableName}`);
      console.log(`  Size: ${formatBytes(schema.fileSize)}`);

      try {
        const rowsLoaded = await loadCSVFile(schema);
        console.log(`  ✅ Loaded ${rowsLoaded.toLocaleString()} rows\n`);
        totalLoaded++;
      } catch (error) {
        console.error(`  ❌ Error: ${error.message}\n`);
        totalFailed++;
      }
    }

    console.log('📈 SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Total tables: ${schemas.length}`);
    console.log(`Successfully loaded: ${totalLoaded}`);
    console.log(`Failed: ${totalFailed}`);
    console.log('═'.repeat(60));

    console.log('\n✅ Data loading complete!\n');

  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

/**
 * Load a single CSV file into its table
 */
async function loadCSVFile(schema) {
  const client = await pool.connect();

  try {
    const tableName = `${SCHEMA_NAME}.${schema.tableName}`;
    const filePath = schema.filePath;

    // Get column names and sanitize them
    const columns = schema.columns.map(col =>
      sanitizeColumnName(col.name.replace(/^\uFEFF/, '').trim())
    );

    // Create stream from GCS
    const stream = gcsService.getFileStream(filePath);

    let batch = [];
    let totalRows = 0;
    let batchCount = 0;

    // Process CSV stream
    await new Promise((resolve, reject) => {
      stream
        .pipe(csv())
        .on('data', async (row) => {
          // Add row to batch
          batch.push(row);

          // Insert batch when it reaches BATCH_SIZE
          if (batch.length >= BATCH_SIZE) {
            stream.pause(); // Pause stream while inserting

            try {
              await insertBatch(client, tableName, columns, batch);
              totalRows += batch.length;
              batchCount++;

              // Progress indicator
              if (batchCount % 10 === 0) {
                process.stdout.write(`  Progress: ${totalRows.toLocaleString()} rows...\r`);
              }

              batch = [];
              stream.resume(); // Resume stream
            } catch (error) {
              reject(error);
              return;
            }
          }
        })
        .on('end', async () => {
          // Insert remaining rows
          if (batch.length > 0) {
            try {
              await insertBatch(client, tableName, columns, batch);
              totalRows += batch.length;
            } catch (error) {
              reject(error);
              return;
            }
          }
          resolve();
        })
        .on('error', reject);
    });

    return totalRows;

  } finally {
    client.release();
  }
}

/**
 * Insert a batch of rows into the table
 */
async function insertBatch(client, tableName, columns, rows) {
  if (rows.length === 0) return;

  // Build INSERT statement with multiple VALUES
  const columnNames = columns.map(c => `"${c}"`).join(', ');

  // Build placeholders for all rows
  const valuePlaceholders = [];
  const values = [];
  let paramIndex = 1;

  for (const row of rows) {
    const rowPlaceholders = [];

    for (const col of columns) {
      // Get original column name from row (might have BOM or different encoding)
      const originalColName = Object.keys(row).find(k =>
        k.replace(/^\uFEFF/, '').trim() === col
      ) || col;

      const value = row[originalColName] !== undefined && row[originalColName] !== ''
        ? row[originalColName]
        : null;

      values.push(value);
      rowPlaceholders.push(`$${paramIndex++}`);
    }

    valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
  }

  const sql = `
    INSERT INTO ${tableName} (${columnNames})
    VALUES ${valuePlaceholders.join(', ')}
  `;

  await client.query(sql, values);
}

/**
 * Sanitize column name (same as in create script)
 */
function sanitizeColumnName(name) {
  return name
    .replace(/\0/g, '')
    .replace(/"/g, '""')
    .trim();
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  const size = parseInt(bytes);
  if (size === 0 || isNaN(size)) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(size) / Math.log(k));
  return Math.round(size / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Run if called directly
if (require.main === module) {
  loadAllCSVFiles()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { loadAllCSVFiles };
