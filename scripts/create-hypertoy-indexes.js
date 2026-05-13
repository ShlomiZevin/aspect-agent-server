/**
 * Create indexes for the hypertoy schema.
 * Run: node scripts/create-hypertoy-indexes.js
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');

const SCHEMA = 'hypertoy';

const INDEXES = [
  // facts (1.97M) — primary access patterns
  { name: 'idx_facts_transaction_date',  table: 'facts', col: '"transaction_date"' },
  { name: 'idx_facts_record_type',       table: 'facts', col: '"record_type"' },
  { name: 'idx_facts_warehouse_code',    table: 'facts', col: '"warehouse_code"' },
  { name: 'idx_facts_part',              table: 'facts', col: '"part"' },
  { name: 'idx_facts_transaction_id',    table: 'facts', col: '"transaction_id"' },
  { name: 'idx_facts_customer_id',       table: 'facts', col: '"customer_id"' },
  { name: 'idx_facts_franchisee_code',   table: 'facts', col: '"franchisee_code"' },
  // composite: record_type + date — common filter pattern (sales in period)
  { name: 'idx_facts_rt_date',           table: 'facts', col: '"record_type", "transaction_date"' },

  // payments — transaction_id JOIN
  { name: 'idx_payments_transaction_id', table: 'payments', col: '"transaction_id"' },
  { name: 'idx_payments_payment_type',   table: 'payments', col: '"payment_type"' },

  // pay_accounts — transaction_id JOIN
  { name: 'idx_pay_accounts_tx_id',      table: 'pay_accounts', col: '"transaction_id"' },

  // credits — transaction_id JOIN
  { name: 'idx_credits_transaction_id',  table: 'credits', col: '"transaction_id"' },

  // customers
  { name: 'idx_customers_customer_id',   table: 'customers', col: '"customer_id"' },
  { name: 'idx_customers_national_id',   table: 'customers', col: '"national_id"' },
  { name: 'idx_customers_city',          table: 'customers', col: '"city"' },

  // products
  { name: 'idx_products_part',           table: 'products', col: '"part"' },
  { name: 'idx_products_sku',            table: 'products', col: '"sku"' },
  { name: 'idx_products_barcode',        table: 'products', col: '"barcode"' },
  { name: 'idx_products_family_code',    table: 'products', col: '"family_code"' },
  { name: 'idx_products_supplier_code',  table: 'products', col: '"supplier_code"' },

  // warehouses + stores
  { name: 'idx_warehouses_code',         table: 'warehouses', col: '"warehouse_code"' },
  { name: 'idx_warehouses_branch_code',  table: 'warehouses', col: '"branch_code"' },
  { name: 'idx_stores_store_id',         table: 'stores', col: '"store_id"' },

  // inventory_500
  { name: 'idx_inventory_500_part',      table: 'inventory_500', col: '"part"' },

  // calendar
  { name: 'idx_calendar_date',           table: 'calendar', col: '"date"' },
  { name: 'idx_calendar_year_month',     table: 'calendar', col: '"year_month"' },
  { name: 'idx_calendar_year',           table: 'calendar', col: '"year"' },
  { name: 'idx_calendar_compare_date',   table: 'calendar_compare', col: '"compare_date"' },
];

async function createIndexes(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog || ((_, msg) => console.log(msg));
  const pool = getPool();
  const client = await pool.connect();

  log('creating_indexes', 'Creating indexes for schema: ' + schema);

  try {
    const tables = ['facts', 'payments', 'pay_accounts', 'credits', 'customers', 'products',
      'warehouses', 'stores', 'inventory_500', 'calendar', 'calendar_compare'];

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
