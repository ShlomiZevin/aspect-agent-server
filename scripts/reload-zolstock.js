/**
 * Zol Stock Reload — two-phase zero-downtime reload.
 * Mirrors reload-hypertoy.js / reload-thestock.js exactly.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TODO (fill once Itzik delivers the data):                                 │
 * │   1. Set GCS_FOLDER to the bucket prefix the CSVs land in.                │
 * │   2. Populate FILE_TO_TABLE — map each CSV basename to a DB table name.   │
 * │   3. Fill column-aliases-zolstock.js (Hebrew → English column mapping).   │
 * │   4. Fill create-zolstock-indexes.js (JOIN / filter indexes).            │
 * │   5. Update getZolStockDataInfo() to point at the real fact table/date.  │
 * │ Until then FILE_TO_TABLE is empty (load is a no-op) and the reloader is   │
 * │ DISABLED by default (ZOLSTOCK_RELOAD_ENABLED !== 'true').                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Phase 1 — loadZolStock(targetSchema, emitLog):
 *   Scan GCS → read CSV headers → create tables → COPY data
 * Phase 2 — indexZolStock(targetSchema, emitLog):
 *   Create indexes. DataReloadService handles the atomic schema swap.
 */

require('dotenv').config();
const gcsService = require('../services/gcs.service');
const { getPool } = require('../services/db.zer4u');
const { buildColumnLookup } = require('./column-aliases-zolstock');
const { createSchema } = require('./create-zolstock-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-zolstock-indexes');
const { createMVs } = require('./create-zolstock-mvs');

const GCS_FOLDER = 'zolstock/';

const FILE_TO_TABLE = {
  'Facts_ZolStock_CSV.csv': 'facts',
  // Dimension files (products / customers / stores / calendar) — add when delivered.
};

function formatBytes(bytes) {
  const size = parseInt(bytes);
  if (!size || isNaN(size)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(size) / Math.log(k));
  return (size / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

async function buildSchemasFromHeaders(gcsFiles, emitLog) {
  const schemas = [];
  for (let i = 0; i < gcsFiles.length; i++) {
    const file = gcsFiles[i];
    const tableName = FILE_TO_TABLE[file.basename];
    if (!tableName) continue;

    try {
      const headers = await gcsService.getCSVHeaders(file.name);
      const lookup = buildColumnLookup(tableName);

      const columns = headers.map(h => {
        const csvName = h.replace(/^﻿/, '').trim();
        const def = lookup.get(csvName);
        return { csvName, name: def ? def.dbName : csvName, type: def ? def.type : 'TEXT' };
      });

      schemas.push({ fileName: file.basename, filePath: file.name, fileSize: file.size, tableName, columns });
      emitLog('scanning', `[${i + 1}/${gcsFiles.length}] ${file.basename}: ${headers.length} columns`, {
        filesCompleted: i + 1,
        totalFiles: gcsFiles.length,
      });
    } catch (err) {
      emitLog('scanning', `[${i + 1}/${gcsFiles.length}] ${file.basename}: header read failed — ${err.message}`);
      schemas.push({ fileName: file.basename, filePath: file.name, fileSize: file.size, tableName, error: err.message });
    }
  }
  return schemas;
}

// ── Phase 1: Import ───────────────────────────────────────────────────────────

async function loadZolStock(targetSchema, emitLog) {
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  emitLog('scanning', 'Listing CSV files from GCS...');
  const gcsFiles = await gcsService.listCSVFiles(GCS_FOLDER);
  const validFiles = gcsFiles.filter(f => FILE_TO_TABLE[f.basename]);
  emitLog('scanning', `Found ${validFiles.length} CSV files — reading headers...`);

  if (validFiles.length === 0) {
    emitLog('scanning', 'No mapped CSV files found — fill FILE_TO_TABLE in reload-zolstock.js.');
    return { totalFiles: 0, filesLoaded: 0, totalRows: 0, fileResults: [], qualityReport: {} };
  }

  const schemas = await buildSchemasFromHeaders(validFiles, emitLog);
  const totalFiles = schemas.length;
  const totalSize = schemas.reduce((sum, s) => sum + parseInt(s.fileSize || 0), 0);
  emitLog('scanning', `Schema ready: ${totalFiles} tables (${formatBytes(totalSize)})`, { totalFiles });

  emitLog('creating_schema', `Creating tables in ${targetSchema}...`);
  await createSchema(targetSchema, schemas);
  emitLog('creating_schema', `Tables created in ${targetSchema}`);

  emitLog('loading_data', `Starting data load into ${targetSchema}...`);

  const onProgress = (event) => {
    if (event.type === 'file_start') {
      emitLog('loading_data', `Loading ${event.file}...`, {
        file: event.file, totalFiles, filesCompleted: filesLoaded,
      });
    } else if (event.type === 'file_progress') {
      const msg = event.finalizing
        ? `${event.file}: ${event.rowsLoaded.toLocaleString()} rows — waiting for PostgreSQL commit${event.finalizingSec > 0 ? ` (${event.finalizingSec}s)` : ''}...`
        : `${event.file}: ${event.rowsLoaded.toLocaleString()} rows so far...`;
      emitLog('loading_data', msg, {
        file: event.file, rowsLoaded: event.rowsLoaded, totalFiles, filesCompleted: filesLoaded, progressOnly: true,
      });
    } else if (event.type === 'file_complete') {
      filesLoaded++;
      totalRows += event.rows;
      fileResults.push({ file: event.file, status: 'loaded', rows: event.rows, durationMs: event.durationMs });
      emitLog('loading_data', `Loaded ${event.file}: ${event.rows.toLocaleString()} rows`, {
        file: event.file, rows: event.rows, totalFiles, filesCompleted: filesLoaded,
      });
    } else if (event.type === 'file_error') {
      filesLoaded++;
      fileResults.push({ file: event.file, status: 'error', error: event.error });
      emitLog('loading_data', `Error loading ${event.file}: ${event.error}`, {
        file: event.file, totalFiles, filesCompleted: filesLoaded,
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

async function indexZolStock(targetSchema, emitLog) {
  emitLog('creating_indexes', `Creating indexes on ${targetSchema}...`);
  await createIndexes(targetSchema, emitLog);
  emitLog('creating_indexes', 'Indexes created');

  // After indexes: build materialized views. MVs precompute the heavy sales
  // aggregations so the agent answers top-N / revenue-&-profit-by-period
  // questions within the 15s timeout (reads thousands of MV rows vs ~35M facts).
  emitLog('creating_views', `Creating materialized views on ${targetSchema}...`);
  await createMVs(targetSchema, emitLog);
  emitLog('creating_views', 'Materialized views ready');
}

// ── Data info ─────────────────────────────────────────────────────────────────

async function getZolStockDataInfo() {
  const pool = getPool();
  try {
    // TODO: point at the real fact table / date column once the schema is known.
    const result = await pool.query(
      `SELECT TO_CHAR(MAX("transaction_date"), 'YYYY-MM') AS last_month
       FROM zolstock.facts
       WHERE "record_type" = 'מכירות'`
    );
    return result.rows[0]?.last_month || null;
  } catch {
    return null;
  }
}

module.exports = { loadZolStock, indexZolStock, getZolStockDataInfo };
