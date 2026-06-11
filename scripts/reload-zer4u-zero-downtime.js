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
const gcsService = require('../services/gcs.service');
const { createSchema } = require('./create-zer4u-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-zer4u-indexes-v2');
const { createViews } = require('./create-materialized-views');
const { buildColumnLookup } = require('./column-aliases');

const GCS_FOLDER = 'zer4u/';

// Tables present in the source export but never used by the agent — not in any
// materialized view, index, column-aliases mapping, or generated query. Skipped
// from import to save storage. These are the two largest unused tables:
//   linktable   — Qlik bridge table (26.5M rows, ~1.7 GB; all keys, no measures)
//   shorot_kbla — credit-card payment detail (7.7M rows, ~476 MB; out of scope)
const SKIP_TABLES = new Set(['linktable', 'shorot_kbla']);

// Hebrew → English table name mapping (same as scan-csv-files.js)
const HEBREW_TABLE_NAMES = {
  'חנויות.csv': 'stores',
  'יעדים.csv': 'targets',
  'לקוחות.csv': 'customers',
  'מולטיפס.csv': 'multips',
  'מכירות.csv': 'sales',
  'מלאי מחסנים.csv': 'warehouse_inventory',
  'מלאי מינימום.csv': 'min_inventory',
  'מלאי.csv': 'inventory',
  'פריטים.csv': 'items',
  'תאריכי ספירת מלאי.csv': 'inventory_count_dates'
};

function sanitizeTableName(fileName) {
  if (HEBREW_TABLE_NAMES[fileName]) return HEBREW_TABLE_NAMES[fileName];
  return fileName
    .replace('.csv', '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Build schema definitions from GCS file list + CSV headers only.
 * Reads just the first line of each file — no data rows downloaded.
 *
 * For each CSV header column, looks it up in column-aliases to determine:
 *   - type: DATE / INTEGER / NUMERIC / TEXT
 *   - name: English DB column name (for known concepts) or sanitized original
 *
 * The TypeConvertTransform in load-csv-to-db-copy.js will convert values at
 * runtime for non-TEXT columns so they arrive at PostgreSQL in the right format.
 */
async function buildSchemasFromHeaders(gcsFiles, emitLog) {
  const schemas = [];
  for (let i = 0; i < gcsFiles.length; i++) {
    const file = gcsFiles[i];
    try {
      const headers = await gcsService.getCSVHeaders(file.name);
      const tableName = sanitizeTableName(file.basename);
      const lookup = buildColumnLookup(tableName);

      const columns = headers.map(h => {
        const csvName = h.replace(/^﻿/, '').trim();
        const schema = lookup.get(csvName);
        return {
          csvName,
          name: schema ? schema.dbName : csvName,  // English if known, original otherwise
          type: schema ? schema.type : 'TEXT',
        };
      });

      schemas.push({
        fileName: file.basename,
        filePath: file.name,
        fileSize: file.size,
        tableName,
        columns,
      });
      emitLog('scanning', `[${i + 1}/${gcsFiles.length}] ${file.basename}: ${headers.length} columns`, {
        filesCompleted: i + 1,
        totalFiles: gcsFiles.length,
      });
    } catch (err) {
      emitLog('scanning', `[${i + 1}/${gcsFiles.length}] ${file.basename}: header read failed — ${err.message}`);
      schemas.push({ fileName: file.basename, filePath: file.name, fileSize: file.size, error: err.message });
    }
  }
  return schemas;
}

// ── Phase 1: Import ───────────────────────────────────────────────────────────

async function loadZer4u(targetSchema, emitLog, options = {}) {
  let totalFiles = 0;
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  // Import window: keep only the last N months of fact data (sales). 0 = load all.
  // Comes from DataReloadService (DB/env); env fallback is for direct CLI runs.
  const importMonths = options.importMonths != null
    ? options.importMonths
    : (parseInt(process.env.ZER4U_IMPORT_MONTHS || '0', 10) || 0);
  if (importMonths > 0) {
    emitLog('scanning', `Import window: keeping last ${importMonths} month(s) of sales (relative to latest sale date)`);
  } else {
    emitLog('scanning', 'Import window: loading all available data (no date filter)');
  }

  emitLog('scanning', 'Listing CSV files from GCS...');
  const allFiles = await gcsService.listCSVFiles(GCS_FOLDER);
  const gcsFiles = allFiles.filter(f => !SKIP_TABLES.has(sanitizeTableName(f.basename)));
  const skippedCount = allFiles.length - gcsFiles.length;
  if (skippedCount > 0) {
    emitLog('scanning', `Skipping ${skippedCount} unused table(s): ${[...SKIP_TABLES].join(', ')}`);
  }
  emitLog('scanning', `Found ${allFiles.length} CSV files (${gcsFiles.length} to load) — reading headers...`);
  const schemas = await buildSchemasFromHeaders(gcsFiles, emitLog);
  totalFiles = schemas.length;
  const totalSize = schemas.reduce((sum, s) => sum + parseInt(s.fileSize || 0), 0);
  emitLog('scanning', `Schema ready: ${totalFiles} tables (${formatBytes(totalSize)})`);

  emitLog('creating_schema', `Creating tables in ${targetSchema}...`);
  await createSchema(targetSchema, schemas);
  emitLog('creating_schema', `Tables created in ${targetSchema}`);

  emitLog('loading_data', `Starting data load into ${targetSchema}...`);

  const onProgress = (event) => {
    if (event.type === 'file_scan') {
      emitLog('loading_data', `Scanning ${event.file} for latest date (import window)...`, {
        file: event.file,
        totalFiles,
        filesCompleted: filesLoaded,
      });
    } else if (event.type === 'file_start') {
      emitLog('loading_data', `Loading ${event.file}...`, {
        file: event.file,
        totalFiles,
        filesCompleted: filesLoaded,
      });
    } else if (event.type === 'file_progress') {
      const msg = event.finalizing
        ? `${event.file}: ${event.rowsLoaded.toLocaleString()} rows — waiting for PostgreSQL commit${event.finalizingSec > 0 ? ` (${event.finalizingSec}s)` : ''}...`
        : `${event.file}: ${event.rowsLoaded.toLocaleString()} rows so far...`;
      emitLog('loading_data', msg, {
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

  const { qualityReport, skippedReport } = await loadAllCSVFiles(targetSchema, onProgress, schemas, { importMonths }) || {};

  if (importMonths > 0) {
    const totalSkipped = Object.values(skippedReport || {}).reduce((s, n) => s + n, 0);
    if (totalSkipped > 0) {
      const detail = Object.entries(skippedReport)
        .map(([file, n]) => `${file}: ${n.toLocaleString()}`).join(', ');
      emitLog('loading_data', `Date filter: skipped ${totalSkipped.toLocaleString()} rows older than the ${importMonths}-month window (${detail})`);
    } else {
      emitLog('loading_data', `Date filter active (${importMonths} months) but no rows fell outside the window`);
    }
  }

  const tablesWithIssues = Object.keys(qualityReport || {}).length;
  if (tablesWithIssues > 0) {
    const totalNullified = Object.values(qualityReport).reduce((sum, cols) =>
      sum + Object.values(cols).reduce((s, c) => s + c.nullified, 0), 0);
    emitLog('data_quality', `Type conversion: ${totalNullified} values nullified across ${tablesWithIssues} table(s)`, { qualityReport });
  } else {
    emitLog('data_quality', 'Type conversion: all values loaded cleanly');
  }

  emitLog('loading_data', `Data load complete: ${filesLoaded}/${totalFiles} files, ${totalRows.toLocaleString()} rows`);

  return { totalFiles, filesLoaded, totalRows, fileResults, qualityReport: qualityReport || {} };
}

// ── Phase 2: Indexing ─────────────────────────────────────────────────────────

async function indexZer4u(targetSchema, emitLog, referenceSchema, options = {}) {
  emitLog('creating_indexes', 'Creating helper functions and indexes...');
  await createIndexes(targetSchema, emitLog, referenceSchema);
  emitLog('creating_indexes', 'Indexes created');

  emitLog('creating_views', 'Creating materialized views...');
  await createViews(targetSchema, emitLog, options);
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
 * Returns the exact last data date from zer4u as 'YYYY-MM-DD'.
 * Primary: MAX(sale_date) on the indexed DATE column (idx_sales_sale_date makes
 * this an instant index scan) — gives the precise day data is current through.
 * Fallback: month-only from mv_sales_by_month ('YYYY-MM') if the base table is
 * unavailable (e.g. mid-reload). Consumers must handle both formats.
 * Note: sale_date is a DATE column, so there is no hour component to report.
 */
async function getZer4uDataInfo(db) {
  try {
    const client = await db.getClient();
    try {
      await client.query(`SET statement_timeout = 5000`);
      const result = await client.query(
        `SELECT TO_CHAR(MAX(sale_date), 'YYYY-MM-DD') AS last_date FROM zer4u.sales`
      );
      if (result.rows[0]?.last_date) return result.rows[0].last_date;
    } finally {
      client.release();
    }
  } catch {
    // Base table unavailable (e.g. first ever load / mid-reload) — fall through.
  }
  try {
    const result = await db.query(
      `SELECT MAX(year_month) AS last_month FROM zer4u.mv_sales_by_month`
    );
    return result.rows[0]?.last_month || null;
  } catch {
    return null;
  }
}

module.exports = { loadZer4u, indexZer4u, getZer4uDataInfo };
