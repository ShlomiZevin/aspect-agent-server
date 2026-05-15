/**
 * Column type and name definitions for The Stock tables.
 * Same interface as column-aliases-newdeli.js — exports buildColumnLookup(tableName).
 *
 * Returns Map<csvName, {type, dbName}> for the given table.
 * Hebrew CSV column names are mapped to English DB column names.
 * Columns not listed here default to TEXT and keep their original name.
 */

const COLUMN_MAP = {
  // NOTE: gcsService.getCSVHeaders strips ALL `"` chars from headers (its naive CSV parser
  // toggles state on every quote and never emits one). So `"מק""ט"` arrives as `מקט`,
  // and `"סה""כ מחיר"` arrives as `סהכ מחיר`. Keys below match the parser's output.
  facts: [
    // identifiers
    { csvName: 'מקט',                        dbName: 'sku',                  type: 'TEXT'    },
    { csvName: 'תאריך',                       dbName: 'transaction_date',     type: 'DATE'    },
    { csvName: 'קוד מחסן',                    dbName: 'warehouse_code',       type: 'TEXT'    },
    { csvName: 'מספר עסקה',                  dbName: 'transaction_id',       type: 'TEXT'    },
    { csvName: 'מספר עסקה מקורית',           dbName: 'original_transaction_id', type: 'TEXT' },
    { csvName: 'סוג רשומה',                   dbName: 'record_type',          type: 'TEXT'    },

    // purchase orders (record_type empty + הזמנת רכש filled)
    { csvName: 'הזמנת רכש',                   dbName: 'purchase_order',       type: 'TEXT'    },
    { csvName: 'סטטוס הזמנה',                 dbName: 'order_status',         type: 'TEXT'    },
    { csvName: 'כמות בהזמנה',                 dbName: 'order_qty',            type: 'NUMERIC' },
    { csvName: 'יתרה לאספקה',                 dbName: 'supply_balance',       type: 'NUMERIC' },
    { csvName: 'מחיר ליחידה',                 dbName: 'unit_price',           type: 'NUMERIC' },
    { csvName: 'מטבע המרה',                   dbName: 'conversion_currency',  type: 'TEXT'    },
    { csvName: 'סהכ מחיר',                    dbName: 'total_price',          type: 'NUMERIC' },
    { csvName: 'פרטים',                       dbName: 'details',              type: 'TEXT'    },
    { csvName: 'מטבע בהזמנה',                 dbName: 'order_currency',       type: 'TEXT'    },

    // inventory (record_type='מלאי')
    { csvName: 'סטטוס מלאי',                  dbName: 'inventory_status',     type: 'TEXT'    },
    { csvName: 'יתרת מלאי',                   dbName: 'inventory_balance',    type: 'NUMERIC' },
    { csvName: 'מלאי במחסן C100',             dbName: 'c100_inventory',       type: 'NUMERIC' },
    { csvName: 'ערך מלאי',                    dbName: 'inventory_value',      type: 'NUMERIC' },

    // document / transaction
    { csvName: 'סוג מסמך',                    dbName: 'document_type',        type: 'TEXT'    },
    { csvName: 'מספר קופה',                   dbName: 'register_number',      type: 'TEXT'    },
    { csvName: 'קופה',                         dbName: 'register_name',        type: 'TEXT'    },
    { csvName: 'עמדת מכירה',                  dbName: 'sales_position',       type: 'TEXT'    },
    { csvName: 'שם עמדת מכירה',               dbName: 'sales_position_name',  type: 'TEXT'    },
    { csvName: 'שעת עסקה',                    dbName: 'transaction_time',     type: 'TEXT'    },
    { csvName: 'TRANSTYPE',                   dbName: 'trans_type',           type: 'TEXT'    },
    { csvName: 'סוג עסקה',                    dbName: 'transaction_kind',     type: 'TEXT'    },

    // people
    { csvName: 'מס. לקוח',                    dbName: 'customer_id',          type: 'TEXT'    },
    { csvName: 'קופאי',                       dbName: 'cashier',              type: 'TEXT'    },

    // sales metrics (record_type='מכירות')
    { csvName: 'אחוז מעמ',                    dbName: 'vat_pct',              type: 'NUMERIC' },
    { csvName: 'מחיר מכירה',                  dbName: 'sale_price',           type: 'NUMERIC' },
    { csvName: 'כמות שנמכרה',                 dbName: 'qty_sold',             type: 'NUMERIC' },
    { csvName: 'כמות צירופי מועדון',          dbName: 'loyalty_count',        type: 'NUMERIC' },
    { csvName: 'מכירות ללא מעמ',              dbName: 'sales_ex_vat',         type: 'NUMERIC' },
    { csvName: 'מכירות כולל מעמ',             dbName: 'sales_inc_vat',        type: 'NUMERIC' },

    // targets (record_type='יעדים')
    { csvName: 'יעד מכירות',                  dbName: 'sales_target',         type: 'NUMERIC' },
    { csvName: 'יעד צירופי מועדון',           dbName: 'loyalty_target',       type: 'NUMERIC' },
  ],

  payments: [
    { csvName: 'סכום לתשלום',   dbName: 'amount',            type: 'NUMERIC' },
    { csvName: 'קוד סוג תשלום', dbName: 'payment_type_code', type: 'TEXT'    },
    { csvName: 'סוג תשלום',      dbName: 'payment_type',      type: 'TEXT'    },
    { csvName: 'מספר עסקה',     dbName: 'transaction_id',    type: 'TEXT'    },
  ],

  credits: [
    { csvName: 'מספר עסקה',       dbName: 'transaction_id',     type: 'TEXT'    },
    { csvName: 'הנפקת זיכוי',     dbName: 'credit_issued',      type: 'NUMERIC' },
    { csvName: 'זיכויים במזומן',  dbName: 'cash_credit',        type: 'NUMERIC' },
    { csvName: 'זיכויים באשראי',  dbName: 'card_credit',        type: 'NUMERIC' },
    { csvName: 'הנחת עובדים',     dbName: 'employee_discount',  type: 'NUMERIC' },
    { csvName: 'הנחה מיוחדת',     dbName: 'special_discount',   type: 'NUMERIC' },
  ],

  customers: [
    { csvName: 'מס. לקוח',     dbName: 'customer_id',    type: 'TEXT' },
    { csvName: 'שם פרטי',       dbName: 'first_name',     type: 'TEXT' },
    { csvName: 'שם משפחה',      dbName: 'last_name',      type: 'TEXT' },
    { csvName: 'שם לקוח',       dbName: 'customer_name',  type: 'TEXT' },
    { csvName: 'ת.זהות',        dbName: 'national_id',    type: 'TEXT' },
    { csvName: 'תאריך לידה',    dbName: 'birth_date',     type: 'DATE' },
    { csvName: 'טלפון',          dbName: 'phone',          type: 'TEXT' },
    { csvName: 'עיר',             dbName: 'city',           type: 'TEXT' },
    { csvName: 'אימייל',         dbName: 'email',          type: 'TEXT' },
    { csvName: 'כתובת',          dbName: 'address',        type: 'TEXT' },
  ],

  products: [
    // NOTE: gcsService.getCSVHeaders strips ALL `"` chars from headers (its naive CSV parser
    // toggles state on every quote and never emits one). So `"מק""ט"` arrives as `מקט`,
    // and `"עלות תקן בש""ח"` arrives as `עלות תקן בשח`. Keys below match the parser's output.
    { csvName: 'PART',                              dbName: 'part',                        type: 'TEXT'    },
    { csvName: 'מקט',                                dbName: 'sku',                         type: 'TEXT'    },
    { csvName: 'תאור פריט',                         dbName: 'item_description',            type: 'TEXT'    },
    { csvName: 'ברקוד',                              dbName: 'barcode',                     type: 'TEXT'    },
    { csvName: 'תאור משפחת מוצר',                   dbName: 'family_description',          type: 'TEXT'    },
    { csvName: 'משפחת מוצר',                        dbName: 'family_code',                 type: 'TEXT'    },
    { csvName: 'סוג אריזה',                         dbName: 'package_type',                type: 'TEXT'    },
    { csvName: 'עלות',                               dbName: 'cost',                        type: 'NUMERIC' },
    { csvName: 'מטבע ספק',                          dbName: 'supplier_currency',           type: 'TEXT'    },
    { csvName: 'תכולה',                              dbName: 'contents',                    type: 'TEXT'    },
    { csvName: 'ברקוד אריזה',                       dbName: 'package_barcode',             type: 'TEXT'    },
    { csvName: 'ספק מועדף',                         dbName: 'preferred_supplier',          type: 'TEXT'    },
    { csvName: 'קוד ספק',                           dbName: 'supplier_code',               type: 'TEXT'    },
    { csvName: 'עלות תקן בשח',                      dbName: 'standard_cost_ils',           type: 'NUMERIC' },
    { csvName: 'עלות תקן בשח - היפר טוי',           dbName: 'standard_cost_ils_hypertoy',  type: 'NUMERIC' },
    { csvName: 'הפרש בין עלויות',                   dbName: 'cost_difference',             type: 'NUMERIC' },
    { csvName: 'סוג פריט',                          dbName: 'item_type',                   type: 'TEXT'    },
    { csvName: 'דגם',                                dbName: 'model',                       type: 'TEXT'    },
    { csvName: 'טיפוס משפחה',                       dbName: 'family_type',                 type: 'TEXT'    },
    { csvName: 'תאור טיפוס משפחה',                  dbName: 'family_type_description',     type: 'TEXT'    },
  ],

  warehouses: [
    { csvName: 'קוד מחסן',    dbName: 'warehouse_code', type: 'TEXT'    },
    { csvName: 'שם מחסן',      dbName: 'warehouse_name', type: 'TEXT'    },
    { csvName: 'מחסן',          dbName: 'warehouse',      type: 'TEXT'    },
    { csvName: 'גודל מחסן',    dbName: 'warehouse_size', type: 'NUMERIC' },
    { csvName: 'WH_Type',       dbName: 'wh_type',        type: 'TEXT'    },
    { csvName: 'סניף',          dbName: 'branch_name',    type: 'TEXT'    },
    { csvName: 'בדיקה',         dbName: 'check_field',    type: 'TEXT'    },
    { csvName: 'חתך אזורי',     dbName: 'region',         type: 'TEXT'    },
    { csvName: 'קוד סניף',     dbName: 'branch_code',    type: 'TEXT'    },
  ],

  inventory_c100: [
    // NOTE: see products[] for explanation of the missing `"` chars.
    { csvName: 'מקט מנותק',                dbName: 'sku',            type: 'TEXT'    },
    { csvName: 'מלאי במחסן C100 - מנותק',  dbName: 'c100_inventory', type: 'INTEGER' },
  ],

  calendar: [
    { csvName: 'תאריך',         dbName: 'date',          type: 'DATE'    },
    { csvName: 'שנה',            dbName: 'year',          type: 'INTEGER' },
    { csvName: 'חודש',           dbName: 'month',         type: 'TEXT'    },
    { csvName: 'שנה וחודש',      dbName: 'year_month',    type: 'TEXT'    },
    { csvName: 'רבעון',          dbName: 'quarter',       type: 'TEXT'    },
    { csvName: 'שנה ורבעון',     dbName: 'year_quarter',  type: 'TEXT'    },
    { csvName: 'שבוע',           dbName: 'week',          type: 'INTEGER' },
    { csvName: 'יום',             dbName: 'day',           type: 'INTEGER' },
    { csvName: 'Period',          dbName: 'period',        type: 'INTEGER' },
    { csvName: 'יום בשבוע',      dbName: 'day_of_week',   type: 'TEXT'    },
  ],

  calendar_compare: [
    { csvName: 'תאריך השוואה',       dbName: 'compare_date',         type: 'DATE'    },
    { csvName: 'שנה השוואה',          dbName: 'compare_year',         type: 'INTEGER' },
    { csvName: 'חודש השוואה',         dbName: 'compare_month',        type: 'TEXT'    },
    { csvName: 'שנה וחודש השוואה',    dbName: 'compare_year_month',   type: 'TEXT'    },
    { csvName: 'רבעון השוואה',        dbName: 'compare_quarter',      type: 'TEXT'    },
    { csvName: 'שנה ורבעון השוואה',   dbName: 'compare_year_quarter', type: 'TEXT'    },
    { csvName: 'יום השוואה',          dbName: 'compare_day',          type: 'INTEGER' },
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
