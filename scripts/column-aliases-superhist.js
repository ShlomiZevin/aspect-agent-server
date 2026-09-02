/**
 * Column type and name definitions for The Social Supermarket (הסופר החברתי).
 * Same interface as column-aliases-zolstock.js — exports buildColumnLookup(tableName).
 *
 * The client is the Histadrut's members-only online grocery (super-hist.co.il),
 * so the model is an ORDER model, not a point-of-sale one: orders and their
 * lines, joined to a product catalogue. There is no store, branch or till
 * dimension and there never will be — the shop exists only online.
 *
 * NOTE: gcsService.getCSVHeaders strips ALL `"` chars from headers, so `מק""ט`
 * arrives as `מקט`. Keys below match the parser's actual output.
 *
 * WHAT THE MEASURED DATA SAYS (profiled 2026-09-02 over the first delivery,
 * 19,062 orders / 654,370 lines / 2026-07-01 to 2026-08-11):
 *
 *   - A line's total is exactly quantity x unit price, on every one of the
 *     634,556 product lines. It is what the member was charged.
 *   - An order's total equals the sum of its line totals PLUS shipping, on
 *     19,045 of 19,062 orders. Subsidy is NOT deducted from either.
 *   - Therefore `subsidy` is the Histadrut's contribution — the value of the
 *     member benefit — and must never be subtracted from revenue. Revenue is
 *     what members paid; subsidy is what the union absorbed on top.
 *   - `tax` and `reward_points` are 0.0000 on all 654,370 lines. Mapped so the
 *     columns exist and their emptiness is visible, never used as a measure.
 */

const COLUMN_MAP = {
  // ── order lines — the fact table ────────────────────────────────────────────
  // Also carries one SHIPPING row per order with no line id and the shipping
  // method's name where a product id belongs. See create-superhist-indexes.js:
  // a `line_kind` column is generated at load so nothing has to infer it.
  order_lines: [
    { csvName: 'הזמנה',              dbName: 'order_id',        type: 'TEXT'    },
    { csvName: 'מזהה שורת הזמנה',    dbName: 'order_line_id',   type: 'TEXT'    },
    { csvName: 'מזהה פריט',          dbName: 'item_id',         type: 'TEXT'    },
    { csvName: 'כמות בהזמנה',        dbName: 'quantity',        type: 'NUMERIC' },
    { csvName: 'מחיר פריט',          dbName: 'unit_price',      type: 'NUMERIC' },
    // The union's contribution on this line, NOT a discount off the bill.
    { csvName: 'סבסוד בשורת הזמנה',  dbName: 'subsidy',         type: 'NUMERIC' },
    // quantity x unit_price. The source calls it "order total" on every LINE,
    // which is exactly the kind of name that gets summed twice; renamed here.
    { csvName: 'סך הכל הזמנה',       dbName: 'line_total',      type: 'NUMERIC' },
    { csvName: 'מס',                 dbName: 'tax',             type: 'NUMERIC' },
    { csvName: 'נקודות תגמול',       dbName: 'reward_points',   type: 'NUMERIC' },
  ],

  // ── orders ──────────────────────────────────────────────────────────────────
  orders: [
    { csvName: 'הזמנה',              dbName: 'order_id',            type: 'TEXT'    },
    { csvName: 'מספר לקוח',          dbName: 'customer_id',         type: 'TEXT'    },
    { csvName: 'אמצעי תשלום',        dbName: 'payment_method',      type: 'TEXT'    },
    { csvName: 'קוד אמצעי תשלום',    dbName: 'payment_method_code', type: 'TEXT'    },
    { csvName: 'שיטת משלוח',         dbName: 'shipping_method',     type: 'TEXT'    },
    { csvName: 'קוד משלוח',          dbName: 'shipping_code',       type: 'TEXT'    },
    { csvName: 'הערות',              dbName: 'notes',               type: 'TEXT'    },
    // Line totals + shipping. Reconciles on 99.9% of orders.
    { csvName: 'סכום הזמנה',         dbName: 'order_total',         type: 'NUMERIC' },
    // TWO status columns that disagree on 7,176 of 19,062 orders. Both are
    // kept under names that say which is which, because picking one silently
    // would make "how many orders were completed" answerable two ways with no
    // way for the reader to tell which they got. `order_status` is the
    // system's own; the Hebrew pair is the display status.
    { csvName: 'מזהה סטטוס הזמנה',   dbName: 'display_status_id',   type: 'TEXT'    },
    { csvName: 'סטטוס הזמנה',        dbName: 'display_status',      type: 'TEXT'    },
    { csvName: 'order_status_id',    dbName: 'order_status_id',     type: 'TEXT'    },
    { csvName: 'order_status',       dbName: 'order_status',        type: 'TEXT'    },
    // 1 on every row in the first delivery, so it filters nothing today. Kept
    // because the name promises it will one day.
    { csvName: 'סטטוס לחישוב',       dbName: 'counts_for_totals',   type: 'TEXT'    },
    { csvName: 'תאריך',              dbName: 'order_date',          type: 'DATE'    },
    { csvName: 'תאריך עדכון',        dbName: 'updated_at',          type: 'TEXT'    },
  ],

  // ── product catalogue ───────────────────────────────────────────────────────
  products: [
    { csvName: 'מזהה פריט',          dbName: 'item_id',             type: 'TEXT'    },
    { csvName: 'מזהה מוצר',          dbName: 'product_id',          type: 'TEXT'    },
    { csvName: 'שם פריט',            dbName: 'item_name',           type: 'TEXT'    },
    { csvName: 'מקט',                dbName: 'sku',                 type: 'TEXT'    },
    { csvName: 'UPC',                dbName: 'upc',                 type: 'TEXT'    },
    { csvName: 'EAN',                dbName: 'ean',                 type: 'TEXT'    },
    { csvName: 'JAN',                dbName: 'jan',                 type: 'TEXT'    },
    { csvName: 'ISBN',               dbName: 'isbn',                type: 'TEXT'    },
    { csvName: 'MPN',                dbName: 'mpn',                 type: 'TEXT'    },
    { csvName: 'מיקום',              dbName: 'location',            type: 'TEXT'    },
    { csvName: 'מלאי',               dbName: 'stock_qty',           type: 'NUMERIC' },
    { csvName: 'מזהה סטטוס מלאי',    dbName: 'stock_status_id',     type: 'TEXT'    },
    { csvName: 'מזהה מותג',          dbName: 'brand_id',            type: 'TEXT'    },
    { csvName: 'נדרש משלוח',         dbName: 'requires_shipping',   type: 'TEXT'    },
    // The CURRENT catalogue price and subsidy — not what any past order paid.
    // Order lines carry their own price; these two must never be used to value
    // a historical order.
    { csvName: 'מחיר מוצר',          dbName: 'catalogue_price',     type: 'NUMERIC' },
    { csvName: 'סבסוד מוצר',         dbName: 'catalogue_subsidy',   type: 'NUMERIC' },
    { csvName: 'נקודות',             dbName: 'points',              type: 'NUMERIC' },
    { csvName: 'מחלקת מס',           dbName: 'tax_class',           type: 'TEXT'    },
    { csvName: 'תאריך זמינות',       dbName: 'available_from',      type: 'TEXT'    },
    { csvName: 'משקל פריט',          dbName: 'weight',              type: 'NUMERIC' },
    { csvName: 'מזהה יחידת משקל',    dbName: 'weight_unit_id',      type: 'TEXT'    },
    { csvName: 'אורך',               dbName: 'length',              type: 'NUMERIC' },
    { csvName: 'רוחב',               dbName: 'width',               type: 'NUMERIC' },
    { csvName: 'גובה',               dbName: 'height',              type: 'NUMERIC' },
    { csvName: 'מזהה יחידת אורך',    dbName: 'length_unit_id',      type: 'TEXT'    },
    { csvName: 'הפחת ממלאי',         dbName: 'subtract_stock',      type: 'TEXT'    },
    { csvName: 'כמות מינימום',       dbName: 'min_quantity',        type: 'NUMERIC' },
    { csvName: 'כמות מקסימום',       dbName: 'max_quantity',        type: 'NUMERIC' },
    { csvName: 'סדר תצוגה',          dbName: 'sort_order',          type: 'TEXT'    },
    { csvName: 'סטטוס מוצר',         dbName: 'product_status',      type: 'TEXT'    },
    { csvName: 'מספר צפיות',         dbName: 'view_count',          type: 'NUMERIC' },
    { csvName: 'תאריך התחלה',        dbName: 'starts_on',           type: 'TEXT'    },
    { csvName: 'תאריך סיום',         dbName: 'ends_on',             type: 'TEXT'    },
    { csvName: 'תאריך יצירה מוצר',   dbName: 'created_at',          type: 'TEXT'    },
    { csvName: 'תאריך עדכון מוצר',   dbName: 'updated_at',          type: 'TEXT'    },
    { csvName: 'מוסתר',              dbName: 'is_hidden',           type: 'TEXT'    },
    { csvName: 'זאפ',                dbName: 'zap',                 type: 'TEXT'    },
    { csvName: 'תמונה',              dbName: 'image_url',           type: 'TEXT'    },
    { csvName: 'קישור מוצר',         dbName: 'product_url',         type: 'TEXT'    },
    // Populated on 547 of 16,537 products (3.3%), all pointing at ONE id. See
    // the manifest: product category is an ABSENT dimension for this client.
    { csvName: 'מזהה קטגוריה',       dbName: 'category_id',         type: 'TEXT'    },
  ],

  // ── categories ──────────────────────────────────────────────────────────────
  // 110 rows, and they are MARKETING COLLECTIONS, not a product taxonomy:
  // "יחד ממשיכים להיאבק ביוקר", "חגיגת שבועות", "הסל שלנו". Loaded so the names
  // are available for campaign questions; useless for "sales by category",
  // which the manifest refuses outright.
  categories: [
    { csvName: 'מזהה קטגוריה',       dbName: 'category_id',         type: 'TEXT'    },
    { csvName: 'קטגוריה',            dbName: 'category_name',       type: 'TEXT'    },
  ],

  // ── calendar ────────────────────────────────────────────────────────────────
  // Covers all of 2026 while the orders cover 42 days. Joining to it without a
  // date filter invents 323 empty days; every trend must be driven by the
  // orders' own range, never by this file's.
  calendar: [
    { csvName: 'תאריך',              dbName: 'date',                type: 'DATE'    },
    { csvName: 'שנה',                dbName: 'year',                type: 'TEXT'    },
    { csvName: 'חודש',               dbName: 'month',               type: 'TEXT'    },
    { csvName: 'שנה וחודש',          dbName: 'year_month',          type: 'TEXT'    },
    { csvName: 'רבעון',              dbName: 'quarter',             type: 'TEXT'    },
    { csvName: 'שנה ורבעון',         dbName: 'year_quarter',        type: 'TEXT'    },
    { csvName: 'שבוע',               dbName: 'week',                type: 'TEXT'    },
    { csvName: 'יום',                dbName: 'day',                 type: 'TEXT'    },
    { csvName: 'Period',             dbName: 'period',              type: 'TEXT'    },
    { csvName: 'יום בשבוע',          dbName: 'day_of_week',         type: 'TEXT'    },
    { csvName: 'Last2Week',          dbName: 'last_2_week',         type: 'TEXT'    },
    { csvName: 'LastMonth_Flag',     dbName: 'last_month_flag',     type: 'TEXT'    },
    { csvName: 'חג עברי',            dbName: 'hebrew_holiday',      type: 'TEXT'    },
  ],
};

function buildColumnLookup(tableName) {
  const map = new Map();
  for (const col of COLUMN_MAP[tableName] || []) {
    map.set(col.csvName, { type: col.type, dbName: col.dbName });
  }
  return map;
}

module.exports = { buildColumnLookup, COLUMN_MAP };
