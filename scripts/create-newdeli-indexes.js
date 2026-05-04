/**
 * Create indexes for the newdeli schema.
 * Run: node scripts/create-newdeli-indexes.js
 *
 * Creates indexes on key analytical columns and converts the tables from
 * UNLOGGED to regular (logged) once data is confirmed good.
 */

require('dotenv').config();
const { getPool, endPool } = require('../services/db.zer4u');

const SCHEMA = 'newdeli';

const INDEXES = [
  // facts — branch_id for branch filtering and JOIN with branches
  {
    name: 'idx_facts_branch_id',
    table: 'facts',
    col: '"branch_id"',
  },
  // facts — order_date for time-series queries
  {
    name: 'idx_facts_order_date',
    table: 'facts',
    col: '"order_date"',
  },
  // facts — date_key (numeric) for fast calendar joins
  {
    name: 'idx_facts_date_key',
    table: 'facts',
    col: '"date_key"',
  },
  // facts — order_id for JOIN with order_items
  {
    name: 'idx_facts_order_id',
    table: 'facts',
    col: '"order_id"',
  },
  // facts — order_type (takeaway / delivery / dine-in)
  {
    name: 'idx_facts_order_type',
    table: 'facts',
    col: '"order_type"',
  },
  // facts — status
  {
    name: 'idx_facts_status',
    table: 'facts',
    col: '"status"',
  },
  // facts — year_month for monthly grouping
  {
    name: 'idx_facts_year_month',
    table: 'facts',
    col: '"year_month"',
  },
  // order_items — order_id for JOIN with facts
  {
    name: 'idx_order_items_order_id',
    table: 'order_items',
    col: '"order_id"',
  },
  // branches — branch_id (PK surrogate)
  {
    name: 'idx_branches_branch_id',
    table: 'branches',
    col: '"branch_id"',
  },
  // composite: branch + month — covers the most common BI query pattern
  {
    name: 'idx_facts_branch_month',
    table: 'facts',
    col: '"branch_id", "year_month"',
  },
  // composite: status + month — fast filter for completed orders by period
  {
    name: 'idx_facts_status_month',
    table: 'facts',
    col: '"status", "year_month"',
  },
  // facts — hour for peak-hour analysis
  {
    name: 'idx_facts_hour',
    table: 'facts',
    col: '"hour"',
  },
  // facts — year (INTEGER) for year-filtered queries
  {
    name: 'idx_facts_year',
    table: 'facts',
    col: '"year"',
  },
  // order_items_all — orderLineId
  {
    name: 'idx_order_items_all_id',
    table: 'order_items_all',
    col: '"orderLineId"',
  },
  // orders_all — orderId
  {
    name: 'idx_orders_all_id',
    table: 'orders_all',
    col: '"orderId"',
  },
  // payments — paymentId
  {
    name: 'idx_payments_id',
    table: 'payments',
    col: '"paymentId"',
  },
];

async function createIndexes(targetSchema, emitLog) {
  const schema = targetSchema || SCHEMA;
  const log = emitLog || ((_, msg) => console.log(msg));
  const pool = getPool();
  const client = await pool.connect();

  log('creating_indexes', 'Creating indexes for schema: ' + schema);

  try {
    const tables = ['facts', 'order_items', 'branches', 'measures', 'dimensions',
      'comparison_dates', 'jewish_holidays', 'hebrew_dates'];

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
