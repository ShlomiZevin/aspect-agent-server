/**
 * Hyper Toy Reload — two-phase zero-downtime reload.
 * Mirrors reload-thestock.js exactly.
 */

require('dotenv').config();
const gcsService = require('../services/gcs.service');
const { getPool } = require('../services/db.zer4u');
const { buildColumnLookup } = require('./column-aliases-hypertoy');
const { createSchema } = require('./create-hypertoy-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-hypertoy-indexes');

const GCS_FOLDER = 'hyper-toy/';

const FILE_TO_TABLE = {
  'Fact_CSV.csv':              'facts',
  'PaymentType_CSV.csv':       'payments',
  'PAYACCOUNT_CSV.csv':        'pay_accounts',
  'Credit_CSV.csv':            'credits',
  'Customers_CSV.csv':         'customers',
  'Pritim_CSV.csv':            'products',
  'Machsanim_CSV.csv':         'warehouses',
  'עותק של חנויות_CSV.csv':    'stores',
  'Mlay500_CSV.csv':           'inventory_500',
  'Calander_CSV.csv':          'calendar',
  'Calander_Compare_CSV.csv':  'calendar_compare',
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

async function loadHyperToy(targetSchema, emitLog, options = {}) {
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  // Import window: keep only the last N months of fact data. 0 = load all.
  // Resolve from the per-schema option (DB override) or HYPERTOY_IMPORT_MONTHS;
  // do NOT fall through to loadAllCSVFiles' ZER4U_IMPORT_MONTHS default, which
  // would silently truncate Hyper Toy to zer4u's window.
  const importMonths = options.importMonths != null
    ? options.importMonths
    : (parseInt(process.env.HYPERTOY_IMPORT_MONTHS || '0', 10) || 0);
  if (importMonths > 0) {
    emitLog('scanning', `Import window: keeping last ${importMonths} month(s) of data (relative to latest date)`);
  } else {
    emitLog('scanning', 'Import window: loading all available data (no date filter)');
  }

  emitLog('scanning', 'Listing CSV files from GCS...');
  const gcsFiles = await gcsService.listCSVFiles(GCS_FOLDER);
  const validFiles = gcsFiles.filter(f => FILE_TO_TABLE[f.basename]);
  emitLog('scanning', `Found ${validFiles.length} CSV files — reading headers...`);

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

async function indexHyperToy(targetSchema, emitLog) {
  emitLog('creating_indexes', `Creating indexes on ${targetSchema}...`);
  await createIndexes(targetSchema, emitLog);
  emitLog('creating_indexes', 'Indexes created');
}

// ── Data info ─────────────────────────────────────────────────────────────────

// Returns the exact last sales date as 'YYYY-MM-DD'. transaction_date is a DATE
// column, so there is no hour component to report. Used both for the data-info
// endpoint and to persist agents.data_updated_at after a reload.
async function getHyperToyDataInfo() {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT TO_CHAR(MAX("transaction_date"), 'YYYY-MM-DD') AS last_date
       FROM hypertoy.facts
       WHERE "record_type" = 'מכירות'`
    );
    return result.rows[0]?.last_date || null;
  } catch {
    return null;
  }
}

// Returns the full sales-data coverage window as { first, last } in 'YYYY-MM-DD'.
// Powers the "Data from … through …" status bar so the customer can see exactly
// how far back the data reaches (Shlomi 2026-06-23 — only "through" was shown).
async function getHyperToyDataRange() {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT TO_CHAR(MIN("transaction_date"), 'YYYY-MM-DD') AS first_date,
              TO_CHAR(MAX("transaction_date"), 'YYYY-MM-DD') AS last_date
       FROM hypertoy.facts
       WHERE "record_type" = 'מכירות'`
    );
    const row = result.rows[0];
    if (!row?.first_date && !row?.last_date) return null;
    return { first: row.first_date || null, last: row.last_date || null };
  } catch {
    return null;
  }
}

module.exports = { loadHyperToy, indexHyperToy, getHyperToyDataInfo, getHyperToyDataRange };
