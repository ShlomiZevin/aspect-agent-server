/**
 * Zol Stock CSV header → DB column mapping.
 *
 * Returns Map<csvName, {type, dbName}> for the given table.
 *
 * Anything NOT listed here still loads — as TEXT, under its raw Hebrew column
 * name. So an unmapped column is silently degraded, never an error. Keep this
 * file complete.
 *
 * HEADER QUOTING QUIRK. `gcsService.getCSVHeaders` strips ALL `"` characters,
 * so the source's `"מק""ט"` header arrives as `מקט` — that, not the quoted
 * form, is the csvName to write here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-08-19 — REBUILT FOR THE 4-FILE DELIVERY.
 *
 * The client cut the feed down to four files: Fact, Items, Stores, Calander.
 * Two previously-loaded sources are RETIRED and deliberately not mapped here:
 *
 *   - `Facts_ZolStock_CSV.csv` (plural, 7.8GB, last exported 2026-06-05) — the
 *     old retail sales table. It was the only source of ACTUAL money:
 *     line_total, cogs, discounts, campaigns, sellers, invoices, customers and
 *     store targets. All of that is gone with it.
 *   - `Inventory_ZolStock_CSV.csv` (3.1GB, in-stock flag only).
 *
 * CONSEQUENCE, AND THE REASON THE RULES READ THE WAY THEY DO: the surviving
 * fact file carries QUANTITIES ONLY — not one monetary column. Revenue and
 * margin are therefore DERIVED against the item master's list prices
 * (`consumer_price`, `cost_ex_vat`), which means they exclude discounts and
 * promotions and are estimates, not takings. The VAT relationship was verified
 * against the delivered data and is exactly 18% (26.02 / 22.05 = 1.1800), so
 * ex-VAT figures divide the consumer price by 1.18 and compare like-for-like
 * against `cost_ex_vat`.
 *
 * The old `store_number` defect is FIXED in this delivery: Stores now carries
 * real numbers (15, 25, 1022 …) with zero `?` placeholders, so the previous
 * `SPLIT_PART(store_label, ' ', 1)` workaround is obsolete — do not reinstate it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const COLUMN_MAP = {
  // ── facts — Fact_ZolStock_CSV.csv (1.06GB, 29,910,277 rows) ────────────────
  //
  // ONE FILE, FIVE ROW KINDS, NO DISCRIMINATOR COLUMN. Which columns are
  // populated is what identifies the row. Measured over the full file:
  //
  //   sales              26,905,987 rows  row_date + store_number + qty_sold + item_number_sales
  //   store inventory     2,983,200 rows  store_number + store_inventory_qty   (NO date)
  //   warehouse stock         8,924 rows  sku + warehouse + warehouse_qty      (NO date)
  //   customer orders (SO)   11,488 rows  priority_customer_number + sku + row_date + customer_order_id
  //   purchase orders (PO)      677 rows  sku + row_date + purchase_order_id
  //
  // Because guessing the row kind from NULL patterns is exactly the trap that
  // produced silent empty answers before, Phase 2 adds a STORED generated
  // `record_type` column so queries can filter explicitly. See
  // create-zolstock-indexes.js.
  //
  // TWO ITEM KEY SYSTEMS, and they are not interchangeable:
  //   - `item_number_sales` — on sales rows, joins items.item_number at 99.9%
  //     (26,877,988 / 26,905,987). This is the key for anything sales-related.
  //   - `sku` — on replenishment rows (warehouse/PO/SO and 14.5% of store
  //     inventory), joins items.sku. Only 14,649 of 298,555 items have one.
  //
  // DATA-QUALITY NOTE, carried deliberately: 2,549,776 store-inventory rows
  // (85% of that kind) have NO item key and NO date — only a store and a
  // quantity. They are loaded rather than dropped so nothing vanishes
  // silently, but they cannot be attributed to an item, so item-level stock
  // questions must use the 433,424 rows that do carry a sku.
  facts: [
    { csvName: 'מספר לקוח פריוריטי',      dbName: 'priority_customer_number', type: 'TEXT'    },
    { csvName: 'מקט',                     dbName: 'sku',                      type: 'TEXT'    },
    { csvName: 'מחסן',                    dbName: 'warehouse',                type: 'TEXT'    },
    { csvName: 'מלאי נוכחי במחסן',        dbName: 'warehouse_qty',            type: 'NUMERIC' },
    { csvName: 'תאריך',                   dbName: 'row_date',                 type: 'DATE'    },
    { csvName: 'הזמנת לקוח',              dbName: 'customer_order_id',        type: 'TEXT'    },
    { csvName: 'כמות הזמנת לקוח ממחסן',   dbName: 'customer_order_qty',       type: 'NUMERIC' },
    { csvName: 'הזמנת רכש',               dbName: 'purchase_order_id',        type: 'TEXT'    },
    { csvName: 'כמות הזמנת רכש למחסן',    dbName: 'purchase_order_qty',       type: 'NUMERIC' },
    { csvName: 'מספר חנות',               dbName: 'store_number',             type: 'TEXT'    },
    { csvName: 'כמות מלאי בחנויות',       dbName: 'store_inventory_qty',      type: 'NUMERIC' },
    // Bare "1" header — empty in all 29,910,277 rows. Vestigial BI export column.
    { csvName: '1',                       dbName: 'unused_col_1',             type: 'TEXT'    },
    { csvName: 'כמות שנמכרה',             dbName: 'qty_sold',                 type: 'NUMERIC' },
    { csvName: 'מספר פריט Sales',         dbName: 'item_number_sales',        type: 'TEXT'    },
  ],

  // ── items — product dimension (303,508 rows, 298,555 distinct item_number) ──
  //
  // THE ONLY SOURCE OF MONEY IN THIS DATASET. `consumer_price` is populated on
  // 99.6% of rows and `cost_ex_vat` on 98.7%, which is what makes derived
  // revenue and margin possible at all.
  //
  // JOIN FAN-OUT: 1,859 item numbers repeat, contributing 4,953 extra rows —
  // a 1.7% inflation if joined naively. Small, but it is silent and it is
  // exactly the defect that inflated hypertoy revenue by 44.6%. Deduplicate
  // with DISTINCT ON (item_number) before aggregating; the materialized views
  // already do.
  items: [
    { csvName: 'BARCODE_KEY',        dbName: 'barcode_key',       type: 'TEXT'    },
    { csvName: 'מספר פריט',           dbName: 'item_number',       type: 'TEXT'    },
    { csvName: 'ברקוד פריט',          dbName: 'item_barcode',      type: 'TEXT'    },
    { csvName: 'שם פריט',             dbName: 'item_name',         type: 'TEXT'    },
    { csvName: 'ברקוד ושם פריט',      dbName: 'barcode_and_name',  type: 'TEXT'    },
    { csvName: 'עלות פריט',           dbName: 'cost',              type: 'NUMERIC' },
    { csvName: 'עלות פריט ללא מעמ',   dbName: 'cost_ex_vat',       type: 'NUMERIC' },
    { csvName: 'מחיר לצרכן',          dbName: 'consumer_price',    type: 'NUMERIC' },
    { csvName: 'נשלח לסגמנט',         dbName: 'sent_to_segment',   type: 'TEXT'    },
    { csvName: 'קטגוריה ראשית',       dbName: 'category',          type: 'TEXT'    },
    { csvName: 'קטגוריה משנית',       dbName: 'subcategory',       type: 'TEXT'    },
    // Previously unmapped — loaded as a raw Hebrew column name, which made it
    // unusable from generated SQL.
    { csvName: 'ספק פוזיטיב',         dbName: 'positive_supplier', type: 'TEXT'    },
    { csvName: 'מקט',                 dbName: 'sku',               type: 'TEXT'    },
    { csvName: 'משפחת פריט',          dbName: 'item_family',       type: 'TEXT'    },
    { csvName: 'קוד טיפוס משפחה',     dbName: 'family_type_code',  type: 'TEXT'    },
    { csvName: 'טיפוס משפחה',         dbName: 'family_type',       type: 'TEXT'    },
    { csvName: 'כמות יחידות בקרטון',  dbName: 'units_per_carton',  type: 'NUMERIC' },
    { csvName: 'תאור סוג אריזה',      dbName: 'packaging_desc',    type: 'TEXT'    },
    // Populated for only 15,067 of 303,508 items — a hint, not a general-purpose
    // reorder threshold.
    { csvName: 'מלאי ביטחון',         dbName: 'safety_stock',      type: 'NUMERIC' },
    { csvName: 'קוד ספק',             dbName: 'supplier_code',     type: 'TEXT'    },
    { csvName: 'ספק',                 dbName: 'supplier',          type: 'TEXT'    },
    { csvName: 'URL_IMG',             dbName: 'image_url',         type: 'TEXT'    },
  ],

  // ── stores — store dimension (139 rows) ─────────────────────────────────────
  // `store_number` is CLEAN in this delivery (real numbers, zero "?" rows), so
  // it joins facts.store_number directly. The old SPLIT_PART(store_label,' ',1)
  // workaround is obsolete.
  // `is_active` is 'True' on all 139 rows, so it does not discriminate anything.
  stores: [
    { csvName: 'מספר חנות',  dbName: 'store_number',     type: 'TEXT' },
    { csvName: 'שם חנות',    dbName: 'store_name',       type: 'TEXT' },
    { csvName: 'חנות',       dbName: 'store_label',      type: 'TEXT' },
    { csvName: 'חנות פעילה', dbName: 'is_active',        type: 'TEXT' },
    // Previously unmapped. Populated on 70 of 139 stores, single value 'D'.
    { csvName: 'סניפי סגמנט', dbName: 'segment_branch',  type: 'TEXT' },
  ],

  // ── calendar — date dimension (733 rows, 2025-01-01 onward) ─────────────────
  // `holiday` carries Hebrew holiday names on 111 rows (15%) — genuinely useful
  // for a retailer, since Israeli trade is strongly holiday-driven.
  calendar: [
    { csvName: 'תאריך מנותק',   dbName: 'cal_date', type: 'DATE'    },
    { csvName: 'שנה מנותק',     dbName: 'year',     type: 'INTEGER' },
    { csvName: 'חודש מנותק',    dbName: 'month',    type: 'TEXT'    },
    { csvName: 'חג עברי מנותק', dbName: 'holiday',  type: 'TEXT'    },
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
