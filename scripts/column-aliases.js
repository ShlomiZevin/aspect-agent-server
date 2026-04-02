/**
 * Column aliases for Zer4U schema.
 *
 * Maps canonical concept names → list of possible Hebrew column names.
 * First match in the list wins. This way if the client renames a column
 * slightly (e.g. removes punctuation) the import still works.
 *
 * To add a new alias: just append to the array for that concept.
 */
const ALIASES = {
  // ── sales ──────────────────────────────────────────────────────────
  'sales.store_id':      ['מס.חנות SALES', 'מספר חנות SALES', 'מספר חנות'],
  'sales.customer_id':   ['מס.לקוח', 'מספר לקוח'],
  'sales.item_code':     ['קוד פריט SALES', 'קוד פריט'],
  'sales.date':          ['תאריך מקורי SALES', 'תאריך מכירה', 'תאריך'],
  'sales.revenue':       ['מכירה ללא מעמ', 'מכירה ללא מע"מ'],
  'sales.cost':          ['עלות ללא מעמ', 'עלות ללא מע"מ'],
  'sales.quantity':      ['כמות ברמת שורה', 'כמות'],
  'sales.invoice_key':   ['UniqueInvoiceKey'],
  'sales.inventory_key': ['InventoryKey'],
  'sales.doc_type':      ['סוג תעודה'],
  // ── stores ─────────────────────────────────────────────────────────
  'stores.store_id':     ['מס.חנות', 'מספר חנות'],
  'stores.store_name':   ['שם חנות'],
  // ── customers ──────────────────────────────────────────────────────
  'customers.customer_id':   ['מס.לקוח', 'מספר לקוח'],
  'customers.customer_name': ['שם לקוח'],
  // ── items ──────────────────────────────────────────────────────────
  'items.item_code':  ['קוד פריט'],
  'items.item_name':  ['שם פריט'],
  'items.item_group': ['קבוצת פריט'],
};

/**
 * Query actual columns for each table and resolve concepts to real column names.
 * Returns an object: { 'sales.revenue': 'מכירה ללא מעמ', ... }
 * Missing columns resolve to null — callers must check before using.
 */
async function resolveColumns(pool, schemaName) {
  const res = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name IN ('sales', 'stores', 'customers', 'items')
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

module.exports = { resolveColumns, col };
