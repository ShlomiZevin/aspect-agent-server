/**
 * Zer4U Zero-Downtime Reload — Split into two phases:
 *
 * Phase 1 — loadZer4u(targetSchema, emitLog):
 *   Scan GCS → create tables (UNLOGGED) → load CSV data via COPY
 *   Shadow schema is left in place with raw data, no indexes.
 *
 * Phase 2 — indexZer4u(targetSchema, emitLog):
 *   Create indexes + helper functions → create materialized views
 *   DataReloadService handles the atomic schema swap after this.
 */

require('dotenv').config();
const { createSchema } = require('./create-zer4u-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-zer4u-indexes-v2');
const { createViews } = require('./create-materialized-views');
const { scanAllCSVFiles } = require('./scan-csv-files');

// ── Phase 1: Import ───────────────────────────────────────────────────────────

async function loadZer4u(targetSchema, emitLog) {
  let totalFiles = 0;
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  emitLog('scanning', 'Scanning CSV files from GCS...');
  const schemas = await scanAllCSVFiles();
  totalFiles = schemas.length;
  const totalSize = schemas.reduce((sum, s) => sum + parseInt(s.fileSize || 0), 0);
  emitLog('scanning', `Found ${totalFiles} CSV files (${formatBytes(totalSize)})`);

  emitLog('creating_schema', `Creating tables in ${targetSchema}...`);
  await createSchema(targetSchema, schemas);
  emitLog('creating_schema', `Tables created in ${targetSchema}`);

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
        progressOnly: true,
      });
    } else if (event.type === 'file_complete') {
      filesLoaded++;
      totalRows += event.rows;
      fileResults.push({ file: event.file, status: 'loaded', rows: event.rows, durationMs: event.durationMs });
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

  await loadAllCSVFiles(targetSchema, onProgress, schemas);
  emitLog('loading_data', `Data load complete: ${filesLoaded}/${totalFiles} files, ${totalRows.toLocaleString()} rows`);

  return { totalFiles, filesLoaded, totalRows, fileResults };
}

// ── Phase 2: Indexing ─────────────────────────────────────────────────────────

async function indexZer4u(targetSchema, emitLog, referenceSchema) {
  emitLog('creating_indexes', 'Creating helper functions and indexes...');
  await createIndexes(targetSchema, emitLog, referenceSchema);
  emitLog('creating_indexes', 'Indexes created');

  emitLog('creating_views', 'Creating materialized views...');
  await createViews(targetSchema, emitLog);
  emitLog('creating_views', 'All materialized views created');
}

// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  const size = parseInt(bytes);
  if (!size || isNaN(size)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(size) / Math.log(k));
  return (size / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

/**
 * Returns the last date of data in the zer4u sales table.
 * Uses the functional index on parse_date_ddmmyyyy for fast MAX lookup.
 * Falls back to mv_sales_by_month if the index isn't available yet.
 */
async function getZer4uDataInfo(db) {
  try {
    const result = await db.query(
      `SELECT TO_CHAR(MAX(zer4u.parse_date_ddmmyyyy("תאריך מקורי SALES")), 'YYYY-MM') AS last_date FROM zer4u.sales`
    );
    return result.rows[0]?.last_date || null;
  } catch {
    // Fall back to materialized view if sales table or function not available
    try {
      const result = await db.query(
        `SELECT MAX(year_month) AS last_month FROM zer4u.mv_sales_by_month`
      );
      return result.rows[0]?.last_month || null;
    } catch {
      return null;
    }
  }
}

module.exports = { loadZer4u, indexZer4u, getZer4uDataInfo };
