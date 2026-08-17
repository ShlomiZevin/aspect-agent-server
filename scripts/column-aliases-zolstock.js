/**
 * Column type and name definitions for Zol Stock tables.
 * Same interface as column-aliases-thestock.js — exports buildColumnLookup(tableName).
 *
 * Returns Map<csvName, {type, dbName}> for the given table.
 * Hebrew CSV column names are mapped to English DB column names.
 * Columns not listed here default to TEXT and keep their original (Hebrew) name.
 *
 * NOTE: gcsService.getCSVHeaders strips ALL `"` chars from headers. The original
 * ZolStock facts file has no ASCII `"` in its headers (it uses the Hebrew
 * gershayim ״ in `מע״מ`, which is preserved), so its keys match the raw headers
 * verbatim. The newer items/Fact_ZolStock_CSV.csv files DO have a quoted
 * `"מק""ט"` header — after stripping it becomes `מקט`, so that's the csvName
 * used below (not `מק"ט`).
 *
 * Data status (2026-08-10): "order recommendation" data delivered by Reut (BI
 * dev), loaded EXACTLY as the 5 files she shared — no invented/pre-split files.
 * items/stores/calendar dimensions + recommendation_facts (the actual
 * Fact_ZolStock_CSV.csv, loaded whole). No `customers` dimension yet.
 *
 * 2026-08-17: added `inventory` (Inventory_ZolStock_CSV.csv) — additive, does
 * NOT replace `facts`. Column list below is based on a local sample
 * (`Inventory_ZolStock_CSV-001.csv`, 4 cols) — the live Drive file is a
 * different size, so double check against the real headers after the first
 * import (unmapped columns still load fine as TEXT under their raw Hebrew name).
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

  // ── items — product dimension (303,508 rows) ────────────────────────────────
  // Delivered 2026-08-09 in the "המלצה להזמנות" (order recommendation) folder.
  // `sku` is the bridge key to recommendation_facts below; `item_number` is the
  // SAME key already used on facts.item_number, so this table also finally
  // gives sales questions real item names/categories.
  items: [
    { csvName: 'BARCODE_KEY',        dbName: 'barcode_key',      type: 'TEXT'    },
    { csvName: 'מספר פריט',           dbName: 'item_number',      type: 'TEXT'    },
    { csvName: 'ברקוד פריט',          dbName: 'item_barcode',     type: 'TEXT'    },
    { csvName: 'שם פריט',             dbName: 'item_name',        type: 'TEXT'    },
    { csvName: 'ברקוד ושם פריט',      dbName: 'barcode_and_name', type: 'TEXT'    },
    { csvName: 'עלות פריט',           dbName: 'cost',             type: 'NUMERIC' },
    { csvName: 'עלות פריט ללא מעמ',   dbName: 'cost_ex_vat',      type: 'NUMERIC' },
    { csvName: 'מחיר לצרכן',          dbName: 'consumer_price',   type: 'NUMERIC' },
    { csvName: 'נשלח לסגמנט',         dbName: 'sent_to_segment',  type: 'TEXT'    },
    { csvName: 'קטגוריה ראשית',       dbName: 'category',         type: 'TEXT'    },
    { csvName: 'קטגוריה משנית',       dbName: 'subcategory',      type: 'TEXT'    },
    // Source header is `"מק""ט"` (quoted, embedded gershayim-style ASCII quote).
    // gcsService.getCSVHeaders strips ALL `"` chars, so the parsed key is 'מקט'.
    { csvName: 'מקט',                 dbName: 'sku',              type: 'TEXT'    },
    { csvName: 'משפחת פריט',          dbName: 'item_family',      type: 'TEXT'    },
    { csvName: 'קוד טיפוס משפחה',     dbName: 'family_type_code', type: 'TEXT'    },
    { csvName: 'טיפוס משפחה',         dbName: 'family_type',      type: 'TEXT'    },
    { csvName: 'כמות יחידות בקרטון',  dbName: 'units_per_carton', type: 'NUMERIC' },
    { csvName: 'תאור סוג אריזה',      dbName: 'packaging_desc',   type: 'TEXT'    },
    // Only populated for 15,067/303,508 items, non-zero for just 523 — treat as
    // a hint, not a general-purpose reorder threshold (see sql-generator notes).
    { csvName: 'מלאי ביטחון',         dbName: 'safety_stock',     type: 'NUMERIC' },
    { csvName: 'קוד ספק',             dbName: 'supplier_code',    type: 'TEXT'    },
    { csvName: 'ספק',                 dbName: 'supplier',         type: 'TEXT'    },
    { csvName: 'URL_IMG',             dbName: 'image_url',        type: 'TEXT'    },
  ],

  // ── stores — store dimension (139 rows) ─────────────────────────────────────
  // `מספר חנות` is broken (literal "?" on 138/139 rows) — the real store number
  // is the leading digits of `store_label` (e.g. "1180 עכו חדש"). Extract with
  // SPLIT_PART(store_label, ' ', 1) when joining to facts.store_number.
  stores: [
    { csvName: 'מספר חנות',  dbName: 'store_number_raw', type: 'TEXT' },
    { csvName: 'שם חנות',    dbName: 'store_name',       type: 'TEXT' },
    { csvName: 'חנות',       dbName: 'store_label',      type: 'TEXT' },
    { csvName: 'חנות פעילה', dbName: 'is_active',        type: 'TEXT' },
  ],

  // ── calendar — date dimension (735 rows, 2025-01-01..2027-01-01) ────────────
  calendar: [
    { csvName: 'תאריך מנותק',  dbName: 'cal_date', type: 'DATE'    },
    { csvName: 'שנה מנותק',    dbName: 'year',      type: 'INTEGER' },
    { csvName: 'חודש מנותק',   dbName: 'month',     type: 'TEXT'    },
    { csvName: 'חג עברי מנותק', dbName: 'holiday',  type: 'TEXT'    },
  ],

  // ── recommendation_facts — the ACTUAL Fact_ZolStock_CSV.csv (902.5MB,
  //    29,450,600 rows), loaded as-is — one wide table, no invented files.
  //    Mixes 5 row kinds via which columns are populated (no discriminator
  //    column, unlike zolstock.facts' record_type):
  //      - warehouse stock snapshot (sku+warehouse+warehouse_qty only) — 9,153 rows
  //      - customer orders (customer_order_id/customer_order_qty)     — 14,303 rows
  //      - purchase orders (purchase_order_id/purchase_order_qty)     — 753 rows
  //      - store inventory (store_inventory_qty)                      — 2,983,200 rows
  //      - sales (qty_sold/item_number_sales)                         — 26,443,191 rows
  //    The last two duplicate zolstock.facts (fewer columns, same broken
  //    store_number) — steer sales/inventory questions to zolstock.facts
  //    instead (see zolstock.crew.js / sql-generator rules).
  recommendation_facts: [
    { csvName: 'מקט',                     dbName: 'sku',                  type: 'TEXT'    },
    { csvName: 'מחסן',                    dbName: 'warehouse',            type: 'TEXT'    },
    { csvName: 'מלאי נוכחי במחסן',        dbName: 'warehouse_qty',        type: 'NUMERIC' },
    { csvName: 'מספר חנות',               dbName: 'store_number',         type: 'TEXT'    },
    { csvName: 'תאריך',                   dbName: 'row_date',             type: 'DATE'    },
    { csvName: 'הזמנת לקוח',              dbName: 'customer_order_id',    type: 'TEXT'    },
    { csvName: 'כמות הזמנת לקוח ממחסן',   dbName: 'customer_order_qty',   type: 'NUMERIC' },
    { csvName: 'הזמנת רכש',               dbName: 'purchase_order_id',    type: 'TEXT'    },
    { csvName: 'כמות הזמנת רכש למחסן',    dbName: 'purchase_order_qty',   type: 'NUMERIC' },
    { csvName: 'כמות מלאי בחנויות',       dbName: 'store_inventory_qty',  type: 'NUMERIC' },
    // Bare "1" header, always empty in all 29.45M rows — vestigial BI export column.
    { csvName: '1',                       dbName: 'unused_col_1',         type: 'TEXT'    },
    { csvName: 'כמות שנמכרה',             dbName: 'qty_sold',             type: 'NUMERIC' },
    { csvName: 'מספר פריט Sales',         dbName: 'item_number_sales',    type: 'TEXT'    },
  ],
  // ── inventory — per-item/store daily in-stock flag (2,321,997,657 bytes
  //    local sample, 102M+ rows claimed). NOT a stock quantity — `in_stock` is
  //    a 0/1 flag ("קיים במלאי" = "exists in stock"), and `store_number` is
  //    broken (literal "?" on the rows sampled), same pattern as stores.
  //    store_number_raw — treat any store-level breakdown as unreliable until
  //    verified post-import. Bridges to recommendation_facts/facts via
  //    item_number_sales, NOT sku.
  inventory: [
    { csvName: 'תאריך',              dbName: 'row_date',          type: 'DATE'    },
    { csvName: 'מספר פריט Sales',    dbName: 'item_number_sales', type: 'TEXT'    },
    { csvName: 'מספר חנות',          dbName: 'store_number',      type: 'TEXT'    },
    { csvName: 'קיים במלאי',         dbName: 'in_stock',          type: 'NUMERIC' },
  ],
  // customers: [ ... ],   // TODO — still not delivered
};

function buildColumnLookup(tableName) {
  const map = new Map();
  for (const col of COLUMN_MAP[tableName] || []) {
    map.set(col.csvName, { type: col.type, dbName: col.dbName });
  }
  return map;
}

module.exports = { buildColumnLookup };
