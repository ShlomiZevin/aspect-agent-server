/**
 * Hyper Toy semantic model for the Aspect BI tool.
 *
 * A dataset describes ONE analyzable star: a base table, its joins, and a
 * whitelist of dimensions + measures the query compiler may use. All SQL
 * fragments here are trusted server-side code — user requests only ever
 * reference fields by id, and filter VALUES are always parameterized.
 *
 * hypertoy.facts is a wide table mixing three record kinds (sales / inventory /
 * targets) discriminated by record_type. Every measure declares which record
 * types it aggregates, and the compiler emits FILTER (WHERE record_type = ...)
 * per measure — so revenue and sales_target can sit side by side in one query.
 */

const RT_SALES = 'מכירות';
const RT_INVENTORY = 'מלאי';
const RT_TARGETS = 'יעדים';

const hypertoyDataset = {
  id: 'hypertoy',
  name: 'Hyper Toy',
  description: 'Toy retail chain — sales, inventory, targets (~2M fact rows)',
  schema: 'hypertoy',
  baseTable: 'facts',
  baseAlias: 'f',
  recordTypeColumn: 'f.record_type',
  dateColumn: 'f.transaction_date',

  joins: {
    products:   { table: 'products',   alias: 'p', on: 'f.part = p.part' },
    warehouses: { table: 'warehouses', alias: 'w', on: 'f.warehouse_code = w.warehouse_code' },
    stores:     { table: 'stores',     alias: 's', on: 'f.warehouse_code = s.store_id' },
    customers:  { table: 'customers',  alias: 'c', on: 'f.customer_id = c.customer_id' },
  },

  dimensions: [
    // ── Time ──────────────────────────────────────────────────────────
    { id: 'date_day',     label: 'Day',       group: 'Time', type: 'date',
      sql: 'f.transaction_date' },
    { id: 'date_week',    label: 'Week',      group: 'Time', type: 'date',
      sql: "DATE_TRUNC('week', f.transaction_date)::date" },
    { id: 'date_month',   label: 'Month',     group: 'Time', type: 'text',
      sql: "TO_CHAR(f.transaction_date, 'YYYY-MM')" },
    { id: 'date_quarter', label: 'Quarter',   group: 'Time', type: 'text',
      sql: "TO_CHAR(f.transaction_date, 'YYYY\"-Q\"Q')" },
    { id: 'date_year',    label: 'Year',      group: 'Time', type: 'number',
      sql: 'EXTRACT(YEAR FROM f.transaction_date)::int' },
    { id: 'day_of_week',  label: 'Day of week', group: 'Time', type: 'text',
      sql: "TO_CHAR(f.transaction_date, 'Dy')" },

    // ── Store ─────────────────────────────────────────────────────────
    { id: 'store',            label: 'Store',            labelHe: 'סניף', group: 'Store', type: 'text',
      sql: 'COALESCE(w.warehouse_name, f.warehouse_code)', joins: ['warehouses'],
      valuesFrom: { from: 'warehouses', expr: 'warehouse_name' } },
    { id: 'region',           label: 'Region',           labelHe: 'חתך אזורי', group: 'Store', type: 'text',
      sql: 'w.region', joins: ['warehouses'],
      valuesFrom: { from: 'warehouses', expr: 'region' } },
    { id: 'branch',           label: 'Branch',           labelHe: 'סניף', group: 'Store', type: 'text',
      sql: 'w.branch_name', joins: ['warehouses'],
      valuesFrom: { from: 'warehouses', expr: 'branch_name' } },
    { id: 'store_type',       label: 'Store type',       labelHe: 'סוג חנות', group: 'Store', type: 'text',
      sql: 's.store_type', joins: ['stores'],
      valuesFrom: { from: 'stores', expr: 'store_type' } },
    { id: 'regional_manager', label: 'Regional manager', labelHe: 'מנהל איזור', group: 'Store', type: 'text',
      sql: 's.regional_manager', joins: ['stores'],
      valuesFrom: { from: 'stores', expr: 'regional_manager' } },

    // ── Product ───────────────────────────────────────────────────────
    { id: 'product',        label: 'Product',        labelHe: 'תאור פריט', group: 'Product', type: 'text',
      sql: 'p.item_description', joins: ['products'],
      valuesFrom: { from: 'products', expr: 'item_description' } },
    { id: 'sku',            label: 'SKU',            labelHe: 'מקט', group: 'Product', type: 'text',
      sql: 'p.sku', joins: ['products'],
      valuesFrom: { from: 'products', expr: 'sku' } },
    { id: 'product_family', label: 'Product family', labelHe: 'משפחת מוצר', group: 'Product', type: 'text',
      sql: 'p.family_description', joins: ['products'],
      valuesFrom: { from: 'products', expr: 'family_description' } },
    { id: 'supplier',       label: 'Supplier',       labelHe: 'ספק מועדף', group: 'Product', type: 'text',
      sql: 'p.preferred_supplier', joins: ['products'],
      valuesFrom: { from: 'products', expr: 'preferred_supplier' } },
    { id: 'item_status',    label: 'Item status',    labelHe: 'סטטוס פריט', group: 'Product', type: 'text',
      sql: 'p.item_status', joins: ['products'],
      valuesFrom: { from: 'products', expr: 'item_status' } },

    // ── Sales context ────────────────────────────────────────────────
    { id: 'cashier',       label: 'Cashier',       labelHe: 'קופאי', group: 'Sales context', type: 'text',
      sql: 'f.cashier' },
    { id: 'register',      label: 'Register',      labelHe: 'קופה', group: 'Sales context', type: 'text',
      sql: 'f.register_name' },
    { id: 'campaign',      label: 'Campaign',      labelHe: 'מבצע', group: 'Sales context', type: 'text',
      sql: 'f.campaign_name' },
    { id: 'document_type', label: 'Document type', labelHe: 'סוג מסמך', group: 'Sales context', type: 'text',
      sql: 'f.document_type' },

    // ── Customer ─────────────────────────────────────────────────────
    { id: 'customer_city', label: 'Customer city', labelHe: 'עיר', group: 'Customer', type: 'text',
      sql: 'c.city', joins: ['customers'],
      valuesFrom: { from: 'customers', expr: 'city' } },
  ],

  measures: [
    { id: 'revenue',        label: 'Revenue (ex VAT)',  format: 'currency', recordTypes: [RT_SALES],
      agg: 'SUM', column: 'f.sales_ex_vat' },
    { id: 'revenue_inc_vat', label: 'Revenue (inc VAT)', format: 'currency', recordTypes: [RT_SALES],
      agg: 'SUM', column: 'f.sales_inc_vat' },
    { id: 'profit',         label: 'Profit (ex VAT)',   format: 'currency', recordTypes: [RT_SALES],
      agg: 'SUM', column: 'f.profit_ex_vat' },
    // Margin % = profit / revenue — composed from the two FILTERed sums.
    { id: 'margin_pct',     label: 'Margin %',          format: 'percent',  recordTypes: [RT_SALES],
      expr: ({ rt }) => `ROUND((SUM(f.profit_ex_vat) ${rt(RT_SALES)} / NULLIF(SUM(f.sales_ex_vat) ${rt(RT_SALES)}, 0) * 100)::numeric, 2)` },
    { id: 'qty_sold',       label: 'Units sold',        format: 'number',   recordTypes: [RT_SALES],
      agg: 'SUM', column: 'f.qty_sold' },
    // COUNT(*) not COUNT(DISTINCT transaction_id): each facts row is one line;
    // DISTINCT over ~2M rows times out (see sql-generator RULE 3.5).
    { id: 'line_count',     label: 'Sale lines',        format: 'number',   recordTypes: [RT_SALES],
      agg: 'COUNT', column: '*' },
    { id: 'avg_line_value', label: 'Avg line value',    format: 'currency', recordTypes: [RT_SALES],
      expr: ({ rt }) => `ROUND((SUM(f.sales_ex_vat) ${rt(RT_SALES)} / NULLIF(COUNT(*) ${rt(RT_SALES)}, 0))::numeric, 2)` },
    { id: 'loyalty_signups', label: 'Loyalty signups',  format: 'number',   recordTypes: [RT_SALES],
      agg: 'SUM', column: 'f.loyalty_count' },
    { id: 'sales_target',   label: 'Sales target',      format: 'currency', recordTypes: [RT_TARGETS],
      agg: 'SUM', column: 'f.sales_target' },
    { id: 'target_attainment_pct', label: 'Target attainment %', format: 'percent', recordTypes: [RT_SALES, RT_TARGETS],
      expr: ({ rt }) => `ROUND((SUM(f.sales_ex_vat) ${rt(RT_SALES)} / NULLIF(SUM(f.sales_target) ${rt(RT_TARGETS)}, 0) * 100)::numeric, 2)` },
    { id: 'inventory_units', label: 'Inventory units',  format: 'number',   recordTypes: [RT_INVENTORY],
      agg: 'SUM', column: 'f.inventory_balance' },
    { id: 'inventory_value', label: 'Inventory value',  format: 'currency', recordTypes: [RT_INVENTORY],
      agg: 'SUM', column: 'f.inventory_value' },
  ],
};

module.exports = { hypertoyDataset, RT_SALES, RT_INVENTORY, RT_TARGETS };
