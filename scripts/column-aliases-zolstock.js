/**
 * Column type and name definitions for Zol Stock tables.
 * Same interface as column-aliases-thestock.js — exports buildColumnLookup(tableName).
 *
 * Returns Map<csvName, {type, dbName}> for the given table.
 * Hebrew CSV column names are mapped to English DB column names.
 * Columns not listed here default to TEXT and keep their original (Hebrew) name.
 *
 * NOTE: gcsService.getCSVHeaders strips ALL `"` chars from headers. The ZolStock
 * facts file has no ASCII `"` in its headers (it uses the Hebrew gershayim ״ in
 * `מע״מ`, which is preserved), so the keys below match the raw headers verbatim.
 *
 * Data status: only Facts_ZolStock_CSV.csv (39.46M rows) delivered so far.
 * Dimension files (products / customers / stores / calendar) are not yet provided
 * — add their maps below when they arrive.
 */

const COLUMN_MAP = {
  // ── facts — wide table, mixes 3 record kinds via `record_type` (Fact Type) ──
  //   record_type = 'מכירות' (sales, ~34.76M) — retail sale lines
  //   record_type = 'מלאי'   (inventory, ~2.77M) — stock snapshots (store+item+inventory_qty)
  //   record_type = ''        (empty, ~1.93M) — agent/branch sales (agent_sales_* columns)
  facts: [
    // identifiers / discriminator
    { csvName: 'Is_SSS_Day',                  dbName: 'is_sss_day',               type: 'INTEGER' },
    { csvName: 'Fact Type',                   dbName: 'record_type',              type: 'TEXT'    },
    { csvName: 'סוג מכירה',                    dbName: 'sale_type',                type: 'TEXT'    },
    { csvName: 'מספר מכירה',                   dbName: 'sale_id',                  type: 'TEXT'    },
    { csvName: 'מספר חשבונית',                 dbName: 'invoice_number',           type: 'TEXT'    },
    { csvName: 'חשבוניות ומספר פריט',          dbName: 'invoice_item_key',         type: 'TEXT'    },
    { csvName: 'מספר חנות',                    dbName: 'store_number',             type: 'TEXT'    },

    // sales metrics (record_type='מכירות')
    { csvName: 'כמות שנמכרה',                  dbName: 'qty_sold',                 type: 'NUMERIC' },
    { csvName: 'מחיר ליחידה',                  dbName: 'unit_price',               type: 'NUMERIC' },

    // discounts
    { csvName: 'מזהה הנחה',                    dbName: 'discount_id',              type: 'TEXT'    },
    { csvName: 'הנחה',                         dbName: 'discount',                 type: 'TEXT'    },
    { csvName: 'סוג הנחה',                     dbName: 'discount_type',            type: 'TEXT'    },
    { csvName: 'סכום הנחה',                    dbName: 'discount_amount',          type: 'NUMERIC' },
    { csvName: 'אחוז הנחה',                    dbName: 'discount_pct',             type: 'NUMERIC' },

    { csvName: 'תאריך',                        dbName: 'transaction_date',         type: 'DATE'    },
    { csvName: 'קוד מבצע',                     dbName: 'campaign_code',            type: 'TEXT'    },
    { csvName: 'מספר מוכרן',                   dbName: 'seller_id',                type: 'TEXT'    },
    { csvName: 'מוכרן',                        dbName: 'seller',                   type: 'TEXT'    },

    // cost / revenue (ex-VAT figures are the *_ex / line_total; *_inc_vat include VAT)
    { csvName: 'עלות המכר כולל מעמ',           dbName: 'cogs_inc_vat',             type: 'NUMERIC' },
    { csvName: 'עלות המכר',                    dbName: 'cogs',                     type: 'NUMERIC' },
    { csvName: 'כמות תנועת מלאי',              dbName: 'inventory_movement_qty',   type: 'NUMERIC' },
    { csvName: 'סך סכום לשורה כולל מעמ',       dbName: 'line_total_inc_vat',       type: 'NUMERIC' },
    // The source CSV has a corrupted byte in this header: the `כ` of `סכום` arrives
    // as invalid UTF-8 → two U+FFFD replacement chars. Alias the corrupted form so
    // it still maps (kept alongside the clean key above in case of a clean re-export).
    { csvName: 'סך ס��ום לשורה כולל מעמ', dbName: 'line_total_inc_vat',   type: 'NUMERIC' },
    { csvName: 'סך סכום לשורה',                dbName: 'line_total',               type: 'NUMERIC' },
    { csvName: 'מספר פריט',                    dbName: 'item_number',              type: 'TEXT'    },
    { csvName: 'מספר שורת מכירה',              dbName: 'sale_line_id',             type: 'TEXT'    },
    { csvName: 'מספר לקוח',                    dbName: 'customer_number',          type: 'TEXT'    },
    { csvName: 'לקוח מזוהה',                   dbName: 'customer_identified',      type: 'TEXT'    },
    { csvName: '(ללא)',                        dbName: 'unnamed_col',              type: 'TEXT'    },

    // inventory snapshot (record_type='מלאי')
    { csvName: 'מזהה שורת מלאי',               dbName: 'inventory_line_id',        type: 'TEXT'    },
    { csvName: 'כמות מלאי',                    dbName: 'inventory_qty',            type: 'NUMERIC' },
    { csvName: 'כמות מלאי באריזות',            dbName: 'inventory_qty_packages',   type: 'NUMERIC' },
    { csvName: 'מלאי מינימום',                 dbName: 'min_inventory',            type: 'NUMERIC' },
    { csvName: 'מלאי מינימום באריזות',         dbName: 'min_inventory_packages',   type: 'NUMERIC' },

    // agent / branch sales (record_type='' empty)
    { csvName: 'חשבונית מכירת סוכן',           dbName: 'agent_sale_invoice',       type: 'TEXT'    },
    { csvName: 'סוג חשבונית מכירת סוכן',       dbName: 'agent_sale_invoice_type',  type: 'TEXT'    },
    { csvName: 'סכום מכירות סוכן ללא מע״מ',    dbName: 'agent_sales_ex_vat',       type: 'NUMERIC' },
    { csvName: 'סכום מכירות סוכן כולל מע״מ',   dbName: 'agent_sales_inc_vat',      type: 'NUMERIC' },
    { csvName: 'לקוח מכירת סוכן',              dbName: 'agent_sale_customer',      type: 'TEXT'    },
    { csvName: 'סוכן',                         dbName: 'agent',                    type: 'TEXT'    },

    // stock movement
    { csvName: 'TRANS_Line',                   dbName: 'trans_line',               type: 'TEXT'    },
    { csvName: 'מספר תנועה',                   dbName: 'movement_number',          type: 'TEXT'    },
    { csvName: 'סוג תנועה',                    dbName: 'movement_type',            type: 'TEXT'    },
    { csvName: 'תאור סוג תנועה',               dbName: 'movement_type_desc',       type: 'TEXT'    },
    { csvName: 'שם לקוח',                      dbName: 'customer_name',            type: 'TEXT'    },
    { csvName: 'כמות בתנועה',                  dbName: 'movement_qty',             type: 'NUMERIC' },
    { csvName: 'כמות תנועה באריזות',           dbName: 'movement_qty_packages',    type: 'NUMERIC' },

    // targets (record_type='מכירות' rows also carry the period targets)
    { csvName: 'MonthlyTarget',                dbName: 'monthly_target',           type: 'NUMERIC' },
    { csvName: 'יעד סכום עסקה ממוצעת',         dbName: 'target_avg_transaction',   type: 'NUMERIC' },
    { csvName: 'יעד פריטים בעסקה',             dbName: 'target_items_per_txn',     type: 'NUMERIC' },
    { csvName: 'יעד אחוז רווח מעלות',          dbName: 'target_profit_pct_cost',   type: 'NUMERIC' },
    { csvName: 'יעד אחוז רווח ממכר',           dbName: 'target_profit_pct_sales',  type: 'NUMERIC' },
    { csvName: 'DailyTarget',                  dbName: 'daily_target',             type: 'NUMERIC' },
  ],

  // products:  [ ... ],   // TODO — not delivered yet
  // customers: [ ... ],   // TODO — not delivered yet
  // stores:    [ ... ],   // TODO — not delivered yet
  // calendar:  [ ... ],   // TODO — not delivered yet
};

function buildColumnLookup(tableName) {
  const map = new Map();
  for (const col of COLUMN_MAP[tableName] || []) {
    map.set(col.csvName, { type: col.type, dbName: col.dbName });
  }
  return map;
}

module.exports = { buildColumnLookup };
