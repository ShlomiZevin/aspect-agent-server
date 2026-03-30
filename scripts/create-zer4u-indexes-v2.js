/**
 * Create Zer4U indexes by reading from the live schema dynamically.
 *
 * Instead of a hardcoded list, we query pg_indexes on the live 'zer4u'
 * schema and recreate all indexes on the target schema (e.g. zer4u_new).
 * MV indexes are skipped — they are created automatically when the
 * materialized views are refreshed.
 *
 * Helper functions (parse_date_ddmmyyyy, to_numeric_safe, to_int_safe)
 * are always created first since expression indexes depend on them.
 *
 * Strategy: group indexes by table, process all same-table indexes in
 * parallel (up to MAX_PER_TABLE=8). This maximizes OS page cache sharing —
 * first connection reads the table from disk, the rest read from RAM cache.
 */

require('dotenv').config();
const { Pool } = require('pg');

const SOURCE_SCHEMA = 'zer4u'; // live schema to read index DDL from

// Tables that are materialized views — their indexes are auto-created on REFRESH
const MV_TABLES = new Set([
  'mv_sales_by_customer',
  'mv_sales_by_month',
  'mv_sales_by_product',
  'mv_sales_by_store',
  'mv_sales_by_store_month',
  'mv_sales_by_year',
]);

// Sequential indexing (1 at a time): gives all IOPS to a single index build.
// Cloud SQL disk is too small for parallel sort — parallel builds starve each other.
const MAX_PER_TABLE = 1;

function getSetupSQL(schemaName) {
  return `
CREATE OR REPLACE FUNCTION ${schemaName}.parse_date_ddmmyyyy(text)
RETURNS date AS $$
  SELECT CASE
    WHEN $1 IS NULL OR $1 = '' THEN NULL
    ELSE TO_DATE($1, 'DD/MM/YYYY')
  END
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION ${schemaName}.to_numeric_safe(text)
RETURNS numeric AS $$
  SELECT CASE
    WHEN $1 IS NULL OR $1 = '' THEN NULL
    ELSE $1::numeric
  END
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION ${schemaName}.to_int_safe(text)
RETURNS integer AS $$
  SELECT CASE
    WHEN $1 IS NULL OR $1 = '' THEN NULL
    ELSE $1::integer
  END
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION ${schemaName}.to_int_safe(numeric)
RETURNS integer AS $$
  SELECT CASE
    WHEN $1 IS NULL THEN NULL
    ELSE $1::integer
  END
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;
`;
}

/**
 * Bootstrap indexes: created when no reference schema has index DDL.
 * Covers the most important columns for joins and filters.
 */
function getBootstrapIndexSQL(schemaName) {
  const s = schemaName;
  return [
    // sales — most queried table
    { table: 'sales',     sql: `CREATE INDEX IF NOT EXISTS idx_sales_customer      ON ${s}.sales ("מס.לקוח")` },
    { table: 'sales',     sql: `CREATE INDEX IF NOT EXISTS idx_sales_store         ON ${s}.sales ("מס.חנות SALES")` },
    { table: 'sales',     sql: `CREATE INDEX IF NOT EXISTS idx_sales_item_code     ON ${s}.sales ("קוד פריט SALES")` },
    { table: 'sales',     sql: `CREATE INDEX IF NOT EXISTS idx_sales_date_parsed   ON ${s}.sales (${s}.parse_date_ddmmyyyy("תאריך מקורי SALES"))` },
    { table: 'sales',     sql: `CREATE INDEX IF NOT EXISTS idx_sales_invoice_key   ON ${s}.sales ("UniqueInvoiceKey")` },
    { table: 'sales',     sql: `CREATE INDEX IF NOT EXISTS idx_sales_inventory_key ON ${s}.sales ("InventoryKey")` },
    { table: 'sales',     sql: `CREATE INDEX IF NOT EXISTS idx_sales_doc_type      ON ${s}.sales ("סוג תעודה")` },
    { table: 'sales',     sql: `CREATE INDEX IF NOT EXISTS idx_sales_revenue       ON ${s}.sales ("מכירה ללא מע\\"מ")` },
    // customers
    { table: 'customers', sql: `CREATE INDEX IF NOT EXISTS idx_customers_number    ON ${s}.customers ("מס.לקוח")` },
    // items
    { table: 'items',     sql: `CREATE INDEX IF NOT EXISTS idx_items_code          ON ${s}.items ("קוד פריט")` },
    { table: 'items',     sql: `CREATE INDEX IF NOT EXISTS idx_items_group         ON ${s}.items ("קבוצת פריט")` },
    // stores
    { table: 'stores',    sql: `CREATE INDEX IF NOT EXISTS idx_stores_number       ON ${s}.stores ("מס.חנות")` },
  ];
}

async function loadIndexesFromSchema(pool, schemaName) {
  const result = await pool.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = $1
      AND indexname NOT LIKE '%_pkey'
    ORDER BY tablename, indexname
  `, [schemaName]);

  return result.rows
    .filter(row => !MV_TABLES.has(row.tablename))
    .map(row => ({
      name: row.indexname,
      table: row.tablename,
      sql: null, // filled in createIndexes with target schema
      sourceDef: row.indexdef,
    }));
}

async function schemaExists(pool, schemaName) {
  const r = await pool.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schemaName]);
  return r.rows.length > 0;
}

async function createIndexes(schemaName = 'zer4u', emitLog = null) {
  const log = (msg) => {
    console.log(msg);
    if (emitLog) emitLog('creating_indexes', msg);
  };

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: MAX_PER_TABLE + 2,
  });

  console.log('='.repeat(70));
  console.log('ZER4U INDEX CREATION — dynamic from live schema, table-local parallel');
  console.log('='.repeat(70));

  const client = await pool.connect();
  const results = { created: 0, skipped: 0, failed: 0, errors: [] };
  const startTotal = Date.now();

  try {
    // 1. Create helper functions required by expression indexes
    await client.query(getSetupSQL(schemaName));

    // 2. Load index list — try target schema first, fallback to _old, then bootstrap
    let sourceSchema = schemaName;
    let indexes = await loadIndexesFromSchema(pool, schemaName);
    if (indexes.length === 0) {
      const oldSchema = `${schemaName}_old`;
      if (await schemaExists(pool, oldSchema)) {
        log(`No indexes in ${schemaName}, reading DDL from ${oldSchema}...`);
        sourceSchema = oldSchema;
        indexes = await loadIndexesFromSchema(pool, oldSchema);
      }
    }

    // 3. Build target DDL
    let targetIndexes;
    if (indexes.length === 0) {
      // Bootstrap: no reference schema — create key indexes from hardcoded list
      log(`No reference schema found — using bootstrap index list`);
      targetIndexes = getBootstrapIndexSQL(schemaName).map((entry, i) => ({
        name: `bootstrap_${i}`,
        table: entry.table,
        sql: entry.sql,
      }));
    } else {
      log(`Found ${indexes.length} indexes to create (source: ${sourceSchema})`);
      targetIndexes = indexes.map(idx => {
        const targetDef = idx.sourceDef
          .replace(new RegExp(`\\b${sourceSchema}\\.`, 'g'), `${schemaName}.`)
          .replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ')
          .replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
        return { ...idx, sql: targetDef };
      });
    }

    // 4. Group indexes by table
    const tableGroups = new Map();
    for (const idx of targetIndexes) {
      if (!tableGroups.has(idx.table)) tableGroups.set(idx.table, []);
      tableGroups.get(idx.table).push(idx);
    }

    const tableList = [...tableGroups.keys()];
    log(`Processing ${tableList.length} tables: ${tableList.join(', ')}`);

    let globalIdx = 0;

    const createOne = async (idx, displayIdx) => {
      const c = await pool.connect();
      const startTime = Date.now();
      try {
        // 1GB sort memory for the single active index build.
        // Sequential mode means no competition — full IOPS to one process.
        await c.query(`SET maintenance_work_mem = '1GB'`);
        await c.query(`SET max_parallel_maintenance_workers = 2`);
        log(`[${displayIdx}/${targetIndexes.length}] Building ${idx.name}...`);
        await c.query(idx.sql);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`[${displayIdx}/${targetIndexes.length}] ${idx.name} done — ${duration}s`);
        results.created++;
      } catch (err) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        if (err.message.includes('already exists')) {
          log(`[${displayIdx}/${targetIndexes.length}] ${idx.name} — already exists (${duration}s)`);
          results.skipped++;
        } else {
          log(`[${displayIdx}/${targetIndexes.length}] ${idx.name} FAILED — ${err.message}`);
          results.failed++;
          results.errors.push({ index: idx.name, error: err.message });
        }
      } finally {
        c.release();
      }
    };

    // 5. Process table by table: run all same-table indexes in parallel (capped at MAX_PER_TABLE)
    //    Same-table parallel builds share OS page cache — first build reads from disk,
    //    subsequent builds read from RAM. Big win for large tables (sales=5.6GB, etc.)
    for (const [table, tableIdxs] of tableGroups) {
      const tableStart = Date.now();
      log(`--- Table: ${table} (${tableIdxs.length} indexes) ---`);

      // ANALYZE so Postgres has fresh stats for parallel worker decisions
      await client.query(`ANALYZE ${schemaName}.${table}`);

      for (let i = 0; i < tableIdxs.length; i += MAX_PER_TABLE) {
        const batch = tableIdxs.slice(i, i + MAX_PER_TABLE);
        const batchIdxs = batch.map(() => ++globalIdx);
        await Promise.all(batch.map((idx, j) => createOne(idx, batchIdxs[j])));
      }

      const tableTime = ((Date.now() - tableStart) / 1000).toFixed(1);
      log(`--- Table ${table} done in ${tableTime}s ---`);
    }

    // 6. Summary
    const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
    console.log('\n' + '='.repeat(70));
    console.log('SUMMARY');
    console.log('='.repeat(70));
    console.log(`Created:  ${results.created}`);
    console.log(`Skipped:  ${results.skipped}`);
    console.log(`Failed:   ${results.failed}`);
    console.log(`Total:    ${totalTime}s`);

    if (results.errors.length > 0) {
      console.log('\nErrors:');
      results.errors.forEach(e => console.log(`  - ${e.index}: ${e.error}`));
    }

    console.log('\n' + '='.repeat(70));
    console.log('Index creation complete!');
    console.log('='.repeat(70));

  } catch (error) {
    console.error('\nFatal error:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { createIndexes };
