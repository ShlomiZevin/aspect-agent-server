/**
 * Column type and name definitions for Hyper Toy tables.
 * Same interface as column-aliases-thestock.js — exports buildColumnLookup(tableName).
 *
 * NOTE: gcsService.getCSVHeaders strips ALL `"` chars from headers (its naive CSV
 * parser toggles inQuotes on every quote and never emits one). So `"מק""ט"` arrives
 * as `מקט`, `"עלות תקן בש""ח"` arrives as `עלות תקן בשח`, etc. Keys below match
 * the parser's actual output (no `"` characters).
 */

const COLUMN_MAP = {
  facts: [
    // identifiers
    { csvName: 'PART',                       dbName: 'part',                       type: 'TEXT'    },
    { csvName: 'קוד מחסן',                   dbName: 'warehouse_code',             type: 'TEXT'    },
    { csvName: 'Line',                       dbName: 'line',                       type: 'TEXT'    },
    { csvName: 'מספר קופה',                  dbName: 'register_number',            type: 'TEXT'    },
    { csvName: 'קופה',                        dbName: 'register_name',              type: 'TEXT'    },

    // campaign
    { csvName: 'קוד מבצע ראשון',             dbName: 'campaign_code',              type: 'TEXT'    },
    { csvName: 'מבצע ראשון',                  dbName: 'campaign_name',              type: 'TEXT'    },

    // document / transaction
    { csvName: 'פרטים',                       dbName: 'details',                    type: 'TEXT'    },
    { csvName: 'סוג מסמך',                   dbName: 'document_type',              type: 'TEXT'    },
    { csvName: 'שעת עסקה',                   dbName: 'transaction_time',           type: 'TEXT'    },
    { csvName: 'TRANSTYPE',                  dbName: 'trans_type',                 type: 'TEXT'    },
    { csvName: 'תאריך',                       dbName: 'transaction_date',           type: 'DATE'    },
    { csvName: 'מספר עסקה',                  dbName: 'transaction_id',             type: 'TEXT'    },
    { csvName: 'מספר עסקה מקורית',           dbName: 'original_transaction_id',    type: 'TEXT'    },
    { csvName: 'סוג עסקה',                   dbName: 'transaction_kind',           type: 'TEXT'    },

    // people
    { csvName: 'מס. לקוח',                    dbName: 'customer_id',                type: 'TEXT'    },
    { csvName: 'קופאי',                       dbName: 'cashier',                    type: 'TEXT'    },
    { csvName: 'עמדת מכירה',                  dbName: 'sales_position',             type: 'TEXT'    },
    { csvName: 'שם עמדת מכירה',              dbName: 'sales_position_name',        type: 'TEXT'    },
    { csvName: 'מוכרן',                       dbName: 'seller',                     type: 'TEXT'    },

    // amounts (numerics)
    { csvName: 'אחוז מעמ',                   dbName: 'vat_pct',                    type: 'NUMERIC' },
    { csvName: 'מחיר מכירה',                  dbName: 'sale_price',                 type: 'NUMERIC' },
    { csvName: 'כמות שנמכרה',                dbName: 'qty_sold',                   type: 'NUMERIC' },
    { csvName: 'כמות צירופי מועדון',         dbName: 'loyalty_count',              type: 'NUMERIC' },
    { csvName: 'מכירות ללא מעמ',             dbName: 'sales_ex_vat',               type: 'NUMERIC' },
    { csvName: 'מכירות כולל מעמ',            dbName: 'sales_inc_vat',              type: 'NUMERIC' },
    { csvName: 'מכירות WOLT',                dbName: 'wolt_sales',                 type: 'NUMERIC' },
    { csvName: 'סוג רשומה',                  dbName: 'record_type',                type: 'TEXT'    },
    { csvName: 'COSTT',                      dbName: 'costt',                      type: 'NUMERIC' },
    // gcsService strips embedded `"` → these arrive without the quote
    { csvName: 'עלות ללא מעמ',                dbName: 'cost_ex_vat',                type: 'NUMERIC' },
    { csvName: 'עלות כולל מעמ',               dbName: 'cost_inc_vat',               type: 'NUMERIC' },
    { csvName: 'רווח ללא מעמ',                dbName: 'profit_ex_vat',              type: 'NUMERIC' },
    { csvName: 'רווח כולל מעמ',               dbName: 'profit_inc_vat',             type: 'NUMERIC' },

    // franchisee
    { csvName: 'קוד זכיין',                   dbName: 'franchisee_code',            type: 'TEXT'    },
    { csvName: 'שם זכיין',                    dbName: 'franchisee_name',            type: 'TEXT'    },
    { csvName: 'סוג הזמנה - זכיין',          dbName: 'franchisee_order_type',      type: 'TEXT'    },

    // credit sales
    { csvName: 'מספר חשבונית מרכזת',         dbName: 'consolidated_invoice_number', type: 'TEXT'   },
    { csvName: 'כמות מכירות בהקפה',          dbName: 'credit_sales_count',         type: 'NUMERIC' },
    { csvName: 'מכירות בהקפה',                dbName: 'credit_sales_amount',        type: 'NUMERIC' },

    // inventory (record_type='מלאי' rows)
    { csvName: 'יתרת מלאי',                   dbName: 'inventory_balance',          type: 'NUMERIC' },
    { csvName: 'ערך מלאי',                    dbName: 'inventory_value',            type: 'NUMERIC' },

    // targets (record_type='יעדים' rows)
    { csvName: 'יעד מכירות',                  dbName: 'sales_target',               type: 'NUMERIC' },
    { csvName: 'יעד צירופי מועדון',           dbName: 'loyalty_target',             type: 'NUMERIC' },
  ],

  payments: [
    { csvName: 'סכום לתשלום',   dbName: 'amount',            type: 'NUMERIC' },
    { csvName: 'קוד סוג תשלום', dbName: 'payment_type_code', type: 'TEXT'    },
    { csvName: 'סוג תשלום',      dbName: 'payment_type',      type: 'TEXT'    },
    { csvName: 'מספר עסקה',     dbName: 'transaction_id',    type: 'TEXT'    },
  ],

  pay_accounts: [
    { csvName: 'מספר עסקה',     dbName: 'transaction_id', type: 'TEXT' },
    { csvName: 'מס. חשבון בנק', dbName: 'bank_account',   type: 'TEXT' },
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
    // gcsService strips embedded quote chars — keys reflect parser output
    { csvName: 'PART',                          dbName: 'part',                          type: 'TEXT'    },
    { csvName: 'מקט',                            dbName: 'sku',                           type: 'TEXT'    },
    { csvName: 'תאור פריט',                     dbName: 'item_description',              type: 'TEXT'    },
    { csvName: 'ברקוד',                          dbName: 'barcode',                       type: 'TEXT'    },
    { csvName: 'תאור משפחת מוצר',               dbName: 'family_description',            type: 'TEXT'    },
    { csvName: 'משפחת מוצר',                    dbName: 'family_code',                   type: 'TEXT'    },
    { csvName: 'תאור לועזי',                    dbName: 'latin_description',             type: 'TEXT'    },
    { csvName: 'פרמטר 13 למוצר',                 dbName: 'param_13',                      type: 'TEXT'    },
    { csvName: 'פרמטר 16 למוצר',                 dbName: 'param_16',                      type: 'TEXT'    },
    { csvName: 'פרמטר 17 למוצר',                 dbName: 'param_17',                      type: 'TEXT'    },
    { csvName: 'תכולת קרטון',                    dbName: 'carton_contents',               type: 'TEXT'    },
    { csvName: 'תכולת אינר',                     dbName: 'inner_contents',                type: 'TEXT'    },
    { csvName: 'ספק מועדף',                     dbName: 'preferred_supplier',            type: 'TEXT'    },
    { csvName: 'קוד ספק',                       dbName: 'supplier_code',                 type: 'TEXT'    },
    { csvName: 'סוג פריט',                      dbName: 'item_type',                     type: 'TEXT'    },
    { csvName: 'דגם',                            dbName: 'model',                         type: 'TEXT'    },
    { csvName: 'טיפוס משפחה',                   dbName: 'family_type',                   type: 'TEXT'    },
    { csvName: 'תאור טיפוס משפחה',              dbName: 'family_type_description',       type: 'TEXT'    },
    { csvName: 'מחיר קניה',                     dbName: 'purchase_price',                type: 'NUMERIC' },
    { csvName: 'מחירון זכיין',                  dbName: 'franchise_price',               type: 'NUMERIC' },
    { csvName: 'מחירון וולט',                   dbName: 'wolt_price',                    type: 'NUMERIC' },
    { csvName: 'מחיר צרכן כולל מעמ',            dbName: 'consumer_price_inc_vat',        type: 'NUMERIC' },
    { csvName: 'עלות תקן בשח',                  dbName: 'standard_cost_ils',             type: 'NUMERIC' },
    { csvName: 'עלות תקן בשח - הסטוק',          dbName: 'standard_cost_ils_thestock',    type: 'NUMERIC' },
    { csvName: 'עלות תקן בשח - פיראט',          dbName: 'standard_cost_ils_pirat',       type: 'NUMERIC' },
    { csvName: 'הפרש בין עלויות',               dbName: 'cost_difference',               type: 'NUMERIC' },
    { csvName: 'ספק לוגיסטי',                   dbName: 'logistic_supplier',             type: 'TEXT'    },
    { csvName: 'סטטוס פריט',                    dbName: 'item_status',                   type: 'TEXT'    },
    { csvName: 'מחיר FOB',                       dbName: 'fob_price',                     type: 'NUMERIC' },
  ],

  warehouses: [
    { csvName: 'קוד מחסן',    dbName: 'warehouse_code', type: 'TEXT'    },
    { csvName: 'שם מחסן',      dbName: 'warehouse_name', type: 'TEXT'    },
    { csvName: 'מחסן',          dbName: 'warehouse',      type: 'TEXT'    },
    { csvName: 'גודל מחסן',    dbName: 'warehouse_size', type: 'NUMERIC' },
    { csvName: 'WH_Type',       dbName: 'wh_type',        type: 'TEXT'    },
    { csvName: 'סניף',          dbName: 'branch_name',    type: 'TEXT'    },
    { csvName: 'חתך אזורי',     dbName: 'region',         type: 'TEXT'    },
    { csvName: 'קוד סניף',     dbName: 'branch_code',    type: 'TEXT'    },
  ],

  stores: [
    { csvName: 'מס.חנות',          dbName: 'store_id',           type: 'TEXT' },
    { csvName: 'AGENT_ID',          dbName: 'agent_id',           type: 'TEXT' },
    { csvName: 'מנהל איזור',         dbName: 'regional_manager',   type: 'TEXT' },
    { csvName: 'סוג חנות',          dbName: 'store_type',         type: 'TEXT' },
    { csvName: 'חנות_או_מחסן',     dbName: 'store_or_warehouse', type: 'TEXT' },
    { csvName: 'שם חנות',          dbName: 'store_name',         type: 'TEXT' },
    { csvName: 'תאריך פתיחת חנות', dbName: 'opened_date',        type: 'DATE' },
    { csvName: 'תאריך סגירת חנות', dbName: 'closed_date',        type: 'DATE' },
  ],

  inventory_500: [
    { csvName: 'PART',                   dbName: 'part',                 type: 'TEXT'    },
    { csvName: 'מלאי במחסן 500',         dbName: 'inventory_500',        type: 'NUMERIC' },
    { csvName: 'ערך מלאי במחסן 500',     dbName: 'inventory_500_value',  type: 'NUMERIC' },
  ],

  calendar: [
    { csvName: 'תאריך',         dbName: 'date',           type: 'DATE'    },
    { csvName: 'שנה',            dbName: 'year',           type: 'INTEGER' },
    { csvName: 'חודש',           dbName: 'month',          type: 'TEXT'    },
    { csvName: 'שנה וחודש',      dbName: 'year_month',     type: 'TEXT'    },
    { csvName: 'רבעון',          dbName: 'quarter',        type: 'TEXT'    },
    { csvName: 'שנה ורבעון',     dbName: 'year_quarter',   type: 'TEXT'    },
    { csvName: 'שבוע',           dbName: 'week',           type: 'INTEGER' },
    { csvName: 'יום',             dbName: 'day',            type: 'INTEGER' },
    { csvName: 'Period',          dbName: 'period',         type: 'INTEGER' },
    { csvName: 'יום בשבוע',      dbName: 'day_of_week',    type: 'TEXT'    },
    { csvName: 'Last2Week',       dbName: 'last_2_week',    type: 'TEXT'    },
    { csvName: 'LastMonth_Flag',  dbName: 'last_month_flag', type: 'TEXT'   },
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
