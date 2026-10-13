/**
 * ZolStock "creative" store inventory (tasks #106 / #107)
 *
 * Reut delivers two CSVs for items of family type "יצירה" only:
 *   - CustomerOrdersCreativeMaterials.csv - closed customer orders, i.e. the
 *     ENTRIES into a store's stock. Headers:
 *       מספר לקוח פריוריטי, מק"ט, Date, כמות כניסה למלאי, מספר פריט, מספר חנות
 *   - SalesCreativeMaterials.csv - sales, i.e. the EXITS. Headers:
 *       מספר חנות, כמות שנמכרה, תאריך, מספר פריט
 * Dates are dd/mm/yyyy.
 *
 * Stock per (store, item) is plain running math: entries minus exits.
 * Decisions agreed with Shlomi (2026-10-12/13):
 *   - There is no opening stock. Every (store, item) starts at 0 on
 *     COUNT_FROM (Itzik: count from 2024). Rows dated earlier are ignored.
 *   - Negative stock is kept as-is, never clamped to 0 - it shows where
 *     entries are missing from the source.
 *   - Order lines with no store or no item number cannot be attributed and
 *     are skipped (counted in the stats).
 *   - Output: one row per day per store per item, from OUTPUT_FROM to the last
 *     date found in either file. Only pairs that ever moved are emitted; a pair
 *     starts on its first movement if that is after OUTPUT_FROM.
 */

const COUNT_FROM = '2024-01-01';
const OUTPUT_FROM = '2025-01-01';

const ENTRY_COLS = { date: 'Date', qty: 'כמות כניסה למלאי', item: 'מספר פריט', store: 'מספר חנות' };
const EXIT_COLS = { date: 'תאריך', qty: 'כמות שנמכרה', item: 'מספר פריט', store: 'מספר חנות' };

// Output headers mirror the names Reut already uses in her own files.
const OUTPUT_HEADER = 'מספר פריט,תאריך,מספר חנות,כמות במלאי';

const DAY_MS = 86400000;

/** dd/mm/yyyy -> day number (UTC days since epoch), or null. */
function parseDay(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  return Date.UTC(+m[3], +m[2] - 1, +m[1]) / DAY_MS;
}

function isoToDay(iso) {
  return Date.parse(iso + 'T00:00:00Z') / DAY_MS;
}

/** day number -> dd/mm/yyyy, the format of the source files. */
function formatDay(day) {
  const d = new Date(day * DAY_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/**
 * Both files are simple numeric CSVs except one quoted header (מק"ט), so a
 * comma split is safe for the data rows. Header cells are unquoted for lookup.
 */
function parseCsv(text, cols, label) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const idx = {};
  for (const [key, name] of Object.entries(cols)) {
    idx[key] = header.indexOf(name);
    if (idx[key] < 0) throw new Error(`${label}: column "${name}" not found in header: ${header.join(' | ')}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = lines[i].split(',');
    rows.push({ date: c[idx.date], qty: c[idx.qty], item: c[idx.item], store: c[idx.store] });
  }
  return rows;
}

/**
 * Builds the per-(store, item) daily movement map.
 * @param {string} entriesCsv - CustomerOrdersCreativeMaterials.csv content
 * @param {string} exitsCsv   - SalesCreativeMaterials.csv content
 */
function buildMovements(entriesCsv, exitsCsv) {
  const countFrom = isoToDay(COUNT_FROM);
  const pairs = new Map(); // "store|item" -> Map(day -> net delta)
  const stats = {
    entryRows: 0, exitRows: 0,
    skippedNoStore: 0, skippedNoItem: 0, skippedBadRow: 0, skippedBeforeCountFrom: 0,
    lastDay: -Infinity,
  };

  const add = (row, sign, kind) => {
    stats[kind]++;
    if (!row.store) { stats.skippedNoStore++; return; }
    if (!row.item) { stats.skippedNoItem++; return; }
    const day = parseDay(row.date);
    const qty = Number(row.qty);
    if (day === null || row.qty === '' || !Number.isFinite(qty)) { stats.skippedBadRow++; return; }
    if (day > stats.lastDay) stats.lastDay = day;
    if (day < countFrom) { stats.skippedBeforeCountFrom++; return; }
    const key = `${row.store}|${row.item}`;
    let days = pairs.get(key);
    if (!days) { days = new Map(); pairs.set(key, days); }
    days.set(day, (days.get(day) || 0) + sign * qty);
  };

  for (const r of parseCsv(entriesCsv, ENTRY_COLS, 'entries file')) add(r, +1, 'entryRows');
  for (const r of parseCsv(exitsCsv, EXIT_COLS, 'exits file')) add(r, -1, 'exitRows');

  return { pairs, stats };
}

/**
 * Streams the daily stock table as CSV lines through `write(chunk)`.
 * `write` may return a Promise (e.g. waiting for 'drain'); it is awaited.
 * @returns {Promise<Object>} stats incl. rows written and negative-stock counts
 */
async function writeDailyStock(entriesCsv, exitsCsv, write) {
  const { pairs, stats } = buildMovements(entriesCsv, exitsCsv);
  const outputFrom = isoToDay(OUTPUT_FROM);
  const lastDay = stats.lastDay;

  const keys = [...pairs.keys()].sort((a, b) => {
    const [sa, ia] = a.split('|').map(Number);
    const [sb, ib] = b.split('|').map(Number);
    return sa - sb || ia - ib;
  });

  let rowsWritten = 0, pairsEndingNegative = 0;
  const dayLabel = new Map(); // memoised dd/mm/yyyy strings
  const label = d => { let s = dayLabel.get(d); if (!s) { s = formatDay(d); dayLabel.set(d, s); } return s; };

  await write(OUTPUT_HEADER + '\n');
  let buf = [];
  for (const key of keys) {
    const [store, item] = key.split('|');
    const days = pairs.get(key);
    const moveDays = [...days.keys()].sort((a, b) => a - b);

    // Balance carried into the output window from earlier movements.
    let balance = 0, i = 0;
    while (i < moveDays.length && moveDays[i] < outputFrom) balance += days.get(moveDays[i++]);
    const start = Math.max(outputFrom, moveDays[0]);

    for (let d = start; d <= lastDay; d++) {
      if (i < moveDays.length && moveDays[i] === d) balance += days.get(moveDays[i++]);
      buf.push(`${item},${label(d)},${store},${balance}`);
      if (buf.length >= 50000) { rowsWritten += buf.length; await write(buf.join('\n') + '\n'); buf = []; }
    }
    if (balance < 0) pairsEndingNegative++;
  }
  if (buf.length) { rowsWritten += buf.length; await write(buf.join('\n') + '\n'); }

  return {
    ...stats,
    lastDate: formatDay(lastDay),
    countFrom: COUNT_FROM,
    outputFrom: OUTPUT_FROM,
    pairs: pairs.size,
    pairsEndingNegative,
    rowsWritten,
  };
}

module.exports = { writeDailyStock, buildMovements, COUNT_FROM, OUTPUT_FROM, OUTPUT_HEADER };
