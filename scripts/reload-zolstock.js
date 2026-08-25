/**
 * Zol Stock Reload — two-phase zero-downtime reload.
 * Mirrors reload-hypertoy.js / reload-thestock.js exactly.
 *
 * Phase 1 — loadZolStock(targetSchema, emitLog):
 *   Scan GCS → read CSV headers → create tables → COPY data
 * Phase 2 — indexZolStock(targetSchema, emitLog):
 *   Derived record_type column → indexes → materialized views.
 *   DataReloadService handles the atomic schema swap.
 *
 * 2026-08-19 — REBUILT FOR THE 4-FILE DELIVERY. The client reduced the feed to
 * Fact / Items / Stores / Calander. Two sources are retired and no longer
 * mapped: Facts_ZolStock_CSV.csv (plural, 7.8GB, last exported 2026-06-05 —
 * the old retail sales table and the ONLY source of actual money) and
 * Inventory_ZolStock_CSV.csv (3.1GB in-stock flag).
 *
 * Both retired files are still sitting in the GCS folder. They are excluded
 * here by omission from FILE_TO_TABLE rather than deleted, because the loader
 * silently skips anything unmapped — so leaving them in place costs nothing and
 * keeps the raw delivery intact for audit. Do NOT re-add them without also
 * revisiting the rules block: the two fact files disagree on store numbers and
 * overlap on sales, and having both loaded is what made "which table is
 * authoritative" an open question for weeks.
 *
 * What changed for consumers of this data:
 *   - The surviving fact file has NO monetary columns. Revenue and margin are
 *     derived in the materialized views from the item master's list prices, so
 *     they exclude discounts and promotions. See create-zolstock-mvs.js.
 *   - Data now runs to 2026-08-17 (was 2026-06-04).
 *   - store_number is clean in this delivery, so the SPLIT_PART workaround is
 *     gone; sales rows join Stores at 100.00% (1 unmatched row in 26.9M).
 *   - 96 of the 139 stores have sales.
 */

require('dotenv').config();
const gcsService = require('../services/gcs.service');
const { getPool } = require('../services/db.zer4u');
const { buildColumnLookup } = require('./column-aliases-zolstock');
const { createSchema } = require('./create-zolstock-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-zolstock-indexes');
const { createMVs } = require('./create-zolstock-mvs');
const { getGcsFolder } = require('../services/gcs-folder.service');

const GCS_FOLDER_DEFAULT = 'zolstock/';

const FILE_TO_TABLE = {
  'Fact_ZolStock_CSV.csv': 'facts',            // singular — the only fact file now
  'Items_ZolStock_CSV.csv': 'items',
  'Stores_ZolStock_CSV.csv': 'stores',
  'Calander_ZolStock_CSV.csv': 'calendar',     // sic — source folder spells it this way
  // Deliberately NOT loaded (see header): Facts_ZolStock_CSV.csv (plural),
  // Inventory_ZolStock_CSV.csv.
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

async function loadZolStock(targetSchema, emitLog, options = {}) {
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  // Import window: keep only the last N months of fact data. 0 = load all.
  // Comes from DataReloadService (DB override `zolstock_import_months` / UI);
  // env fallback (ZOLSTOCK_IMPORT_MONTHS) is for direct CLI runs.
  const importMonths = options.importMonths != null
    ? options.importMonths
    : (parseInt(process.env.ZOLSTOCK_IMPORT_MONTHS || '0', 10) || 0);
  if (importMonths > 0) {
    emitLog('scanning', `Import window: keeping last ${importMonths} month(s) of data (relative to latest date)`);
  } else {
    emitLog('scanning', 'Import window: loading all available data (no date filter)');
  }

  emitLog('scanning', 'Listing CSV files from GCS...');
  const gcsFiles = await gcsService.listCSVFiles(await getGcsFolder('zolstock', GCS_FOLDER_DEFAULT));
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
    // DAY precision, not month. Insights' getDataThroughDate() normalizes a
    // bare 'YYYY-MM' to that month's LAST day, which previously reported data
    // as running to 2026-06-30 when it actually stopped 2026-06-04 — every
    // "last 4 weeks" question then silently included ~26 empty days and
    // reported a network-wide ~90% revenue collapse that never happened.
    //
    // Restricted to SALES rows: the same table also holds purchase orders,
    // whose dates run ahead of the last sale, so an unfiltered MAX() would
    // anchor "now" to a date the business has no sales for.
    const result = await pool.query(
      `SELECT TO_CHAR(MAX("row_date"), 'YYYY-MM-DD') AS last_date
         FROM zolstock.facts
        WHERE "qty_sold" IS NOT NULL AND "item_number_sales" IS NOT NULL`
    );
    return result.rows[0]?.last_date || null;
  } catch {
    return null;
  }
}
module.exports = { loadZolStock, indexZolStock, getZolStockDataInfo, FILE_TO_TABLE };
