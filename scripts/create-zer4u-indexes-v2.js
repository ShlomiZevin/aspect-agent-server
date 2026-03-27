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
`;
}

async function loadIndexesFromLiveSchema(pool) {
  const result = await pool.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = $1
      AND indexname NOT LIKE '%_pkey'
    ORDER BY tablename, indexname
  `, [SOURCE_SCHEMA]);

  return result.rows
    .filter(row => !MV_TABLES.has(row.tablename))
    .map(row => ({
      name: row.indexname,
      table: row.tablename,
      // Replace source schema with target schema in DDL
      sql: null, // filled in createIndexes with target schema
      sourceDef: row.indexdef,
    }));
}

async function createIndexes(schemaName = 'zer4u', emitLog = null) {
  const log = (msg) => {
    console.log(msg);
    if (emitLog) emitLog('creating_indexes', msg);
  };
  const CONCURRENCY = 4;

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: CONCURRENCY + 2,
  });

  console.log('═'.repeat(70));
  console.log('ZER4U INDEX CREATION — dynamic from live schema');
  console.log('═'.repeat(70));

  const client = await pool.connect();
  const results = { created: 0, skipped: 0, failed: 0, errors: [] };
  const startTotal = Date.now();

  try {
    // 1. Create helper functions required by expression indexes
    await client.query(getSetupSQL(schemaName));

    // 2. Load index list from live schema
    const indexes = await loadIndexesFromLiveSchema(pool);
    log(`Found ${indexes.length} indexes to create from live schema`);

    // 3. Build target DDL: replace source schema name with target schema name
    const targetIndexes = indexes.map(idx => {
      const targetDef = idx.sourceDef
        .replace(new RegExp(`\\b${SOURCE_SCHEMA}\\.`, 'g'), `${schemaName}.`)
        .replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ')
        .replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
      return { ...idx, sql: targetDef };
    });

    // 4. Create indexes in parallel batches
    const createOne = async (idx, i) => {
      const c = await pool.connect();
      const startTime = Date.now();
      try {
        await c.query(`SET maintenance_work_mem = '1GB'`);
        await c.query(idx.sql);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`[${i + 1}/${targetIndexes.length}] ${idx.table}.${idx.name} — ${duration}s`);
        results.created++;
      } catch (err) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        if (err.message.includes('already exists')) {
          log(`[${i + 1}/${targetIndexes.length}] ${idx.name} — already exists (${duration}s)`);
          results.skipped++;
        } else {
          log(`[${i + 1}/${targetIndexes.length}] ${idx.name} FAILED — ${err.message}`);
          results.failed++;
          results.errors.push({ index: idx.name, error: err.message });
        }
      } finally {
        c.release();
      }
    };

    for (let i = 0; i < targetIndexes.length; i += CONCURRENCY) {
      const batch = targetIndexes.slice(i, i + CONCURRENCY).map((idx, j) => createOne(idx, i + j));
      await Promise.all(batch);
    }

    // 5. Summary
    const totalTime = ((Date.now() - startTotal) / 1000).toFixed(1);
    console.log('\n' + '═'.repeat(70));
    console.log('📊 SUMMARY');
    console.log('═'.repeat(70));
    console.log(`✅ Created:  ${results.created}`);
    console.log(`⏭️  Skipped:  ${results.skipped}`);
    console.log(`❌ Failed:   ${results.failed}`);
    console.log(`⏱️  Total:    ${totalTime}s`);

    if (results.errors.length > 0) {
      console.log('\n⚠️  Errors:');
      results.errors.forEach(e => console.log(`   - ${e.index}: ${e.error}`));
    }

    console.log('\n═'.repeat(70));
    console.log('✅ Index creation complete!');
    console.log('═'.repeat(70));

  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { createIndexes };
