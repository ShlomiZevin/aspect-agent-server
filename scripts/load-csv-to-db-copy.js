/**
 * Load CSV Data to PostgreSQL Script - OPTIMIZED WITH COPY
 *
 * Loads all CSV files from GCS into zer4u schema tables
 * Uses PostgreSQL COPY command for maximum speed
 */

require('dotenv').config();
const { Pool } = require('pg');
const gcsService = require('../services/gcs.service');
const csv = require('csv-parser');
const { Transform } = require('stream');
const fs = require('fs').promises;
const path = require('path');
const { from: copyFrom } = require('pg-copy-streams');

const SCHEMA_NAME = 'zer4u';
const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');

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
  const startTime = Date.now();
  console.log('🚀 Loading CSV data into PostgreSQL...\n');
  console.log('⚡ ULTRA-OPTIMIZED WITH POSTGRESQL COPY:');
  console.log(`  - Using COPY FROM STDIN (10-50x faster)`);
  console.log(`  - NO constraints validation`);
  console.log(`  - Direct streaming from GCS\n`);
  console.log('═'.repeat(60));

  try {
    // Load analysis
    const analysisData = await fs.readFile(ANALYSIS_FILE, 'utf8');
    const schemas = JSON.parse(analysisData);

    // Calculate total size
    const totalSize = schemas.reduce((sum, s) => sum + (parseInt(s.fileSize) || 0), 0);
    console.log(`\n📋 Found ${schemas.length} tables to load`);
    console.log(`📊 Total data size: ${formatBytes(totalSize)}\n`);

    let totalLoaded = 0;
    let totalFailed = 0;
    let totalRows = 0;
    const tableTimes = [];

    for (let i = 0; i < schemas.length; i++) {
      const schema = schemas[i];

      if (schema.error) {
        console.log(`[${i + 1}/${schemas.length}] ⏭️  Skipping ${schema.fileName} (analysis error)\n`);
        totalFailed++;
        continue;
      }

      console.log(`\n[${i + 1}/${schemas.length}] 📥 Loading: ${schema.fileName}`);
      console.log(`  → Table: ${schema.tableName}`);
      console.log(`  → Size: ${formatBytes(schema.fileSize)}`);

      const tableStart = Date.now();

      try {
        const result = await loadCSVFile(schema);
        const tableTime = Date.now() - tableStart;
        tableTimes.push({ name: schema.tableName, time: tableTime, rows: result });

        const speed = result > 0 ? Math.round(result / (tableTime / 1000)) : 0;
        console.log(`  ✅ Loaded ${result.toLocaleString()} rows in ${(tableTime / 1000).toFixed(2)}s (${speed.toLocaleString()} rows/s)`);

        totalLoaded++;
        totalRows += result;

        // Calculate ETA
        const avgTime = tableTimes.reduce((sum, t) => sum + t.time, 0) / tableTimes.length;
        const remaining = schemas.length - i - 1;
        const eta = avgTime * remaining;
        if (remaining > 0) {
          console.log(`  ⏱️  ETA: ${formatDuration(eta)} (${remaining} tables remaining)`);
        }
      } catch (error) {
        console.error(`  ❌ Error: ${error.message}`);
        totalFailed++;
      }
    }

    const totalTime = Date.now() - startTime;
    const avgSpeed = totalRows > 0 ? Math.round(totalRows / (totalTime / 1000)) : 0;

    console.log('\n═'.repeat(60));
    console.log('📈 FINAL SUMMARY:');
    console.log('═'.repeat(60));
    console.log(`Total tables: ${schemas.length}`);
    console.log(`Successfully loaded: ${totalLoaded}`);
    console.log(`Failed: ${totalFailed}`);
    console.log(`Total rows loaded: ${totalRows.toLocaleString()}`);
    console.log(`Total time: ${formatDuration(totalTime)}`);
    console.log(`Average speed: ${avgSpeed.toLocaleString()} rows/s`);
    console.log('═'.repeat(60));

    // Show slowest tables
    if (tableTimes.length > 0) {
      console.log('\n⏱️  Top 5 slowest tables:');
      tableTimes
        .sort((a, b) => b.time - a.time)
        .slice(0, 5)
        .forEach((t, idx) => {
          console.log(`  ${idx + 1}. ${t.name}: ${(t.time / 1000).toFixed(2)}s (${t.rows.toLocaleString()} rows)`);
        });
    }

    console.log('\n✅ Data loading complete!\n');

  } catch (error) {
    console.error('❌ Fatal error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

/**
 * Load a single CSV file into its table using COPY
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

    const columnNames = columns.map(c => `"${c}"`).join(', ');

    // Create COPY command
    const copyQuery = `COPY ${tableName} (${columnNames}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`;

    console.log(`  🔄 Starting COPY stream...`);

    // Get GCS stream
    const gcsStream = gcsService.getFileStream(filePath);

    // Create COPY stream
    const copyStream = client.query(copyFrom(copyQuery));

    let totalRows = 0;
    let lastLogTime = Date.now();
    const startTime = Date.now();

    // Track progress
    const progressTransform = new Transform({
      transform(chunk, encoding, callback) {
        // Count newlines to estimate rows
        const newlines = chunk.toString().split('\n').length - 1;
        totalRows += newlines;

        // Log progress every 2 seconds
        const now = Date.now();
        if (now - lastLogTime > 2000) {
          const elapsed = (now - startTime) / 1000;
          const speed = Math.round(totalRows / elapsed);
          process.stdout.write(`  ⏳ ${totalRows.toLocaleString()} rows | ${speed.toLocaleString()} rows/s | ${elapsed.toFixed(1)}s elapsed...\r`);
          lastLogTime = now;
        }

        callback(null, chunk);
      }
    });

    // Pipe GCS stream through progress tracker to COPY stream
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

    // Return row count (approximate from line count)
    return Math.max(0, totalRows - 1); // Subtract header line

  } finally {
    client.release();
  }
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

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
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
