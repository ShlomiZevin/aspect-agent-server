/**
 * Zer4U Zero-Downtime Reload Function
 *
 * Loads all CSV data from GCS into a given target schema.
 * Called by DataReloadService with a shadow schema name (e.g. 'zer4u_new').
 * The shadow swap itself is handled by DataReloadService.
 *
 * Steps:
 *   1. Scan GCS source files
 *   2. Create tables (DROP+CREATE schema, then create tables)
 *   3. Load CSV data via COPY
 *   4. Create indexes + helper functions
 *   5. Create materialized views
 *
 * @param {string} targetSchema - Schema to load into (e.g. 'zer4u_new')
 * @param {Function} emitLog    - (step, message, data?) => void
 * @returns {Promise<{totalFiles, filesLoaded, totalRows, fileResults}>}
 */

require('dotenv').config();
const gcsService = require('../services/gcs.service');
const { createSchema } = require('./create-zer4u-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-zer4u-indexes-v2');
const { createViews } = require('./create-materialized-views');

const GCS_FOLDER = 'zer4u/';

async function reloadZer4u(targetSchema, emitLog) {
  let totalFiles = 0;
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  // ── 1. Scan GCS source files ──────────────────────────────────────
  emitLog('scanning', 'Listing CSV files from GCS...');
  const gcsFiles = await gcsService.listCSVFiles(GCS_FOLDER);
  totalFiles = gcsFiles.length;
  const totalSize = gcsFiles.reduce((sum, f) => sum + parseInt(f.size || 0), 0);
  emitLog('scanning', `Found ${totalFiles} CSV files (${formatBytes(totalSize)})`);

  // ── 2. Create schema + tables ─────────────────────────────────────
  emitLog('creating_schema', `Creating tables in ${targetSchema}...`);
  await createSchema(targetSchema);
  emitLog('creating_schema', `Tables created in ${targetSchema}`);

  // ── 3. Load CSV data ──────────────────────────────────────────────
  emitLog('loading_data', `Starting data load into ${targetSchema}...`);

  const onProgress = (event) => {
    if (event.type === 'file_start') {
      emitLog('loading_data', `Loading ${event.file}...`, {
        file: event.file,
        totalFiles,
        filesCompleted: filesLoaded,
      });
    } else if (event.type === 'file_progress') {
      emitLog('loading_data', `${event.file}: ${event.rowsLoaded.toLocaleString()} rows so far...`, {
        file: event.file,
        rowsLoaded: event.rowsLoaded,
        totalFiles,
        filesCompleted: filesLoaded,
      });
    } else if (event.type === 'file_complete') {
      filesLoaded++;
      totalRows += event.rows;
      fileResults.push({
        file: event.file,
        status: 'loaded',
        rows: event.rows,
        durationMs: event.durationMs,
      });
      emitLog('loading_data', `Loaded ${event.file}: ${event.rows.toLocaleString()} rows`, {
        file: event.file,
        rows: event.rows,
        totalFiles,
        filesCompleted: filesLoaded,
      });
    } else if (event.type === 'file_error') {
      filesLoaded++;
      fileResults.push({ file: event.file, status: 'error', error: event.error });
      emitLog('loading_data', `Error loading ${event.file}: ${event.error}`, {
        file: event.file,
        error: event.error,
      });
    }
  };

  await loadAllCSVFiles(targetSchema, onProgress);
  emitLog('loading_data', `Data load complete: ${filesLoaded}/${totalFiles} files, ${totalRows.toLocaleString()} rows`);

  // ── 4. Create indexes + helper functions ──────────────────────────
  emitLog('creating_indexes', 'Creating helper functions and indexes...');
  await createIndexes(targetSchema);
  emitLog('creating_indexes', 'Indexes created');

  // ── 5. Create materialized views ──────────────────────────────────
  emitLog('creating_views', 'Creating materialized views...');
  await createViews(targetSchema);
  emitLog('creating_views', 'All 6 materialized views created');

  return { totalFiles, filesLoaded, totalRows, fileResults };
}

function formatBytes(bytes) {
  const size = parseInt(bytes);
  if (!size || isNaN(size)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(size) / Math.log(k));
  return (size / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

module.exports = { reloadZer4u };

// Run directly for manual testing: node scripts/reload-zer4u-zero-downtime.js
if (require.main === module) {
  const emitLog = (step, message) => console.log(`[${step}] ${message}`);
  reloadZer4u('zer4u_test', emitLog)
    .then(r => { console.log('Done:', r); process.exit(0); })
    .catch(e => { console.error('Error:', e); process.exit(1); });
}
