/**
 * Load ONLY Sales Table
 *
 * Dedicated script for the problematic sales table
 * Uses COPY with extended timeout
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

// Extended timeout for large file
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,
  connectionTimeoutMillis: 300000,  // 5 minutes to connect
  statement_timeout: 3600000,       // 1 hour for statement
  query_timeout: 3600000            // 1 hour for query
});

async function loadSalesTable() {
  console.log('🎯 Loading SALES table only...\n');
  console.log('⚙️  Configuration:');
  console.log('  - Extended timeouts (1 hour)');
  console.log('  - Direct COPY streaming');
  console.log('  - Detailed progress tracking\n');

  try {
    // Load analysis
    const analysisData = await fs.readFile(ANALYSIS_FILE, 'utf8');
    const allSchemas = JSON.parse(analysisData);

    // Find sales table
    const schema = allSchemas.find(s => s.tableName === 'sales');

    if (!schema) {
      throw new Error('Sales table not found in analysis file');
    }

    console.log(`📊 Sales table info:`);
    console.log(`  - Columns: ${schema.columns.length}`);
    console.log(`  - File size: ${formatBytes(schema.fileSize)}`);
    console.log(`  - File path: ${schema.filePath}\n`);

    const client = await pool.connect();

    try {
      // Step 1: Truncate existing table (keep structure)
      console.log(`🗑️  Truncating existing sales table...`);
      await client.query(`TRUNCATE TABLE ${SCHEMA_NAME}.sales`);
      console.log(`✅ Table truncated\n`);

      // Step 2: Load data
      console.log(`📥 Starting COPY stream...\n`);
      const startTime = Date.now();
      const rows = await loadCSVFile(client, schema);
      const totalTime = (Date.now() - startTime) / 1000;
      const speed = Math.round(rows / totalTime);

      console.log(`\n✅ SUCCESS!`);
      console.log(`  - Rows loaded: ${rows.toLocaleString()}`);
      console.log(`  - Time: ${totalTime.toFixed(1)}s`);
      console.log(`  - Speed: ${speed.toLocaleString()} rows/s\n`);

    } finally {
      client.release();
    }

    console.log('═'.repeat(60));
    console.log('🎉 Sales table loaded successfully!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    throw error;
  } finally {
    await pool.end();
  }
}

async function loadCSVFile(client, schema) {
  const tableName = `${SCHEMA_NAME}.${schema.tableName}`;
  const filePath = schema.filePath;

  const columns = schema.columns.map(col =>
    sanitizeColumnName(col.name.replace(/^\uFEFF/, '').trim())
  );

  const columnNames = columns.map(c => `"${c}"`).join(', ');
  const copyQuery = `COPY ${tableName} (${columnNames}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')`;

  console.log(`🔄 Streaming from GCS...`);
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
      if (now - lastLogTime > 3000) {  // Log every 3 seconds
        const elapsed = (now - startTime) / 1000;
        const speed = Math.round(totalRows / elapsed);
        const percent = ((totalRows / 50000000) * 100).toFixed(1); // Estimate ~50M rows
        process.stdout.write(`⏳ ${totalRows.toLocaleString()} rows | ${speed.toLocaleString()} rows/s | ${elapsed.toFixed(0)}s | ~${percent}%\r`);
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
        resolve();
      })
      .on('error', (err) => {
        console.error('\n❌ Copy stream error:', err.message);
        reject(err);
      });

    gcsStream.on('error', (err) => {
      console.error('\n❌ GCS stream error:', err.message);
      reject(err);
    });

    progressTransform.on('error', (err) => {
      console.error('\n❌ Progress transform error:', err.message);
      reject(err);
    });
  });

  return Math.max(0, totalRows - 1);
}

function sanitizeColumnName(name) {
  return name
    .replace(/\0/g, '')
    .replace(/"/g, '""')
    .trim();
}

function formatBytes(bytes) {
  const size = parseInt(bytes);
  if (size === 0 || isNaN(size)) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(size) / Math.log(k));
  return Math.round(size / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

if (require.main === module) {
  loadSalesTable()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('\nScript failed:', error.message);
      process.exit(1);
    });
}

module.exports = { loadSalesTable };
