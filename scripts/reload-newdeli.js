/**
 * New Deli Reload — two-phase zero-downtime reload.
 * Architecture mirrors reload-zer4u-zero-downtime.js exactly.
 *
 * Phase 1 — loadNewDeli(targetSchema, emitLog):
 *   Scan GCS → read CSV headers → create UNLOGGED tables → COPY data
 *
 * Phase 2 — indexNewDeli(targetSchema, emitLog):
 *   Create indexes. DataReloadService handles the atomic schema swap.
 */

require('dotenv').config();
const gcsService = require('../services/gcs.service');
const { getPool } = require('../services/db.zer4u');
const { buildColumnLookup } = require('./column-aliases-newdeli');
const { createSchema } = require('./create-newdeli-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-newdeli-indexes');
const { getGcsFolder } = require('../services/gcs-folder.service');

const GCS_FOLDER_DEFAULT = 'newdeli/csv/';

const FILE_TO_TABLE = {
  'Facts_CSV.csv':             'facts',
  'OrderItems-12_CSV.csv':     'order_items',
  'Branches_CSV.csv':          'branches',
  'Medadim_CSV.csv':           'measures',
  'Memadim_CSV.csv':           'dimensions',
  'Taarichim_Hashvaa_CSV.csv': 'comparison_dates',
  'OrderItems_All-6_CSV.csv':  'order_items_all',
  'Orders_All-8_CSV.csv':      'orders_all',
  'Payments_All-4_CSV.csv':    'payments',
  'חגים_עבריים_CSV.csv':       'jewish_holidays',
  'תאריכים_עבריים_CSV.csv':    'hebrew_dates',
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

async function loadNewDeli(targetSchema, emitLog) {
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  emitLog('scanning', 'Listing CSV files from GCS...');
  const gcsFiles = await gcsService.listCSVFiles(await getGcsFolder('newdeli', GCS_FOLDER_DEFAULT));
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

async function indexNewDeli(targetSchema, emitLog) {
  emitLog('creating_indexes', `Creating indexes on ${targetSchema}...`);
  await createIndexes(targetSchema, emitLog);
  emitLog('creating_indexes', 'Indexes created');
}

// ── Data info ─────────────────────────────────────────────────────────────────

async function getNewDeliDataInfo() {
  const pool = getPool();
  try {
    const result = await pool.query(
      `SELECT MAX("year_month") AS last_month FROM newdeli.facts WHERE "status" = '2'`
    );
    return result.rows[0]?.last_month || null;
  } catch {
    return null;
  }
}

module.exports = { loadNewDeli, indexNewDeli, getNewDeliDataInfo };
