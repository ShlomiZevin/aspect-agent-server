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

async function loadZer4u(targetSchema, emitLog) {
  let totalFiles = 0;
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  emitLog('scanning', 'Listing CSV files from GCS...');
  const gcsFiles = await gcsService.listCSVFiles(GCS_FOLDER);
  emitLog('scanning', `Found ${gcsFiles.length} CSV files — reading headers...`);
  const schemas = await buildSchemasFromHeaders(gcsFiles, emitLog);
  totalFiles = schemas.length;
  const totalSize = schemas.reduce((sum, s) => sum + parseInt(s.fileSize || 0), 0);
  emitLog('scanning', `Schema ready: ${totalFiles} tables (${formatBytes(totalSize)})`);

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

  const { qualityReport } = await loadAllCSVFiles(targetSchema, onProgress, schemas) || {};

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
 * Returns the last data month from zer4u.
 * Primary: mv_sales_by_month (pre-aggregated, instant).
 * Fallback: MAX(sale_date) on the indexed DATE column with a 5s timeout.
 */
async function getZer4uDataInfo(db) {
  try {
    const result = await db.query(
      `SELECT MAX(year_month) AS last_month FROM zer4u.mv_sales_by_month`
    );
    if (result.rows[0]?.last_month) return result.rows[0].last_month;
  } catch {
    // MV not available yet (e.g. first ever load)
  }
  try {
    const client = await db.getClient();
    try {
      await client.query(`SET statement_timeout = 5000`);
      const result = await client.query(
        `SELECT TO_CHAR(MAX(sale_date), 'YYYY-MM') AS last_date FROM zer4u.sales`
      );
      return result.rows[0]?.last_date || null;
    } finally {
      client.release();
    }
  } catch {
    return null;
  }
}

module.exports = { loadZer4u, indexZer4u, getZer4uDataInfo };
