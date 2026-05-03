/**
 * Column aliases for Zer4U schema.
 *
 * ALIASES: concept → list of possible column names.
 * English DB name comes first — after the typed-column migration schemas use
 * English names, so resolveColumns() finds them immediately.  Hebrew variants
 * are kept as fallbacks for any pre-migration schema still in place.
 *
 * COLUMN_SCHEMA: concept → { type, dbName }
 * Used by buildSchemasFromHeaders to declare proper column types and rename
 * Hebrew CSV headers to English DB column names during import.
 */
const ALIASES = {
  // ── sales ──────────────────────────────────────────────────────────────────
  'sales.store_id':      ['store_id',    'מס.חנות SALES', 'מספר חנות SALES', 'מספר חנות'],
  'sales.customer_id':   ['customer_id', 'מס.לקוח', 'מספר לקוח'],
  'sales.item_code':     ['item_code',   'קוד פריט SALES', 'קוד פריט'],
  'sales.date':          ['sale_date',   'תאריך מקורי SALES', 'תאריך מכירה', 'תאריך'],
  'sales.revenue':       ['revenue',     'מכירה ללא מעמ', 'מכירה ללא מע"מ'],
  'sales.cost':          ['cost',        'עלות ללא מעמ', 'עלות ללא מע"מ'],
  'sales.quantity':      ['quantity',    'כמות ברמת שורה', 'כמות'],
  'sales.invoice_key':   ['UniqueInvoiceKey'],
  'sales.inventory_key': ['InventoryKey'],
  'sales.doc_type':      ['סוג תעודה'],
  // ── stores ─────────────────────────────────────────────────────────────────
  'stores.store_id':     ['store_id',    'מס.חנות', 'מספר חנות'],
  'stores.store_name':   ['store_name',  'שם חנות'],
  // ── customers ──────────────────────────────────────────────────────────────
  'customers.customer_id':   ['customer_id',   'מס.לקוח', 'מספר לקוח'],
  'customers.customer_name': ['customer_name', 'שם לקוח'],
  // ── items ──────────────────────────────────────────────────────────────────
  'items.item_code':  ['item_code',  'קוד פריט'],
  'items.item_name':  ['item_name',  'שם פריט'],
  'items.item_group': ['item_group', 'קבוצת פריט'],
  // ── inventory ──────────────────────────────────────────────────────────────
  'inventory.key':   ['InventoryKey'],
  'inventory.stock': ['stock',       'יתרת מלאי'],
  'inventory.value': ['stock_value', 'ערך מלאי'],
  // ── min_inventory ──────────────────────────────────────────────────────────
  'min_inventory.key':       ['InventoryKey'],
  'min_inventory.min_stock': ['min_stock', 'MLI_MINIMOM'],
};

/**
 * Per-concept schema: the canonical DB column name and PostgreSQL type.
 * Only concepts that need renaming or typed conversion are listed here.
 * Everything else stays as TEXT with the original (sanitized) CSV header name.
 */
const COLUMN_SCHEMA = {
  // type: target PostgreSQL type
  // dbName: English column name used in the DB (overrides the raw CSV header)
  'sales.date':        { type: 'DATE',    dbName: 'sale_date' },
  'sales.store_id':    { type: 'INTEGER', dbName: 'store_id' },
  'sales.customer_id': { type: 'INTEGER', dbName: 'customer_id' },
  'sales.item_code':   { type: 'TEXT',    dbName: 'item_code' },
  'sales.revenue':     { type: 'NUMERIC', dbName: 'revenue' },
  'sales.cost':        { type: 'NUMERIC', dbName: 'cost' },
  'sales.quantity':    { type: 'NUMERIC', dbName: 'quantity' },
  // stores
  'stores.store_id':   { type: 'INTEGER', dbName: 'store_id' },
  'stores.store_name': { type: 'TEXT',    dbName: 'store_name' },
  // customers
  'customers.customer_id':   { type: 'INTEGER', dbName: 'customer_id' },
  'customers.customer_name': { type: 'TEXT',    dbName: 'customer_name' },
  // items
  'items.item_code':  { type: 'TEXT', dbName: 'item_code' },
  'items.item_name':  { type: 'TEXT', dbName: 'item_name' },
  'items.item_group': { type: 'TEXT', dbName: 'item_group' },
};

/**
 * Build a lookup map: csvColumnName → { type, dbName } for a given table.
 * Used by buildSchemasFromHeaders to resolve types + renames from raw CSV headers.
 *
 * Returns a Map<string, { type, dbName }> where key is any known alias for
 * that concept in the given table (Hebrew or English).
 */
function buildColumnLookup(tableName) {
  const lookup = new Map();
  for (const [concept, schema] of Object.entries(COLUMN_SCHEMA)) {
    if (!concept.startsWith(tableName + '.')) continue;
    const aliases = ALIASES[concept] || [];
    for (const alias of aliases) {
      lookup.set(alias, schema);
    }
  }
  return lookup;
}

/**
 * Query actual columns for each table and resolve concepts to real column names.
 * Returns an object: { 'sales.revenue': 'revenue', ... }
 * English names come first in ALIASES so post-migration schemas resolve correctly.
 * Missing columns resolve to null — callers must check before using.
 */
async function resolveColumns(pool, schemaName) {
  const res = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name IN ('sales', 'stores', 'customers', 'items', 'inventory', 'min_inventory')
  `, [schemaName]);

  const tableColumns = {};
  for (const row of res.rows) {
    if (!tableColumns[row.table_name]) tableColumns[row.table_name] = new Set();
    tableColumns[row.table_name].add(row.column_name);
  }

  const resolved = {};
  for (const [concept, aliases] of Object.entries(ALIASES)) {
    const table = concept.split('.')[0];
    const cols = tableColumns[table] || new Set();
    resolved[concept] = aliases.find(a => cols.has(a)) ?? null;
  }

  return resolved;
}

/**
 * Return a quoted SQL identifier for the resolved column,
 * or null if the concept wasn't found in the schema.
 */
function col(resolved, concept) {
  const name = resolved[concept];
  if (!name) return null;
  return `"${name.replace(/"/g, '""')}"`;
}

module.exports = { ALIASES, COLUMN_SCHEMA, buildColumnLookup, resolveColumns, col };
