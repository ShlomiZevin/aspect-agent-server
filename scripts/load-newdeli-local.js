/**
 * Load New Deli CSV files from LOCAL disk into the newdeli schema.
 * Run: node scripts/load-newdeli-local.js [--csv-dir=C:/path/to/csvs]
 *
 * Streams each CSV file directly into PostgreSQL via COPY (no GCS needed).
 * Requires cloud-sql-proxy running on ZER4U_DB_PORT (5433).
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');
const fs = require('fs');
const path = require('path');
const { from: copyFrom } = require('pg-copy-streams');

const SCHEMA = 'newdeli';

// Default CSV directory — can override with --csv-dir=... arg
const DEFAULT_CSV_DIR = 'C:/Users/ziben/Downloads/CSV';

// CSV filename → table name mapping
const FILE_TO_TABLE = {
  'Facts_CSV.csv':              'facts',
  'OrderItems-12_CSV.csv':      'order_items',
  'Branches_CSV.csv':           'branches',
  'Medadim_CSV.csv':            'measures',
  'Memadim_CSV.csv':            'dimensions',
  'Taarichim_Hashvaa_CSV.csv':  'comparison_dates',
  'חגים_עבריים_CSV.csv': 'jewish_holidays',
  'תאריכים_עבריים_CSV.csv': 'hebrew_dates',
};
// Also add the Hebrew filename literals for environments that support it
FILE_TO_TABLE['חגים_עבריים_CSV.csv']     = 'jewish_holidays';
FILE_TO_TABLE['תאריכים_עבריים_CSV.csv']  = 'hebrew_dates';

function parseArgs() {
  const csvDirArg = process.argv.find(a => a.startsWith('--csv-dir='));
  return csvDirArg ? csvDirArg.split('=').slice(1).join('=') : DEFAULT_CSV_DIR;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

async function loadFile(pool, csvPath, tableName) {
  const stat = fs.statSync(csvPath);
  console.log('  Loading ' + path.basename(csvPath) + ' (' + formatBytes(stat.size) + ') → ' + SCHEMA + '.' + tableName);

  const client = await pool.connect();
  try {
    // 60-minute timeout for large files
    await client.query('SET statement_timeout = 3600000');

    const copySQL = `COPY ${SCHEMA}.${tableName} FROM STDIN WITH (FORMAT CSV, HEADER, ENCODING 'UTF8')`;
    const ingestStream = client.query(copyFrom(copySQL));

    const fileStream = fs.createReadStream(csvPath, { encoding: null });

    const startTime = Date.now();
    let bytesLoaded = 0;

    fileStream.on('data', chunk => { bytesLoaded += chunk.length; });

    await new Promise((resolve, reject) => {
      fileStream.on('error', reject);
      ingestStream.on('error', reject);
      ingestStream.on('finish', resolve);
      fileStream.pipe(ingestStream);
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('    Done in ' + duration + 's (' + formatBytes(bytesLoaded) + ' loaded)');
    return true;
  } catch (err) {
    console.error('    ERROR: ' + err.message);
    return false;
  } finally {
    client.release();
  }
}

async function loadAllFiles(csvDir) {
  console.log('Loading New Deli CSV files from: ' + csvDir + '\n');

  const pool = getPool();

  // Build list of files to load
  const toLoad = [];
  for (const [fileName, tableName] of Object.entries(FILE_TO_TABLE)) {
    const csvPath = path.join(csvDir, fileName);
    if (!fs.existsSync(csvPath)) continue;
    const stat = fs.statSync(csvPath);
    // Skip files with only a header (size < 200 bytes means essentially empty)
    if (stat.size < 200) {
      console.log('  Skipping ' + fileName + ' (empty / header only)');
      continue;
    }
    toLoad.push({ csvPath, tableName });
  }

  if (toLoad.length === 0) {
    console.error('No CSV files found in ' + csvDir);
    process.exit(1);
  }

  console.log('Found ' + toLoad.length + ' files to load:\n');
  toLoad.forEach(f => console.log('  ' + path.basename(f.csvPath) + ' → ' + f.tableName));
  console.log('');

  // Load sequentially (avoid overwhelming Cloud SQL proxy)
  let ok = 0, fail = 0;
  const startAll = Date.now();

  for (const { csvPath, tableName } of toLoad) {
    const success = await loadFile(pool, csvPath, tableName);
    if (success) ok++; else fail++;
  }

  const totalSec = ((Date.now() - startAll) / 1000).toFixed(0);
  console.log('\n' + '='.repeat(60));
  console.log('DONE in ' + totalSec + 's — OK: ' + ok + '  Failed: ' + fail);
  if (fail === 0) {
    console.log('Next: node scripts/create-newdeli-indexes.js');
  }

  await endPool();
}

if (require.main === module) {
  const csvDir = parseArgs();
  loadAllFiles(csvDir).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { loadAllFiles };
