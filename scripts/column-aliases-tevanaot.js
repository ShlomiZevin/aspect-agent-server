/**
 * Column type and name definitions for Teva Naot (טבע נאות) tables.
 * Same interface as column-aliases-hypertoy.js — exports buildColumnLookup(tableName).
 *
 * Teva Naot is a QlikSense star-schema export: the fact tables (sales, inventory,
 * orders) carry only measures + a composite synthetic key. The key embeds every
 * dimension component, so we resolve date/warehouse/part/customer by split_part on
 * the key (NO LINK_TABLE needed). See sql-generator tevanaot rules.
 *
 * Composite keys:
 *   sales.warhs_cust_part_date_key     = WARHS-CUST-PART-DATE   ('11-13-55396-44890', DATE = Excel serial)
 *   inventory.branch_part_key          = BRANCH-PART            ('17-8538')
 *   inventory_in_date.end_month_key    = DATE-BRANCH-PART       ('08/05/2023-38-11396', DATE = dd/mm/yyyy)
 *   orders.part_cust_date_key          = PART-CUST-DATE         ('26792-556CUST-44958')
 *
 * NOTE: gcsService.getCSVHeaders strips ALL ASCII `"` chars. Teva headers use the
 * Hebrew gershayim ״ (U+05F4), not ASCII quote, so they survive intact. Keys below
 * match the raw header text. If a load reports an unmapped Hebrew column, add an
 * alias entry here (same pattern as zolstock's corrupted-byte fix).
 */

const COLUMN_MAP = {
  // ── sales — item-level POS sales (key-only fact) ──────────────────────────
  sales: [
    { csvName: 'TEST_TYPE',                  dbName: 'test_type',                type: 'TEXT'    },
    { csvName: 'הנחה ברמת מסמך',             dbName: 'doc_discount',             type: 'NUMERIC' },
    { csvName: 'שעה',                         dbName: 'sale_time',                type: 'NUMERIC' },
    { csvName: 'מספר חשבונית',                dbName: 'invoice_number',           type: 'TEXT'    },
    { csvName: 'סוג חשבונית',                 dbName: 'invoice_type',             type: 'TEXT'    },
    { csvName: 'אחוז מעמ',                    dbName: 'vat_pct',                  type: 'NUMERIC' },
    { csvName: 'מחיר מכירה',                  dbName: 'sale_price',               type: 'NUMERIC' },
    { csvName: 'כמות שנמכרה',                 dbName: 'qty_sold',                 type: 'NUMERIC' },
    { csvName: 'מכירות ללא מעמ',              dbName: 'sales_ex_vat',             type: 'NUMERIC' },
    { csvName: 'מכירות כולל מעמ',             dbName: 'sales_inc_vat',            type: 'NUMERIC' },
    { csvName: 'POSCUSTNUM',                  dbName: 'pos_cust_num',             type: 'TEXT'    },
    { csvName: '%WARHS_CUST_PART_DATE_KEY',   dbName: 'warhs_cust_part_date_key', type: 'TEXT'   },
  ],

  // ── parts — product master ────────────────────────────────────────────────
  parts: [
    { csvName: 'קוד דגם צבע',                 dbName: 'model_color_code',         type: 'TEXT'    },
    { csvName: 'PART',                         dbName: 'part',                     type: 'TEXT'    },
    { csvName: 'מק״ט',                         dbName: 'sku',                      type: 'TEXT'    },
    { csvName: 'תיאור מוצר',                  dbName: 'product_description',      type: 'TEXT'    },
    { csvName: 'ברקוד',                        dbName: 'barcode',                  type: 'TEXT'    },
    { csvName: 'קוד דגם',                     dbName: 'model_code',               type: 'TEXT'    },
    { csvName: 'שם דגם',                       dbName: 'model_name',               type: 'TEXT'    },
    { csvName: 'תאור משפחת מוצר',             dbName: 'family_description',       type: 'TEXT'    },
    { csvName: 'משפחת מוצר',                  dbName: 'family_code',              type: 'TEXT'    },
    { csvName: 'מחיר צרכן',                   dbName: 'consumer_price',           type: 'NUMERIC' },
    { csvName: 'מחיר צרכן כולל מעמ לדגם',     dbName: 'consumer_price_inc_vat_model', type: 'NUMERIC' },
    { csvName: 'מחיר צרכן כולל מעמ',          dbName: 'consumer_price_inc_vat',   type: 'NUMERIC' },
    { csvName: 'ספק(פריט)',                   dbName: 'supplier_name',            type: 'TEXT'    },
    { csvName: 'קוד ספק(פריט)',               dbName: 'supplier_code',            type: 'TEXT'    },
    { csvName: 'משתתף בעמדת מכירה',           dbName: 'pos_participant',          type: 'TEXT'    },
    { csvName: 'מק״ט במערכת חיצונית',         dbName: 'external_sku',             type: 'TEXT'    },
    { csvName: 'תאור טיפוס משפחה',            dbName: 'family_type_description',  type: 'TEXT'    },
    { csvName: 'טיפוס משפחה',                 dbName: 'family_type',              type: 'TEXT'    },
    { csvName: 'משתתף באתר אינטרנט',          dbName: 'website_participant',      type: 'TEXT'    },
    { csvName: 'צבע',                          dbName: 'color',                    type: 'TEXT'    },
    { csvName: 'מידה',                         dbName: 'size',                     type: 'TEXT'    },
    { csvName: 'סוג מנעל',                    dbName: 'shoe_type',                type: 'TEXT'    },
    { csvName: 'קו מוצר',                     dbName: 'product_line',             type: 'TEXT'    },
    { csvName: 'מגדר',                         dbName: 'gender',                   type: 'TEXT'    },
    { csvName: 'קולקציה',                     dbName: 'collection',               type: 'TEXT'    },
    { csvName: 'עונה',                         dbName: 'season',                   type: 'TEXT'    },
    { csvName: 'סוג מנעל שיווקי',             dbName: 'marketing_shoe_type',      type: 'TEXT'    },
    { csvName: 'מוד',                          dbName: 'mod',                      type: 'TEXT'    },
    { csvName: 'קו לתקציב',                   dbName: 'budget_line',              type: 'TEXT'    },
    { csvName: 'סטטוס פריט בנעלי',            dbName: 'item_status',              type: 'TEXT'    },
    { csvName: 'כמות לשריון',                 dbName: 'reserve_qty',              type: 'NUMERIC' },
    { csvName: 'פרמטר14',                      dbName: 'param_14',                 type: 'TEXT'    },
    { csvName: 'פרמטר15',                      dbName: 'param_15',                 type: 'TEXT'    },
    { csvName: 'פרמטר16',                      dbName: 'param_16',                 type: 'TEXT'    },
    { csvName: 'מחסן שחרים?',                 dbName: 'sahrim_warehouse',         type: 'TEXT'    },
    { csvName: 'פרמטר18',                      dbName: 'param_18',                 type: 'TEXT'    },
    { csvName: 'איכות',                        dbName: 'quality',                  type: 'TEXT'    },
    { csvName: 'קוד צבע',                     dbName: 'color_code',               type: 'TEXT'    },
    { csvName: 'צבע A',                        dbName: 'color_a',                  type: 'TEXT'    },
    { csvName: 'צבע B',                        dbName: 'color_b',                  type: 'TEXT'    },
    { csvName: 'צבע C',                        dbName: 'color_c',                  type: 'TEXT'    },
    { csvName: 'צבע D',                        dbName: 'color_d',                  type: 'TEXT'    },
    { csvName: 'צבע E',                        dbName: 'color_e',                  type: 'TEXT'    },
    { csvName: 'שם דגם צבע',                  dbName: 'model_color_name',         type: 'TEXT'    },
    { csvName: 'מגוון',                        dbName: 'variety',                  type: 'TEXT'    },
  ],

  // ── inventory — current stock balance (key BRANCH-PART) ────────────────────
  inventory: [
    { csvName: '%BRANCH_PART_KEY',            dbName: 'branch_part_key',          type: 'TEXT'    },
    { csvName: 'יתרת מלאי',                   dbName: 'inventory_balance',        type: 'NUMERIC' },
    { csvName: 'איתור',                        dbName: 'location',                 type: 'TEXT'    },
    { csvName: 'ערך מלאי',                    dbName: 'inventory_value',          type: 'NUMERIC' },
    { csvName: 'מחיר עלות',                   dbName: 'cost_price',               type: 'NUMERIC' },
    { csvName: 'ערוץ מלאי',                   dbName: 'inventory_channel',        type: 'TEXT'    },
  ],

  // ── inventory_in_date — stock balance at end-of-month (key DATE-BRANCH-PART)
  inventory_in_date: [
    { csvName: '%END_MONTH_BRANCH_PART_KEY',  dbName: 'end_month_branch_part_key', type: 'TEXT'   },
    { csvName: 'יתרת מלאי לתאריך',            dbName: 'inventory_balance_at_date', type: 'NUMERIC' },
  ],

  // ── orders — customer orders (key PART-CUST-DATE) ─────────────────────────
  orders: [
    { csvName: 'ORD',                          dbName: 'ord',                      type: 'TEXT'    },
    { csvName: 'כמות בהזמנת לקוח',            dbName: 'order_qty',                type: 'NUMERIC' },
    { csvName: 'הזמנת לקוח',                  dbName: 'customer_order',           type: 'TEXT'    },
    { csvName: 'סה״כ בהזמנת לקוח ללא מע״מ',  dbName: 'order_total_ex_vat',       type: 'NUMERIC' },
    { csvName: 'הז. רכש (לקוח)',              dbName: 'purchase_order_customer',  type: 'TEXT'    },
    { csvName: 'סטאטוס הזמנת לקוח',           dbName: 'order_status',             type: 'TEXT'    },
    { csvName: '%PART_CUST_DATE_KEY',          dbName: 'part_cust_date_key',       type: 'TEXT'    },
  ],

  // ── customers — customer master ───────────────────────────────────────────
  customers: [
    { csvName: 'מס. לקוח',                    dbName: 'customer_id',              type: 'TEXT'    },
    { csvName: 'שם פרטי',                     dbName: 'first_name',               type: 'TEXT'    },
    { csvName: 'שם משפחה',                    dbName: 'last_name',                type: 'TEXT'    },
    { csvName: 'שם מלא',                      dbName: 'full_name',                type: 'TEXT'    },
    { csvName: 'שם מלא לועזי',               dbName: 'full_name_latin',          type: 'TEXT'    },
    { csvName: 'שם לקוח',                     dbName: 'customer_name',            type: 'TEXT'    },
    { csvName: 'תעודת זהות',                  dbName: 'national_id',              type: 'TEXT'    },
    { csvName: 'ערוץ הפצה',                   dbName: 'distribution_channel',     type: 'TEXT'    },
    { csvName: 'CUST',                         dbName: 'cust',                     type: 'TEXT'    },
  ],

  // ── sites — store / warehouse master ──────────────────────────────────────
  sites: [
    { csvName: 'WARHS',                        dbName: 'warhs',                    type: 'TEXT'    },
    { csvName: 'קוד מחסן',                    dbName: 'warehouse_code',           type: 'TEXT'    },
    { csvName: 'שם מחסן',                     dbName: 'warehouse_name',           type: 'TEXT'    },
    { csvName: 'קוד חנות',                    dbName: 'store_code',               type: 'TEXT'    },
    { csvName: 'שם חנות',                     dbName: 'store_name',               type: 'TEXT'    },
    { csvName: 'BRANCH',                       dbName: 'branch',                   type: 'TEXT'    },
    { csvName: 'ISTRANSITFLAG',                dbName: 'is_transit_flag',          type: 'TEXT'    },
    { csvName: 'TRANSITWARHS',                 dbName: 'transit_warhs',            type: 'TEXT'    },
    { csvName: 'סוג חנות',                    dbName: 'store_type',               type: 'TEXT'    },
    { csvName: 'אשכול הסניף',                 dbName: 'branch_cluster',           type: 'TEXT'    },
    { csvName: 'דירוג החנות',                 dbName: 'store_rank',               type: 'TEXT'    },
    { csvName: 'סוג מיתוג',                   dbName: 'branding_type',            type: 'TEXT'    },
    { csvName: 'זכיין',                        dbName: 'franchisee',               type: 'TEXT'    },
    { csvName: 'עבר מיתוג?',                  dbName: 'rebranded',                type: 'TEXT'    },
    { csvName: 'חנות זהה?',                   dbName: 'identical_store',          type: 'TEXT'    },
    { csvName: 'סוג מחסן',                    dbName: 'warehouse_type',           type: 'TEXT'    },
  ],

  // ── sales_rate — per branch-part sales velocity (Qlik-derived) ────────────
  // Mostly English headers; map the key + commonly-queried numeric measures,
  // unlisted columns default to their CSV name as TEXT.
  sales_rate: [
    { csvName: '%BRANCH_PART_SALESRATE_KEY',   dbName: 'branch_part_salesrate_key', type: 'TEXT'   },
    { csvName: 'TOWARHS',                       dbName: 'to_warhs',                 type: 'TEXT'    },
    { csvName: 'SHELFTIME',                     dbName: 'shelf_time',               type: 'NUMERIC' },
    { csvName: 'SALEDAYS',                      dbName: 'sale_days',                type: 'NUMERIC' },
    { csvName: 'TOTALSALESQUANT',               dbName: 'total_sales_quant',        type: 'NUMERIC' },
    { csvName: 'TOTALNETSALESQUANT',            dbName: 'total_net_sales_quant',    type: 'NUMERIC' },
    { csvName: 'DAILYSALESRATE',                dbName: 'daily_sales_rate',         type: 'NUMERIC' },
    { csvName: 'DAILYNETSALESRATE',             dbName: 'daily_net_sales_rate',     type: 'NUMERIC' },
    { csvName: 'TOTALSALESPRICE',               dbName: 'total_sales_price',        type: 'NUMERIC' },
    { csvName: 'TOTALNETSALESPRICE',            dbName: 'total_net_sales_price',    type: 'NUMERIC' },
    { csvName: 'OPENORDERSQUANT',               dbName: 'open_orders_quant',        type: 'NUMERIC' },
    { csvName: 'OPENPORDERSQUANT',              dbName: 'open_porders_quant',       type: 'NUMERIC' },
  ],

  // ── purchase_orders — supplier purchase orders (הזמנות רכש) ────────────────
  purchase_orders: [
    { csvName: 'SUP',                          dbName: 'sup',                      type: 'TEXT'    },
    { csvName: 'PART',                         dbName: 'part',                     type: 'TEXT'    },
    { csvName: 'כמות הז.רכש',                 dbName: 'po_qty',                   type: 'NUMERIC' },
    { csvName: 'יתרה להספקה הז.רכש',          dbName: 'po_remaining_to_supply',   type: 'NUMERIC' },
    { csvName: 'הזמנת רכש',                   dbName: 'purchase_order',           type: 'TEXT'    },
    { csvName: 'ת.הזמנת רכש',                 dbName: 'po_date',                  type: 'TEXT'    },
    { csvName: 'הזמנת ספק',                   dbName: 'supplier_order',           type: 'TEXT'    },
    { csvName: 'סטאטוס הזמנת רכש',            dbName: 'po_status',                type: 'TEXT'    },
  ],

  // ── suppliers — supplier master (ספקים) ───────────────────────────────────
  suppliers: [
    { csvName: 'SUP',                          dbName: 'sup',                      type: 'TEXT'    },
    { csvName: 'קוד ספק(הז.רכש)',             dbName: 'supplier_code',            type: 'TEXT'    },
    { csvName: 'ספק(הז.רכש)',                 dbName: 'supplier_name',            type: 'TEXT'    },
  ],
};

function buildColumnLookup(tableName) {
  const map = new Map();
  for (const col of COLUMN_MAP[tableName] || []) {
    map.set(col.csvName, { type: col.type, dbName: col.dbName });
  }
  return map;
}

module.exports = { buildColumnLookup };
