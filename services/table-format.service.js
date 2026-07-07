/**
 * Table Format Service
 *
 * Single, generic source of truth for how a SQL result set is presented —
 * used by every BI crew (zer4u, hypertoy, thestock, newdeli, zolstock, tevanaot)
 * and by server.js when building the data_table step for the popup viewer.
 *
 * Before this existed, the chat text was formatted by the talker LLM (which
 * could reorder/relabel/reround columns however it liked) while the popup and
 * Excel export rendered the raw SQL columns untouched — the same data ended up
 * looking like two different reports. Now labels, column order and number
 * formatting are computed ONCE here; the LLM is handed an already-formatted
 * markdown table and told to paste it verbatim, and the client uses the same
 * `displayColumns` metadata to render the popup and build the Excel file.
 */

const PREVIEW_ROW_LIMIT = 20;

// Column-name heuristic for "this numeric column is money" — used to prefix ₪
// consistently everywhere. Deterministic and schema-agnostic (relies only on
// the English column-naming convention already used across all BI schemas).
const MONEY_KEY_RE = /sale|revenue|cost|profit|price|amount|value|vat|ils/i;

// Percentage/ratio columns (e.g. "revenue_pct_change", "conversion_pct") must
// NEVER get the ₪ prefix even though their name also contains a money word
// like "revenue" — they're a ratio, not a currency amount. Checked first so
// it overrides the money heuristic below.
const PERCENT_KEY_RE = /pct|percent/i;

// Numeric-LOOKING columns that are actually identifiers/codes/date-parts, not
// quantities — must never get thousands separators or be summed (a SKU like
// "44471" must render as "44471", not "44,471", and summing part numbers is
// meaningless). Deliberately broad since every BI schema has these.
const ID_KEY_RE = /^(id|code|sku|part|barcode|year|month|quarter|week|day|phone|fax|zip|zipcode|postal)$|_(id|code|number|no|num|phone|fax|zip)$/i;

const HEBREW_RE = /[֐-׿]/;

// Common BI-vocabulary word -> Hebrew, applied per-token when the user's
// question is in Hebrew. Deterministic (no LLM in the loop, so it never
// drifts) — a token missing from the map just stays in English rather than
// guessing, which is a fine fallback (a mostly-Hebrew label with one English
// word beats either an all-English label or a mistranslated one).
const HE_WORD_MAP = {
  total: 'סה"כ', sum: 'סה"כ', code: 'קוד', name: 'שם', id: 'מזהה',
  warehouse: 'מחסן', branch: 'סניף', store: 'חנות', stores: 'חנויות', region: 'אזור',
  revenue: 'הכנסות', sales: 'מכירות', sale: 'מכירה', cost: 'עלות',
  profit: 'רווח', margin: 'שולי רווח', qty: 'כמות', quantity: 'כמות',
  sold: 'שנמכרה', count: 'מספר', line: 'שורות', customer: 'לקוח', customers: 'לקוחות',
  product: 'מוצר', products: 'מוצרים', item: 'פריט', description: 'תיאור',
  family: 'משפחה', part: 'מק"ט', sku: 'מק"ט', price: 'מחיר', amount: 'סכום',
  ex: 'לפני', inc: 'כולל', vat: 'מע"מ', number: 'מספר', date: 'תאריך',
  payment: 'תשלום', type: 'סוג', transaction: 'עסקה', transactions: 'עסקאות',
  avg: 'ממוצע', average: 'ממוצע', percent: 'אחוז', percentage: 'אחוז',
  city: 'עיר', cities: 'ערים', barcode: 'ברקוד', supplier: 'ספק',
  inventory: 'מלאי', balance: 'יתרה', value: 'שווי', target: 'יעד',
  actual: 'בפועל', year: 'שנה', month: 'חודש', week: 'שבוע', day: 'יום',
  quarter: 'רבעון', employee: 'עובד', cashier: 'קופאי', register: 'קופה',
  campaign: 'קמפיין', discount: 'הנחה', credit: 'זיכוי', franchisee: 'זכיין',
  company: 'חברה', order: 'הזמנה', orders: 'הזמנות', branches: 'סניפים',
  category: 'קטגוריה', supplier_name: 'שם ספק',
  status: 'סטטוס', method: 'שיטה', channel: 'ערוץ', hour: 'שעה', minute: 'דקה',
};

// Hebrew construct-state phrases usually put the "head" noun FIRST (e.g.
// "קוד מחסן" — code of-warehouse — not "מחסן קוד"), the reverse of English
// ("warehouse code"). When the last English token is one of these common
// head nouns, its Hebrew translation is moved to the front of the label.
const HE_HEAD_NOUNS = new Set(['code', 'name', 'description', 'number', 'count', 'id', 'price', 'value', 'balance', 'type', 'date']);

function isHebrewText(str) {
  return HEBREW_RE.test(String(str || ''));
}

function prettifyLabel(key, hebrew = false) {
  const words = String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean);

  if (hebrew) {
    const translated = words.map(w => HE_WORD_MAP[w.toLowerCase()] || w);
    if (words.length > 1 && HE_HEAD_NOUNS.has(words[words.length - 1].toLowerCase())) {
      translated.unshift(translated.pop());
    }
    return translated.join(' ');
  }

  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function isNumericValue(v) {
  return v != null && v !== '' && !isNaN(parseFloat(v)) && isFinite(v);
}

/**
 * Decide, once, the display shape of every column: label, decimal precision,
 * and whether it looks like a monetary figure. Same result is used for the
 * chat preview table, the popup table, and the Excel export.
 */
function buildDisplayColumns(columns, rows, hebrew = false) {
  const keys = Array.isArray(columns) && columns.length
    ? columns
    : (rows[0] ? Object.keys(rows[0]) : []);

  return keys.map(key => {
    const isIdLike = ID_KEY_RE.test(key);
    const values = rows.map(r => r[key]).filter(v => v != null && v !== '');
    const allNumeric = !isIdLike && values.length > 0 && values.every(isNumericValue);
    let decimals = null;
    if (allNumeric) {
      const allIntegers = values.every(v => Number.isInteger(parseFloat(v)));
      decimals = allIntegers ? 0 : 2;
    }
    const isPercent = allNumeric && PERCENT_KEY_RE.test(key);
    return {
      key,
      // Semantic type (isIdLike/allNumeric/isMoney/isPercent) is always decided
      // from the underlying English column key, regardless of label language —
      // so formatting stays correct even when the label is translated below.
      label: prettifyLabel(key, hebrew),
      decimals,                                    // null = plain text / identifier column
      isMoney: allNumeric && !isPercent && MONEY_KEY_RE.test(key),
      isPercent,
    };
  });
}

function formatCellValue(value, col) {
  if (value == null || value === '') return '';
  // pg returns DATE/TIMESTAMP columns as native JS Date objects — String(date)
  // produces a locale-dependent monstrosity like "Fri Jan 01 1988 00:00:00
  // GMT+0100 (Central European Standard Time)". Always render as YYYY-MM-DD.
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (col.decimals != null) {
    const n = parseFloat(value);
    if (!isNaN(n)) {
      const formatted = n.toLocaleString('en-US', {
        minimumFractionDigits: col.decimals,
        maximumFractionDigits: col.decimals,
      });
      if (col.isPercent) return formatted + '%';
      return col.isMoney ? '₪' + formatted : formatted;
    }
  }
  return String(value);
}

function buildMarkdownTable(displayColumns, rows, limit = PREVIEW_ROW_LIMIT) {
  const slice = rows.slice(0, limit);
  const header = '| ' + displayColumns.map(c => c.label).join(' | ') + ' |';
  const sep = '| ' + displayColumns.map(() => '---').join(' | ') + ' |';
  const body = slice.map(
    r => '| ' + displayColumns.map(c => formatCellValue(r[c.key], c)).join(' | ') + ' |'
  );
  return [header, sep, ...body].join('\n');
}

function buildNumericTotalsText(displayColumns, rows) {
  const numericCols = displayColumns.filter(c => c.decimals != null).slice(0, 5);
  if (!numericCols.length) return '';
  let out = '\nNumeric totals across all ' + rows.length + ' rows:\n';
  for (const col of numericCols) {
    const vals = rows.map(r => parseFloat(r[col.key])).filter(v => !isNaN(v));
    if (vals.length > 0) {
      const sum = vals.reduce((a, b) => a + b, 0);
      out += '- ' + col.label + ': Sum=' + sum.toLocaleString('en-US') + ', Avg=' + (sum / vals.length).toFixed(2) + '\n';
    }
  }
  return out;
}

/**
 * Build the full tool-result payload a BI crew hands back to its talker model,
 * given the raw output of DataQueryService#queryByQuestion. Generic across all
 * BI agents — do not fork per-schema copies of this logic.
 *
 * @param {Object} params
 * @param {string} params.question
 * @param {string|null} params.tableTitle
 * @param {string} params.schema - customer schema name (e.g. 'hypertoy') — lets the
 *   client re-run `sql` against the right DB when opening the popup later, since
 *   rows are never persisted (see server.js POST /api/data-query/rerun).
 * @param {Object} params.result - { sql, explanation, confidence, rowCount, data, columns }
 * @returns {Object} tool-result payload (success case only — caller still handles result.error/result.timeout)
 */
function buildFetchResult({ question, tableTitle, schema, result }) {
  const data = result.data || [];
  const rowCount = result.rowCount ?? data.length;
  // `question` is often the model's own English paraphrase (several crews'
  // tool descriptions explicitly ask for that, since it drives SQL
  // generation) — NOT reliable for detecting the user's language. `table_title`
  // is the one field every crew is instructed to write in the user's own
  // language, so prefer it; fall back to `question` if it's missing.
  const hebrew = isHebrewText(tableTitle) || isHebrewText(question);

  let summary;
  let displayColumns = [];
  let hasViewer = false;

  if (rowCount === 0) {
    summary = 'No data found.';
  } else {
    displayColumns = buildDisplayColumns(result.columns, data, hebrew);
    const previewTable = buildMarkdownTable(displayColumns, data, PREVIEW_ROW_LIMIT);
    hasViewer = rowCount > PREVIEW_ROW_LIMIT;

    if (!hasViewer) {
      summary = 'Found ' + rowCount + ' record' + (rowCount === 1 ? '' : 's') + '. Below is the COMPLETE '
        + 'result, ALREADY formatted as a markdown table (correct columns, order, labels, number formatting). '
        + 'Paste it into your reply EXACTLY as given — do not retype, reorder, retranslate or reformat it '
        + 'yourself. For pure aggregate/summary questions you may skip the table and just give the numbers.\n\n'
        + previewTable + '\n';
    } else {
      summary = 'Found ' + rowCount + ' records. Below is a formatted PREVIEW of the first ' + PREVIEW_ROW_LIMIT
        + ' rows, ALREADY formatted as a markdown table (correct columns, order, labels, number formatting). '
        + 'Paste it into your reply EXACTLY as given — do not retype, reorder, retranslate or reformat it '
        + 'yourself. After it, tell the user the complete ' + rowCount + '-row set is available to view/export '
        + 'below (every row is included there, it is not truncated). For pure aggregate/summary questions you '
        + 'may skip the table and just give the numbers.\n\n' + previewTable + '\n';
    }
    summary += buildNumericTotalsText(displayColumns, data);
  }

  return {
    success: true,
    question,
    tableTitle: tableTitle || null,
    schema,
    sql: result.sql,
    explanation: result.explanation,
    confidence: result.confidence,
    rowCount,
    // IMPORTANT: this object is JSON.stringified verbatim into the talker
    // model's context (see llm.openai.js — the tool handler's full return
    // value becomes the tool_result content, with no cap of its own).
    // `summary` above already contains the preview table AND the numeric
    // totals computed from the COMPLETE `data`, so the model doesn't need the
    // raw rows at all — only a small slice is kept here as a safety net.
    //
    // The COMPLETE set is NOT carried on this object at all (unlike an
    // earlier version of this code) — it is sent to the client live over SSE
    // when the step is created (see server.js), but never written to the
    // thinking_steps DB row. Popups opened later (after a page reload) re-run
    // `sql` against `schema` via POST /api/data-query/rerun instead. This
    // keeps a data_table step's persisted footprint tiny regardless of
    // whether the underlying result was 25 rows or 500,000.
    data: data.slice(0, PREVIEW_ROW_LIMIT),
    columns: result.columns,
    displayColumns,
    hasViewer,
    summary,
    _fullData: data,
  };
}

module.exports = {
  PREVIEW_ROW_LIMIT,
  isHebrewText,
  prettifyLabel,
  buildDisplayColumns,
  formatCellValue,
  buildMarkdownTable,
  buildNumericTotalsText,
  buildFetchResult,
};
