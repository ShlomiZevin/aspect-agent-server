/**
 * Teva Naot Reload — two-phase zero-downtime reload.
 * Mirrors reload-zolstock.js / reload-hypertoy.js exactly.
 *
 * Source: QlikSense export, GCS folder `tevanaot/`. The fact tables carry only
 * measures + a synthetic composite key (WARHS-CUST-PART-DATE etc.). We do NOT load
 * the LINK_TABLE (1.2GB bridge) or the Calendar files (12M empty rows) — every key
 * self-resolves via regexp, and date attributes are computed in SQL. See
 * create-tevanaot-mvs.js (mv_sales resolves the sales key once at index time).
 *
 * Phase 1 — loadTevaNaot(targetSchema, emitLog):
 *   Scan GCS -> read CSV headers -> create tables -> COPY data
 * Phase 2 — indexTevaNaot(targetSchema, emitLog):
 *   Create indexes + materialized views. DataReloadService handles the swap.
 */

require('dotenv').config();
const gcsService = require('../services/gcs.service');
const { getPool } = require('../services/db.zer4u');
const { buildColumnLookup } = require('./column-aliases-tevanaot');
const { createSchema } = require('./create-tevanaot-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-tevanaot-indexes');
const { createMVs } = require('./create-tevanaot-mvs');

const GCS_FOLDER = 'tevanaot/';

// Map each GCS CSV basename to its DB table. Names are kept exactly as exported
// (Teva_Naot_Israel_* prefix). LINK_TABLE / Calendar / CalendarGroupA-B /
// Dynamic_Report_* are intentionally omitted (bridge / metadata / empty junk).
const FILE_TO_TABLE = {
  'Teva_Naot_Israel_SALES.csv':             'sales',
  'Teva_Naot_Israel_PARTS.csv':             'parts',
  'Teva_Naot_Israel_INVENTORY.csv':         'inventory',
  'Teva_Naot_Israel_INVENTORY_IN_DATE.csv': 'inventory_in_date',
  'Teva_Naot_Israel_ORDERS.csv':            'orders',
  'Teva_Naot_Israel_CUSTOMERS.csv':         'customers',
  'Teva_Naot_Israel_SITES.csv':             'sites',
  'Teva_Naot_Israel_SALESRATE.csv':         'sales_rate',
  'Teva_Naot_Israel_הזמנות_רכש.csv':        'purchase_orders',
  'Teva_Naot_Israel_ספקים.csv':             'suppliers',
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

async function loadTevaNaot(targetSchema, emitLog, options = {}) {
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  // Import window: keep only the last N months of fact data. 0 = load all.
  // NOTE: Teva's sales rows have no plain DATE column (the date is inside the
  // composite key), so the date-scan filter simply won't apply to sales — it
  // loads all. Kept for parity with the other reloaders.
  const importMonths = options.importMonths != null
    ? options.importMonths
    : (parseInt(process.env.TEVANAOT_IMPORT_MONTHS || '0', 10) || 0);
  if (importMonths > 0) {
    emitLog('scanning', `Import window: keeping last ${importMonths} month(s) of data (relative to latest date)`);
  } else {
    emitLog('scanning', 'Import window: loading all available data (no date filter)');
  }

  emitLog('scanning', 'Listing CSV files from GCS...');
  const gcsFiles = await gcsService.listCSVFiles(GCS_FOLDER);
  const validFiles = gcsFiles.filter(f => FILE_TO_TABLE[f.basename]);
  emitLog('scanning', `Found ${validFiles.length} mapped CSV files — reading headers...`);

  if (validFiles.length === 0) {
    emitLog('scanning', 'No mapped CSV files found in tevanaot/ — check FILE_TO_TABLE / upload.');
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
    if (event.type === 'file_scan') {
      emitLog('loading_data', `Scanning ${event.file} for latest date (import window)...`, {
        file: event.file, totalFiles, filesCompleted: filesLoaded,
      });
    } else if (event.type === 'file_start') {
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

async function indexTevaNaot(targetSchema, emitLog) {
  emitLog('creating_indexes', `Creating indexes on ${targetSchema}...`);
  await createIndexes(targetSchema, emitLog);
  emitLog('creating_indexes', 'Indexes created');

  // After indexes: build materialized views. mv_sales resolves the sales key into
  // typed transaction_date / warhs / part columns once, so the agent answers
  // revenue / top-products / top-stores within the 15s timeout.
  emitLog('creating_views', `Creating materialized views on ${targetSchema}...`);
  await createMVs(targetSchema, emitLog);
  emitLog('creating_views', 'Materialized views ready');
}

// ── Data info ─────────────────────────────────────────────────────────────────

async function getTevaNaotDataInfo() {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT TO_CHAR(MAX("transaction_date"), 'YYYY-MM') AS last_month
       FROM tevanaot.mv_sales`
    );
    return result.rows[0]?.last_month || null;
  } catch {
    return null;
  }
}

module.exports = { loadTevaNaot, indexTevaNaot, getTevaNaotDataInfo };
