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

const ANALYSIS_FILE = path.join(__dirname, '..', 'data', 'zer4u-schema-analysis.json');

async function loadAllCSVFiles(schemaName = 'zer4u', onProgress = null) {
  // Pool created inside function so multiple sequential calls are safe
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 8
  });
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

    // Files <= 100 MB load in parallel (up to 4 at once).
    // Files > 100 MB load one at a time — they saturate DB/network I/O on their own.
    const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100 MB
    const SMALL_CONCURRENCY = 4;

    const smallFiles = schemas.filter(s => (parseInt(s.fileSize) || 0) <= LARGE_FILE_THRESHOLD);
    const largeFiles = schemas.filter(s => (parseInt(s.fileSize) || 0) > LARGE_FILE_THRESHOLD);

    console.log(`📦 Small files (parallel x${SMALL_CONCURRENCY}): ${smallFiles.length}`);
    console.log(`🐘 Large files (sequential):  ${largeFiles.length}\n`);

    let fileIndex = 0;

    const loadOne = async (schema, i) => {
      if (schema.error) {
        console.log(`[${i + 1}/${schemas.length}] ⏭️  Skipping ${schema.fileName} (analysis error)`);
        totalFailed++;
        return;
      }

      console.log(`\n[${i + 1}/${schemas.length}] 📥 Loading: ${schema.fileName} (${formatBytes(schema.fileSize)})`);
      if (onProgress) onProgress({ type: 'file_start', file: schema.fileName, index: i, totalFiles: schemas.length });

      const tableStart = Date.now();
      try {
        const result = await loadCSVFile(schema, schemaName, pool, onProgress);
        const tableTime = Date.now() - tableStart;
        tableTimes.push({ name: schema.tableName, time: tableTime, rows: result });
        const speed = result > 0 ? Math.round(result / (tableTime / 1000)) : 0;
        console.log(`  ✅ ${schema.fileName}: ${result.toLocaleString()} rows in ${(tableTime / 1000).toFixed(1)}s (${speed.toLocaleString()} rows/s)`);
        if (onProgress) onProgress({ type: 'file_complete', file: schema.fileName, rows: result, durationMs: tableTime });
        totalLoaded++;
        totalRows += result;
      } catch (error) {
        console.error(`  ❌ ${schema.fileName}: ${error.message}`);
        if (onProgress) onProgress({ type: 'file_error', file: schema.fileName, error: error.message });
        totalFailed++;
      }
    };

    // Phase A: small files in parallel batches
    for (let i = 0; i < smallFiles.length; i += SMALL_CONCURRENCY) {
      const batch = smallFiles.slice(i, i + SMALL_CONCURRENCY).map(schema => loadOne(schema, fileIndex++));
      await Promise.all(batch);
    }

    // Phase B: large files one at a time
    for (const schema of largeFiles) {
      await loadOne(schema, fileIndex++);
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

    if (totalFailed > 0) {
      throw new Error(`${totalFailed} file(s) failed to load — aborting swap to prevent incomplete data`);
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
async function loadCSVFile(schema, schemaName, pool, onProgress = null) {
  const client = await pool.connect();

  try {
    const tableName = `${schemaName}.${schema.tableName}`;
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
          if (onProgress) onProgress({ type: 'file_progress', file: schema.fileName, rowsLoaded: totalRows });
          lastLogTime = now;
        }

        callback(null, chunk);
      }
    });

    // Pipe GCS stream through progress tracker to COPY stream
    // Watchdog: if no bytes flow for N minutes, destroy the stream to prevent infinite hang.
    // Large files (>100 MB) get a longer timeout because Cloud SQL can backpressure for several
    // minutes while processing a heavy COPY batch — that is normal, not a stall.
    const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
    const STALL_TIMEOUT_MS = (parseInt(schema.fileSize) || 0) > LARGE_FILE_THRESHOLD
      ? 15 * 60 * 1000   // 15 min for large files
      : 5 * 60 * 1000;   // 5 min for small files
    let lastByteTime = Date.now();
    let watchdog;

    const resetWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        gcsStream.destroy(new Error(`COPY stalled: no data for ${STALL_TIMEOUT_MS / 60000} minutes`));
      }, STALL_TIMEOUT_MS);
    };

    const originalTransform = progressTransform._transform.bind(progressTransform);
    progressTransform._transform = function(chunk, encoding, callback) {
      lastByteTime = Date.now();
      resetWatchdog();
      originalTransform(chunk, encoding, callback);
    };

    resetWatchdog();

    await new Promise((resolve, reject) => {
      gcsStream
        .pipe(progressTransform)
        .pipe(copyStream)
        .on('finish', () => {
          clearTimeout(watchdog);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = Math.round(totalRows / elapsed);
          process.stdout.write(`  ✅ ${totalRows.toLocaleString()} rows | ${speed.toLocaleString()} rows/s | ${elapsed.toFixed(1)}s\n`);
          resolve();
        })
        .on('error', (err) => { clearTimeout(watchdog); reject(err); });

      gcsStream.on('error', (err) => { clearTimeout(watchdog); reject(err); });
      progressTransform.on('error', (err) => { clearTimeout(watchdog); reject(err); });
    });

    // Return row count (approximate from line count)
    const rowCount = Math.max(0, totalRows - 1); // Subtract header line
    client.release(); // normal release only on success
    return rowCount;

  } catch (err) {
    // Destroy the connection — a failed mid-stream COPY leaves the pg protocol
    // in an undefined state; returning it to the pool would corrupt subsequent files.
    client.release(err);
    throw err;
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
