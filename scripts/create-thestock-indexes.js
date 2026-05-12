/**
 * Create indexes for the thestock schema.
 * Run: node scripts/create-thestock-indexes.js
 *
 * Creates indexes on key analytical columns and converts the tables from
 * UNLOGGED to regular (logged) once data is confirmed good.
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');

const SCHEMA = 'thestock';

const INDEXES = [
  // payments — transaction_id for JOIN with credits and groupings
  {
    name: 'idx_payments_transaction_id',
    table: 'payments',
    col: '"transaction_id"',
  },
  // payments — payment_type for filtering / grouping by payment method
  {
    name: 'idx_payments_payment_type',
    table: 'payments',
    col: '"payment_type"',
  },
  // payments — payment_type_code
  {
    name: 'idx_payments_payment_type_code',
    table: 'payments',
    col: '"payment_type_code"',
  },

  // credits — transaction_id for JOIN with payments
  {
    name: 'idx_credits_transaction_id',
    table: 'credits',
    col: '"transaction_id"',
  },

  // customers — customer_id (PK surrogate)
  {
    name: 'idx_customers_customer_id',
    table: 'customers',
    col: '"customer_id"',
  },
  // customers — national_id (used for lookups)
  {
    name: 'idx_customers_national_id',
    table: 'customers',
    col: '"national_id"',
  },
  // customers — city for geographic grouping
  {
    name: 'idx_customers_city',
    table: 'customers',
    col: '"city"',
  },

  // products — sku (PK surrogate, used for JOINs with inventory_c100)
  {
    name: 'idx_products_sku',
    table: 'products',
    col: '"sku"',
  },
  // products — barcode for barcode lookups
  {
    name: 'idx_products_barcode',
    table: 'products',
    col: '"barcode"',
  },
  // products — family_code for grouping by product family
  {
    name: 'idx_products_family_code',
    table: 'products',
    col: '"family_code"',
  },
  // products — supplier_code
  {
    name: 'idx_products_supplier_code',
    table: 'products',
    col: '"supplier_code"',
  },

  // warehouses — warehouse_code (PK surrogate)
  {
    name: 'idx_warehouses_warehouse_code',
    table: 'warehouses',
    col: '"warehouse_code"',
  },
  // warehouses — branch_code
  {
    name: 'idx_warehouses_branch_code',
    table: 'warehouses',
    col: '"branch_code"',
  },

  // inventory_c100 — sku for JOIN with products
  {
    name: 'idx_inventory_c100_sku',
    table: 'inventory_c100',
    col: '"sku"',
  },

  // calendar — date for time queries
  {
    name: 'idx_calendar_date',
    table: 'calendar',
    col: '"date"',
  },
  // calendar — year_month for monthly grouping
  {
    name: 'idx_calendar_year_month',
    table: 'calendar',
    col: '"year_month"',
  },
  // calendar — year
  {
    name: 'idx_calendar_year',
    table: 'calendar',
    col: '"year"',
  },

  // calendar_compare — compare_date
  {
    name: 'idx_calendar_compare_date',
    table: 'calendar_compare',
    col: '"compare_date"',
  },
];

async function createIndexes(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog || ((_, msg) => console.log(msg));
  const pool = getPool();
  const client = await pool.connect();

  log('creating_indexes', 'Creating indexes for schema: ' + schema);

  try {
    const tables = ['payments', 'credits', 'customers', 'products', 'warehouses',
      'inventory_c100', 'calendar', 'calendar_compare'];

    for (const t of tables) {
      try {
        await client.query(`ALTER TABLE ${schema}.${t} SET LOGGED`);
        log('creating_indexes', '  SET LOGGED: ' + t);
      } catch {
        // Already logged or table doesn't exist — skip
      }
    }

    for (const idx of INDEXES) {
      const sql = `CREATE INDEX IF NOT EXISTS ${idx.name} ON ${schema}.${idx.table} (${idx.col})`;
      const start = Date.now();
      try {
        await client.query('SET statement_timeout = 600000'); // 10 min per index
        await client.query(sql);
        log('creating_indexes', '  ' + idx.name + ' (' + (Date.now() - start) + 'ms)');
      } catch (err) {
        log('creating_indexes', '  FAILED ' + idx.name + ': ' + err.message);
      }
    }

    log('creating_indexes', 'All indexes created.');
  } finally {
    client.release();
    if (!targetSchema) await endPool();
  }
}

if (require.main === module) {
  createIndexes().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createIndexes };
