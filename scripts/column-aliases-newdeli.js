/**
 * Column type and name definitions for New Deli tables.
 * Same interface as column-aliases.js — exports buildColumnLookup(tableName).
 *
 * Returns Map<csvName, {type, dbName}> for the given table.
 * Hebrew CSV column names are mapped to English DB column names.
 * Columns not listed here default to TEXT and keep their original name.
 */

// All known columns — Hebrew csvName → English dbName + type.
// TEXT columns are listed only when they need English renaming.
const COLUMN_MAP = {
  facts: [
    // identifiers
    { csvName: 'מזהה הזמנה',         dbName: 'order_id',         type: 'TEXT'    },
    { csvName: 'מזהה סניף',           dbName: 'branch_id',        type: 'TEXT'    },
    { csvName: 'מספר הזמנה',          dbName: 'order_number',     type: 'TEXT'    },

    // date / time
    { csvName: 'תאריך',               dbName: 'order_date',       type: 'DATE'    },
    { csvName: 'date_key',            dbName: 'date_key',         type: 'INTEGER' },
    { csvName: 'שנה וחודש',           dbName: 'year_month',       type: 'TEXT'    },
    { csvName: 'שנה',                 dbName: 'year',             type: 'INTEGER' },
    { csvName: 'חודש',                dbName: 'month',            type: 'TEXT'    },
    { csvName: 'יום',                 dbName: 'day',              type: 'INTEGER' },
    { csvName: 'שעה',                 dbName: 'hour',             type: 'TEXT'    },
    { csvName: 'יום בשבוע',           dbName: 'day_of_week',      type: 'TEXT'    },

    // order attributes
    { csvName: 'סוג הזמנה',           dbName: 'order_type',       type: 'TEXT'    },
    { csvName: 'אופן תשלום',          dbName: 'payment_method',   type: 'TEXT'    },
    { csvName: 'מספר אורחים',         dbName: 'guest_count',      type: 'INTEGER' },
    { csvName: 'כמות ארוחות בהזמנה', dbName: 'item_count',       type: 'INTEGER' },

    // amounts
    { csvName: 'סכום הזמנה',          dbName: 'order_revenue',    type: 'NUMERIC' },
    { csvName: 'סכום הנחה בהזמנה',   dbName: 'discount_amount',  type: 'NUMERIC' },
    // אחוז הנחה בהזמנה has values like "0%" — keep TEXT so NUMERIC parse does not nullify
    { csvName: 'אחוז הנחה בהזמנה',   dbName: 'discount_pct',     type: 'TEXT'    },
    { csvName: 'סכום ביטול',          dbName: 'cancel_amount',    type: 'NUMERIC' },
    { csvName: 'אחוז טיפ בהזמנה',    dbName: 'tip_pct',          type: 'NUMERIC' },
    { csvName: 'סכום טיפ בהזמנה',    dbName: 'tip_amount',       type: 'NUMERIC' },

    // already-English columns — listed here so type overrides apply
    { csvName: 'total',               dbName: 'total',            type: 'NUMERIC' },
    { csvName: 'deliveryCost',        dbName: 'deliveryCost',     type: 'NUMERIC' },
    { csvName: 'mcTotalBenefits',     dbName: 'mcTotalBenefits',  type: 'NUMERIC' },
    { csvName: 'status',              dbName: 'status',           type: 'TEXT'    },
  ],

  branches: [
    { csvName: 'מזהה סניף', dbName: 'branch_id',   type: 'TEXT' },
    { csvName: 'סניף',      dbName: 'branch_name', type: 'TEXT' },
    { csvName: 'חברה',      dbName: 'company',     type: 'TEXT' },
  ],

  order_items: [
    { csvName: 'מזהה הזמנה',          dbName: 'order_id',   type: 'TEXT'    },
    { csvName: 'כמות מנות בהזמנה',   dbName: 'item_count', type: 'INTEGER' },
    { csvName: 'פירוט מנות בהזמנה',  dbName: 'item_names', type: 'TEXT'    },
  ],

  jewish_holidays: [
    { csvName: 'date_key', dbName: 'date_key', type: 'INTEGER' },
  ],

  hebrew_dates: [
    { csvName: 'date_key', dbName: 'date_key', type: 'INTEGER' },
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
