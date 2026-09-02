/**
 * The Social Supermarket (הסופר החברתי) reload — two-phase zero-downtime reload.
 * Mirrors reload-zolstock.js / reload-hypertoy.js exactly.
 *
 * Phase 1 — loadSuperHist(targetSchema, emitLog):
 *   Scan GCS → read CSV headers → create tables → COPY data
 * Phase 2 — indexSuperHist(targetSchema, emitLog):
 *   Derived line_kind column → indexes → materialized views.
 *   DataReloadService handles the atomic schema swap.
 *
 * THE CLIENT. The Histadrut's members-only online grocery (super-hist.co.il):
 * members sign in with their ID number and buy everyday goods at subsidised
 * prices. So the model is an ORDER model — orders, their lines, a product
 * catalogue — with no store, branch or till dimension, and there will never be
 * one. Questions that assume a shop floor have no answer here.
 *
 * WHAT THE FIRST DELIVERY CONTAINS (profiled 2026-09-02):
 *   19,062 orders · 654,370 order lines · 16,537 products · 15,881 members
 *   1,481 distinct items sold, 141 of them absent from the catalogue
 *   ₪8.44M of orders over 42 days, 2026-07-01 to 2026-08-11.
 *
 * Three things about it that shape everything downstream:
 *
 *   1. FORTY-TWO DAYS. Not a year. No year-on-year, no seasonality, no "same
 *      period last year" — and August is cut off on the 11th, so a naive
 *      month-over-month comparison reads as a 79% collapse that did not happen.
 *      The calendar file covers all of 2026 and must never be used as evidence
 *      that a date has data.
 *   2. THE ORDER-LINE FILE HOLDS TWO ROW KINDS. 634,556 product lines and
 *      19,814 shipping lines, no discriminator column. `line_kind` is generated
 *      at Phase 2 — see create-superhist-indexes.js.
 *   3. PRODUCT CATEGORY IS ABSENT. 3.3% of products carry a category id and all
 *      of them point at one id; the categories file is marketing collections.
 *      The manifest refuses category questions rather than answering them from
 *      3% of the catalogue.
 *
 * Files delivered but NOT loaded, by omission from FILE_TO_TABLE:
 *   Dim / Dim1 / Measure / Measures — QlikSense's own dashboard metadata (the
 *   field picker's sort order and a table of formula strings). They describe
 *   the client's Qlik app, not their business, and loading them would put
 *   `$Measure` and `Measure Formula` in front of an LLM as if they were data.
 *   OrderLine_Last_7_Days_1 — a single column of order ids, a Qlik helper for a
 *   dashboard filter. The same rows are already in OrderLine.
 */

require('dotenv').config();
const gcsService = require('../services/gcs.service');
const { getPool } = require('../services/db.zer4u');
const { buildColumnLookup } = require('./column-aliases-superhist');
const { createSchema } = require('./create-superhist-schema');
const { loadAllCSVFiles } = require('./load-csv-to-db-copy');
const { createIndexes } = require('./create-superhist-indexes');
const { createMVs } = require('./create-superhist-mvs');
const { getGcsFolder } = require('../services/gcs-folder.service');

const GCS_FOLDER_DEFAULT = 'superhist/';

/**
 * The delivered basenames carry the client's Hebrew name — "הסופר החברתי" —
 * between the entity and the `_CSV` suffix, exactly as Qlik exported them.
 * They are written here verbatim; an upload whose name differs by so much as a
 * space is silently skipped, which is the failure mode the GCS filename note in
 * the docs exists to prevent.
 */
const FILE_TO_TABLE = {
  'OrderLineהסופר החברתי_CSV.csv': 'order_lines',
  'Ordersהסופר החברתי_CSV.csv': 'orders',
  'Productsהסופר החברתי_CSV.csv': 'products',
  'Categoriesהסופר החברתי_CSV.csv': 'categories',
  'Calanderהסופר החברתי_CSV.csv': 'calendar',
  // Deliberately NOT loaded (see header): Dim, Dim1, Measure, Measures,
  // OrderLine_Last_7_Days_1.
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

      // Two CSV headers must never claim one column: the CREATE TABLE would
      // name it twice and the import would die on a syntax error. The first
      // wins and the second keeps its raw header — visible, harmless, and a
      // plain signal that the aliases need pruning. (Learned on hypertoy,
      // 2026-09-02, where a renamed header cost two days of stale data.)
      const claimed = new Set();
      const columns = headers.map(h => {
        const csvName = h.replace(/^﻿/, '').trim();
        const def = lookup.get(csvName);
        if (def && !claimed.has(def.dbName)) {
          claimed.add(def.dbName);
          return { csvName, name: def.dbName, type: def.type };
        }
        if (def) {
          emitLog('scanning', `${file.basename}: '${csvName}' also maps to ${def.dbName}, which is already taken — keeping the raw header`);
        }
        return { csvName, name: csvName, type: def ? def.type : 'TEXT' };
      });

      // An unmapped header is not fatal — it lands as TEXT under its own name —
      // but it is how a renamed column goes unnoticed until a query fails, so
      // it is said out loud at load time.
      const unmapped = columns.filter(c => !lookup.get(c.csvName)).map(c => c.csvName);
      if (unmapped.length) {
        emitLog('scanning', `${file.basename}: ${unmapped.length} unmapped header(s) — ${unmapped.slice(0, 6).join(', ')}${unmapped.length > 6 ? '…' : ''}`);
      }

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

async function loadSuperHist(targetSchema, emitLog, options = {}) {
  let filesLoaded = 0;
  let totalRows = 0;
  const fileResults = [];

  // Import window: keep only the last N months of order data. 0 = load all.
  // Comes from DataReloadService (DB override `superhist_import_months` / UI);
  // env fallback (SUPERHIST_IMPORT_MONTHS) is for direct CLI runs.
  //
  // The whole delivery is 42 days, so a window is pointless today and the
  // default is 0. It exists because every other client's did not, until it had
  // to be retrofitted under time pressure.
  const importMonths = options.importMonths != null
    ? options.importMonths
    : (parseInt(process.env.SUPERHIST_IMPORT_MONTHS || '0', 10) || 0);
  if (importMonths > 0) {
    emitLog('scanning', `Import window: keeping last ${importMonths} month(s) of data (relative to latest date)`);
  } else {
    emitLog('scanning', 'Import window: loading all available data (no date filter)');
  }

  emitLog('scanning', 'Listing CSV files from GCS...');
  const gcsFiles = await gcsService.listCSVFiles(await getGcsFolder('superhist', GCS_FOLDER_DEFAULT));
  const validFiles = gcsFiles.filter(f => FILE_TO_TABLE[f.basename]);
  emitLog('scanning', `Found ${validFiles.length} of ${Object.keys(FILE_TO_TABLE).length} expected CSV files — reading headers...`);

  if (validFiles.length === 0) {
    emitLog('scanning', 'No mapped CSV files found — check the folder and the exact basenames in FILE_TO_TABLE.');
    return { totalFiles: 0, filesLoaded: 0, totalRows: 0, fileResults: [], qualityReport: {} };
  }

  // Which expected files did NOT arrive. Said plainly rather than inferred from
  // a row count later: a missing Orders file would otherwise show up as an
  // empty schema with no explanation.
  const missing = Object.keys(FILE_TO_TABLE).filter(b => !validFiles.some(f => f.basename === b));
  if (missing.length) {
    emitLog('scanning', `Expected but not delivered: ${missing.join(', ')}`);
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

async function indexSuperHist(targetSchema, emitLog) {
  emitLog('creating_indexes', `Creating indexes on ${targetSchema}...`);
  await createIndexes(targetSchema, emitLog);
  emitLog('creating_indexes', 'Indexes created');

  emitLog('creating_views', `Creating materialized views on ${targetSchema}...`);
  await createMVs(targetSchema, emitLog);
  emitLog('creating_views', 'Materialized views ready');
}

// ── Data info ─────────────────────────────────────────────────────────────────

async function getSuperHistDataInfo() {
  const pool = getPool();
  try {
    // DAY precision, not month. A bare 'YYYY-MM' is normalised by Insights to
    // that month's LAST day, which on this dataset would claim data through
    // 2026-08-31 when it stops on the 11th — every "last 4 weeks" question
    // would then include 20 empty days and report a collapse that never
    // happened. This exact bug cost zolstock a fabricated 90% revenue drop.
    //
    // Read from ORDERS, not the calendar: the calendar file covers all of 2026
    // and knows nothing about which days have orders.
    const result = await pool.query(
      `SELECT TO_CHAR(MAX("order_date"), 'YYYY-MM-DD') AS last_date
         FROM superhist.orders
        WHERE "order_date" IS NOT NULL`
    );
    return result.rows[0]?.last_date || null;
  } catch {
    return null;
  }
}

module.exports = { loadSuperHist, indexSuperHist, getSuperHistDataInfo, FILE_TO_TABLE };
