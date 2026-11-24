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
//
// "sale" alone is NOT enough (task #101): a client saw "2₪" in a column of
// sales LINES — `sales_lines`, `sales_qty`, `sale_count` are counts of sales,
// not money. So a name whose only money word is "sale" is money only when it
// carries no quantity word; an explicit money word (revenue, cost, price,
// amount…) is money regardless. `ils` is matched as its own token — inside a
// word ("details") it is not a currency.
//
// Matched on whole WORDS of the name, not substrings: "baseline" is not
// "line", and "actual_sales_7days" is sales over 7 days (money), while
// "days_since_last_sale" is a duration. Checked against the 505 column names
// the chat had actually shown: exactly `sales_lines` and
// `days_since_last_sale` lose the ₪, nothing gains or loses it otherwise.
const STRONG_MONEY_KEY_RE = /revenue|cost|profit|price|amount|value|vat/i;
const QUANTITY_WORDS = new Set([
  'count', 'qty', 'quantity', 'quantities', 'unit', 'units', 'line', 'lines', 'transaction', 'transactions',
  'txn', 'txns', 'item', 'items', 'order', 'orders', 'customer', 'customers', 'visit', 'visits', 'ticket',
  'tickets', 'receipt', 'receipts', 'basket', 'baskets', 'sku', 'skus', 'member', 'members', 'num', 'number',
]);

function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isMoneyKey(key) {
  const words = keyWords(key);
  if (STRONG_MONEY_KEY_RE.test(key) || words.includes('ils')) return true;
  if (!words.some(w => w.startsWith('sale'))) return false;
  if (words.some(w => QUANTITY_WORDS.has(w))) return false;           // sales_lines, sale_count
  const isDuration = (words[0] === 'days' || words[0] === 'day') || words.includes('since');
  return !isDuration;                                                  // days_since_last_sale
}

// Percentage/ratio columns (e.g. "revenue_pct_change", "conversion_pct") must
// NEVER get the ₪ prefix even though their name also contains a money word
// like "revenue" — they're a ratio, not a currency amount. Checked first so
// it overrides the money heuristic below.
const PERCENT_KEY_RE = /pct|percent/i;

// Statistical columns (e.g. "revenue_z_score", "revenue_deviation",
// "qty_stddev") are unitless/derived numbers, not currency, even though their
// name embeds a money word like "revenue" — a column named "revenue_z_score"
// is a z-score, not an amount of money. Checked alongside PERCENT_KEY_RE so
// neither the ₪ prefix nor thousands-only-integer formatting misfires on them.
const STATS_KEY_RE = /z[_-]?score|deviation|std[_-]?dev|variance/i;

// Numeric-LOOKING columns that are actually identifiers/codes/date-parts, not
// quantities — must never get thousands separators or be summed (a SKU like
// "44471" must render as "44471", not "44,471", and summing part numbers is
// meaningless). Deliberately broad since every BI schema has these.
const ID_KEY_RE = /^(id|code|sku|part|barcode|year|month|quarter|week|day|phone|fax|zip|zipcode|postal)$|_(id|code|number|no|num|phone|fax|zip)$/i;
// The same, for Hebrew column labels (an attached file's own headers — task
// #100): barcode, catalogue number (מק"ט), phone, "code …".
const HEBREW_ID_KEY_RE = /ברקוד|מק["״׳']?ט|טלפון|^קוד/;
// Whole numbers of 12+ digits are identifiers (EAN/UPC barcodes), never
// quantities — no revenue or unit total reaches a trillion.
const LONG_DIGITS_RE = /^\d{12,}$/;

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
  sold: 'שנמכרה', count: 'מספר', line: 'שורות', lines: 'שורות', units: 'יחידות', unit: 'יחידה',
  items: 'פריטים', customer: 'לקוח', customers: 'לקוחות',
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
  // Real-estate vocabulary (the developer demo, schema realestate).
  lead: 'ליד', leads: 'לידים', project: 'פרויקט', rep: 'נציג', score: 'ציון', reason: 'סיבה',
  deal: 'עסקה', deals: 'עסקאות', budget: 'תקציב', rooms: 'חדרים', phone: 'טלפון', full: 'מלא',
  buyer: 'רוכש', buyers: 'רוכשים', source: 'מקור', conversion: 'המרה', visit: 'ביקור', visits: 'ביקורים',
  office: 'במשרד', rate: 'שיעור', days: 'ימים', without: 'ללא', contact: 'קשר', spend: 'הוצאה',
  marketing: 'שיווק', signed: 'שנחתמו', per: 'לכל', sqm: 'מ"ר', pct: '%', floor: 'קומה', building: 'בניין',
  direction: 'כיוון', premium: 'פרמיה', purpose: 'מטרת', purchase: 'רכישה', benefit: 'הטבה',
  negotiations: 'משא ומתן', age: 'גיל', gender: 'מגדר', profession: 'מקצוע', income: 'הכנסה', decile: 'עשירון',
  pace: 'קצב', forecast: 'תחזית', months: 'חודשים', available: 'פנויות', reserved: 'שמורות',
  // Words the generator uses in its own aliases ("rank_within_segment", "pct_of_all_deals").
  rank: 'דירוג', within: 'בתוך', segment: 'סגמנט', segments: 'סגמנטים', all: 'כל', of: 'מתוך', share: 'נתח',
  children: 'ילדים', grandchildren: 'נכדים', band: 'טווח', group: 'קבוצה', index: 'מדד', linkage: 'הצמדה', linked: 'צמוד',
  median: 'חציון', response: 'תגובה', minutes: 'דקות', hours: 'שעות', home: 'דירה', homes: 'דירות', investors: 'משקיעים',
  upgraders: 'משפרי דיור', plan: 'תנאי', terms: 'תנאים', apartments: 'דירות', apartment: 'דירה', unsold: 'לא נמכרו',
  stuck: 'תקועות', demand: 'ביקוש', supply: 'היצע', free: 'פנויות', close: 'סגירה', closed: 'נסגרו', top: 'מובילים',
  best: 'הכי טוב', worst: 'הכי חלש', owned: 'בבעלות', by: 'לפי', professions: 'מקצועות', main: 'עיקרית',
};

// Whole-column Hebrew headers, checked before the word-by-word fallback, for
// names that word order can't fix ("purchase_purpose" is "מטרת רכישה", not
// "רכישה מטרת"). Real-estate demo schema (realestate) — every column of its
// tables and views.
const HE_COLUMN_LABELS = {
  activity_id: 'מזהה פעילות', activity_ts: 'מועד פעילות', activity_type: 'סוג פעילות',
  age: 'גיל', available_units: 'דירות פנויות', avg_discount_pct: 'הנחה ממוצעת %',
  avg_sold_price_per_sqm_same_rooms: 'מחיר ממוצע למ"ר (נמכרו, אותו מס׳ חדרים)',
  benefit: 'הטבה', benefit_cost_ils: 'עלות ההטבה ₪', budget: 'תקציב', budget_fits: 'מתאים לתקציב', budget_ils: 'תקציב ₪',
  building: 'בניין', buildings: 'בניינים', buyer_name: 'שם הרוכש',
  campaign_id: 'מזהה קמפיין', campaign_name: 'שם קמפיין', cheapest_free_price: 'המחיר הפנוי הזול ביותר',
  children: 'ילדים', city: 'עיר', city_of_residence: 'עיר מגורים', close_rate_pct: 'שיעור סגירה %',
  company_avg_discount_pct: 'הנחה ממוצעת בחברה %', conversion_pct: 'שיעור המרה %',
  cost_per_deal: 'עלות לעסקה', cost_per_lead: 'עלות לליד',
  days_lead_to_deal: 'ימים מליד לעסקה', days_on_market: 'ימים על המדף', days_without_contact: 'ימים ללא קשר',
  deal_id: 'מזהה עסקה', deals: 'עסקאות', direction: 'כיוון',
  discount_above_company_avg_ils: 'הנחה מעל ממוצע החברה ₪', discount_ils: 'הנחה ₪', discount_pct: 'הנחה %',
  end_date: 'תאריך סיום', expected_delivery: 'מסירה צפויה',
  family_status: 'מצב משפחתי', final_price: 'מחיר סופי', final_price_per_sqm: 'מחיר סופי למ"ר',
  first_name: 'שם פרטי', first_response_minutes: 'זמן תגובה ראשונה (דקות)', floor: 'קומה', floors: 'קומות',
  forecast_sell_out_date: 'תאריך סיום מכירות צפוי', free_units_of_wanted_size: 'דירות פנויות בגודל המבוקש',
  full_name: 'שם מלא', gender: 'מגדר', has_storage: 'מחסן', income_decile: 'עשירון הכנסה',
  last_name: 'שם משפחה', lead_date: 'תאריך ליד', lead_id: 'מזהה ליד', lead_month: 'חודש ליד',
  lead_score: 'ציון ליד', lead_ts: 'מועד ליד', leads: 'לידים',
  leads_wanting_this_size_last_90_days: 'לידים שמחפשים גודל זה (90 יום)',
  list_price: 'מחיר מחירון', listed_date: 'תאריך עלייה לשיווק', lost_reason: 'סיבת אובדן',
  marketing_spend: 'הוצאות שיווק', marketing_start: 'תחילת שיווק',
  median_first_response_minutes: 'חציון זמן תגובה ראשונה (דקות)', monthly_sales_pace: 'קצב מכירות חודשי',
  months_to_sell_out: 'חודשים עד סיום המכירות', mortgage_preapproved: 'אישור עקרוני למשכנתא',
  negotiation_date: 'תאריך משא ומתן', negotiations: 'משא ומתן',
  offered_benefit: 'הטבה שהוצעה', office_visits: 'ביקורים במשרד', outcome: 'תוצאה',
  outdoor_sqm: 'שטח חוץ (מ"ר)', owned_apartments: 'דירות בבעלות',
  parking_spots: 'חניות', payment_plan: 'תנאי תשלום', pct_answered_within_hour: '% שנענו תוך שעה',
  pct_sold: '% נמכר', phone: 'טלפון', phone_masked: 'טלפון', position: 'מיקום',
  price_per_sqm: 'מחיר למ"ר', price_premium_pct: 'פרמיית מחיר %', profession: 'מקצוע',
  project_id: 'מזהה פרויקט', project_ids: 'פרויקטים', project_name: 'פרויקט', purchase_purpose: 'מטרת רכישה',
  reason: 'סיבה', region: 'אזור', rep_id: 'מזהה נציג', rep_name: 'נציג', reps: 'נציגים',
  reserved_units: 'דירות שמורות', rooms: 'חדרים', rooms_wanted: 'חדרים מבוקשים',
  signed: 'נחתמו', signed_date: 'תאריך חתימה', signed_revenue: 'הכנסות מעסקאות שנחתמו',
  sold_date: 'תאריך מכירה', sold_last_90_days: 'נמכרו ב־90 יום', sold_units: 'דירות שנמכרו',
  source: 'מקור', sqm: 'מ"ר', start_date: 'תאריך התחלה', status: 'סטטוס',
  total_discount_ils: 'סה"כ הנחות ₪', total_units: 'סה"כ דירות',
  unit_id: 'מזהה דירה', unit_number: 'מספר דירה', unit_type: 'סוג דירה',
  unsold_inventory_value: 'שווי מלאי לא מכור', view: 'נוף', visit_date: 'תאריך ביקור',
  visit_rate_pct: 'שיעור ביקור %', with_mortgage: 'עם משכנתא',
  index_linkage: 'הצמדה למדד', signed_month: 'חודש חתימה', days_since_last_step: 'ימים מהצעד האחרון',
  pct_of_all_deals: '% מכל העסקאות', pct_of_deals: '% מהעסקאות', pct_of_leads: '% מהלידים', share_pct: 'נתח %',
  rank_within_segment: 'דירוג בסגמנט', age_group: 'קבוצת גיל', age_band: 'קבוצת גיל', decile_band: 'טווח עשירון',
  avg_age: 'גיל ממוצע', avg_income_decile: 'עשירון ממוצע', first_home_pct: '% דירה ראשונה', children_deals: 'עסקאות עבור הילדים',
};

// Hebrew construct-state phrases usually put the "head" noun FIRST (e.g.
// "קוד מחסן" — code of-warehouse — not "מחסן קוד"), the reverse of English
// ("warehouse code"). When the last English token is one of these common
// head nouns, its Hebrew translation is moved to the front of the label.
const HE_HEAD_NOUNS = new Set(['code', 'name', 'description', 'number', 'count', 'id', 'price', 'value', 'balance', 'type', 'date', 'lines', 'units', 'items', 'score', 'rate']);

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
    const whole = HE_COLUMN_LABELS[String(key).toLowerCase()];
    if (whole) return whole;
    const translated = words.map(w => HE_WORD_MAP[w.toLowerCase()] || w);
    // A trailing unit ("visit_rate_pct") stays last; the head noun before it
    // still leads: "שיעור ביקור %", not "ביקור שיעור %".
    const unit = words.length > 2 && PERCENT_KEY_RE.test(words[words.length - 1]) ? translated.pop() : null;
    const core = unit ? words.slice(0, -1) : words;
    if (core.length > 1 && HE_HEAD_NOUNS.has(core[core.length - 1].toLowerCase())) {
      translated.unshift(translated.pop());
    }
    if (unit) translated.push(unit);
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
    const values = rows.map(r => r[key]).filter(v => v != null && v !== '');
    const isIdLike = ID_KEY_RE.test(key) || HEBREW_ID_KEY_RE.test(key)
      || (values.length > 0 && values.every(v => LONG_DIGITS_RE.test(String(v).trim())));
    const allNumeric = !isIdLike && values.length > 0 && values.every(isNumericValue);
    let decimals = null;
    if (allNumeric) {
      const allIntegers = values.every(v => Number.isInteger(parseFloat(v)));
      decimals = allIntegers ? 0 : 2;
    }
    const isPercent = allNumeric && PERCENT_KEY_RE.test(key);
    const isStat = allNumeric && STATS_KEY_RE.test(key);
    return {
      key,
      // Semantic type (isIdLike/allNumeric/isMoney/isPercent) is always decided
      // from the underlying English column key, regardless of label language —
      // so formatting stays correct even when the label is translated below.
      label: prettifyLabel(key, hebrew),
      decimals,                                    // null = plain text / identifier column
      isMoney: allNumeric && !isPercent && !isStat && isMoneyKey(key),
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
  // Capability-gate refusal (Stage 2): the dataset's manifest declares the
  // asked dimension absent, so no SQL was generated at all. Return a
  // structured instruction instead of a "No data found" — the difference
  // between "we hold no such records" (false) and "this data does not carry
  // that dimension" (true) is the whole point of the gate.
  if (result.refused && result.refusal) {
    const r = result.refusal;
    return {
      success: false,
      refused: true,
      question,
      schema,
      rowCount: 0,
      summary: `CANNOT ANSWER — the "${r.dimension}" dimension does not exist in this dataset. `
        + `Reason: ${r.reason} `
        + (r.roadmap ? `What would unlock it: ${r.roadmap} ` : '')
        + (r.alternatives ? `Offer the user these instead: ${r.alternatives}. ` : '')
        + `Tell the user this plainly in their language. Do NOT attempt another data fetch for the same dimension — `
        + `no rephrasing will make the data exist.`,
    };
  }

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
    // "No data found" is the right answer only when the data really is
    // absent. When the query filtered on a column that is empty for the rows
    // in question, the filter could never have matched — saying "no data"
    // there tells the user something false about their business.
    summary = result.emptyReason
      ? 'No rows came back, and the reason is structural, not a business fact: ' + result.emptyReason.message
        + ' Tell the user this is a gap in the recorded data — do NOT say the business has no such records.'
      : 'No data found.';
  } else {
    displayColumns = buildDisplayColumns(result.columns, data, hebrew);
    const previewTable = buildMarkdownTable(displayColumns, data, PREVIEW_ROW_LIMIT);
    hasViewer = rowCount > PREVIEW_ROW_LIMIT;

    if (!hasViewer) {
      summary = 'Found ' + rowCount + ' record' + (rowCount === 1 ? '' : 's') + '. Below is the COMPLETE '
        + 'result, ALREADY formatted as a markdown table (correct columns, order, labels, number formatting). '
        + 'Paste it into your reply EXACTLY as given — do not retype, reorder, retranslate, reformat, or add '
        + 'any row of your own (including a "..." or "more rows" row — there are none, this table is already '
        + 'complete). For pure aggregate/summary questions you may skip the table and just give the numbers.\n\n'
        + previewTable + '\n';
    } else {
      summary = 'Found ' + rowCount + ' records. Below is a formatted PREVIEW of the first ' + PREVIEW_ROW_LIMIT
        + ' rows, ALREADY formatted as a markdown table (correct columns, order, labels, number formatting). '
        + 'Paste it into your reply EXACTLY as given — do not retype, reorder, retranslate, reformat, or append '
        + 'any row of your own to the table (including a "..." row to signal truncation) — end the table at the '
        + 'last real row. State the truncation in your own sentence AFTER the table instead: tell the user the '
        + 'complete ' + rowCount + '-row set is available to view/export below (every row is included there, it '
        + 'is not truncated). For pure aggregate/summary questions you may skip the table and just give the '
        + 'numbers.\n\n' + previewTable + '\n';
    }
    summary += buildNumericTotalsText(displayColumns, data);

    // Reports have caveated partial periods for a while; chat did not, and
    // reported a store "down 87%" between a full month and a 4-day one. This
    // is a computed fact about the data (see period-coverage.service.js), not
    // a judgement call, so it is stated to the model as a requirement.
    if (result.coverage?.partial) {
      summary += '\n\nIMPORTANT — INCOMPLETE PERIOD. ' + result.coverage.note
        + ' You MUST say this in your reply, in the user\'s language, wherever you quote a figure for '
        + result.coverage.period + '. Do NOT present a change into that period as growth or decline —'
        + ' a ' + result.coverage.daysCovered + '-day period cannot be compared with a full month.';
    }
  }

  // ── Stage-2 answer contract: annotations ALWAYS render ─────────────────
  // Deterministic facts computed by data-query.service._buildAnnotations
  // (basis, exclusions, partial last day, entity/scope mismatch, unresolved
  // vocabulary). They are embedded into `summary` — the text the talker model
  // quotes from — so a disclosure cannot be silently omitted; the model may
  // rephrase into the user's language but the fact is part of its source.
  // Datasets without a manifest never have `annotations` → output unchanged.
  if (result.annotations) {
    const a = result.annotations;
    const lines = [];
    if (a.basis && a.basis.fidelity !== 'exact') {
      lines.push(`Money figures are ESTIMATES: ${a.basis.detail}.`
        + (a.basis.knownDelta ? ` Measured gap vs the client's own reports: ${a.basis.knownDelta}.` : ''));
    }
    if (a.exclusions) lines.push(`Known exclusion: ${a.exclusions}.`);
    if (a.dataThrough) lines.push(`Data runs through ${a.dataThrough}.`);
    if (a.askedBeyondData) {
      lines.push(`THE ASKED PERIOD (${a.askedBeyondData.asked}) ENDS AFTER THE DATA DOES (${a.askedBeyondData.dataThrough}). `
        + `Your FIRST sentence must state plainly that there is no data for the asked period and that data ends ${a.askedBeyondData.dataThrough}. `
        + `Do not present older figures as if they answered the asked period.`);
    }
    if (a.suggestedRequests && a.suggestedRequests.length) {
      lines.push('Offer the user ONLY these follow-ups (they are guaranteed to have data — do NOT invent other suggestions): '
        + a.suggestedRequests.map(s => s.hint).join('; ') + '.');
    }
    if (a.partialLastDay) {
      lines.push(`The last day (${a.partialLastDay.date}) appears PARTIAL — ${a.partialLastDay.pctOfNormal}% of its normal volume `
        + `(${a.partialLastDay.volume} vs a typical ${a.partialLastDay.medianVolume}). Say this wherever you quote that day, `
        + `and NEVER use it silently in a trend or day-vs-day comparison — exclude it or label it partial.`);
    }
    if (a.entityMismatch) {
      lines.push(`ENTITY CHECK FAILED: the user asked about "${a.entityMismatch.asked}" but this result groups by `
        + `${a.entityMismatch.delivered}. Either re-fetch grouped by the asked entity, or state explicitly that the `
        + `breakdown shown is NOT the one requested.`);
    }
    if (a.scopeAdded) {
      lines.push(`SCOPE WAS NARROWED: the user did not name a period, but this result is filtered to ${a.scopeAdded.detail}. `
        + `State the period explicitly in your reply.`);
    }
    if (a.unresolvedTerms) {
      for (const t of a.unresolvedTerms) {
        lines.push(`The user's term "${t.terms[0]}" has NO counterpart in this data: ${t.detail}`);
      }
    }
    if (lines.length) {
      summary += '\n\nDATA CONTRACT — you MUST convey each point below in your reply, in the user\'s language '
        + '(rephrase freely, omit nothing):\n- ' + lines.join('\n- ');
    }
  }

  // Stage 3, A4a (manifest-gated): direct answers first. Applies to every
  // manifest dataset's fetch results — presentation, not semantics.
  if (result.manifestActive) {
    summary += '\n\nPRESENTATION: begin your reply with ONE direct sentence answering the question '
      + '(the key figure or fact) BEFORE any table, breakdown, or caveat detail.';
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
    annotations: result.annotations || null,
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
