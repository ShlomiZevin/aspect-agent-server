require('dotenv').config();

/**
 * 050 — tevanaot.mv_sales covering index (immediate, no reload needed).
 *
 * WHY
 *   tevanaot chat is slow on any breakdown question (top models, by colour /
 *   gender / season / family, top stores). Measured on the 2026-09-03 chat
 *   regression run: pure totals off mv_sales_daily land in 4-7s, but every
 *   question that aggregates the line-level mv_sales (~2.65M rows) and joins
 *   mv_parts_dim took 9-33s, and several tripped the uniform 15s chat timeout
 *   and had to be retried.
 *
 *   The generated SQL for all of them has one shape:
 *
 *     WITH agg AS (
 *       SELECT part, SUM(qty_sold), SUM(sales_ex_vat) ...
 *       FROM tevanaot.mv_sales
 *       WHERE transaction_date >= ... AND transaction_date < ...
 *       GROUP BY part
 *     )
 *     SELECT ... FROM agg JOIN tevanaot.mv_parts_dim d ON d.part = agg.part ...
 *
 *   With only idx_mv_sales_date, that is an index range-scan on the date bound
 *   followed by a random heap fetch of ~0.5-1M rows to read the measures —
 *   which on db-g1-small (1 shared vCPU, 1.7GB RAM) is where the 20-33s goes.
 *
 * WHAT
 *   A covering index:
 *     (transaction_date, part) INCLUDE (qty_sold, sales_ex_vat, sales_inc_vat)
 *   turns the aggregate into an index-only scan (mv_sales is a freshly-built
 *   MV, so its pages are all-visible and index-only scans actually apply). It
 *   is purely additive — no query, rule, timeout or schema-logic change — and
 *   the same definition is now in create-tevanaot-mvs.js so the nightly reload
 *   keeps it. This script only builds it on the LIVE schema now, CONCURRENTLY,
 *   so we don't wait for tonight's reload.
 *
 * RUN (needs the Cloud SQL proxy on 5433 — ..\start-proxy.ps1 at repo root):
 *   node db/migrations/run-050-tevanaot-mv-sales-covering-index.js            # dry run
 *   node db/migrations/run-050-tevanaot-mv-sales-covering-index.js --apply    # build it
 */

const { getPool, endPool } = require('../../services/db.zer4u');

const SCHEMA = 'tevanaot';
const TABLE = 'mv_sales';
const INDEX = 'idx_mv_sales_date_part_cov';
const DEF = `(transaction_date, part) INCLUDE (qty_sold, sales_ex_vat, sales_inc_vat)`;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

async function run() {
  const apply = process.argv.includes('--apply');
  const pool = getPool();
  const client = await pool.connect();

  try {
    // Sanity: schema, table and every referenced column must exist.
    const cols = await client.query(
      `SELECT a.attname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
      [SCHEMA, TABLE]
    );
    if (cols.rows.length === 0) {
      throw new Error(`${SCHEMA}.${TABLE} not found — is the proxy pointed at aspect-data-db (5433)?`);
    }
    const have = new Set(cols.rows.map(r => r.attname));
    const need = ['transaction_date', 'part', 'qty_sold', 'sales_ex_vat', 'sales_inc_vat'];
    const missing = need.filter(c => !have.has(c));
    if (missing.length) throw new Error(`${SCHEMA}.${TABLE} is missing column(s): ${missing.join(', ')}`);

    // Current state of the index.
    const existing = await client.query(
      `SELECT i.indisvalid, i.indisready, pg_relation_size(c.oid) AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE n.nspname = $1 AND c.relname = $2`,
      [SCHEMA, INDEX]
    );

    if (existing.rows.length && existing.rows[0].indisvalid && existing.rows[0].indisready) {
      const mb = (Number(existing.rows[0].bytes) / 1048576).toFixed(1);
      console.log(`${SCHEMA}.${INDEX} already exists and is valid (${mb} MB). Nothing to do.`);
      return;
    }

    const stale = existing.rows.length > 0; // present but not valid/ready
    console.log(`Plan for ${SCHEMA}.${TABLE}:`);
    if (stale) console.log(`  1. DROP INDEX ${SCHEMA}.${INDEX}   (exists but INVALID — leftover from a cancelled build)`);
    console.log(`  ${stale ? 2 : 1}. CREATE INDEX CONCURRENTLY ${INDEX} ON ${SCHEMA}.${TABLE} ${DEF}`);
    console.log(`     ~2.65M rows, expect a few minutes on db-g1-small; CONCURRENTLY takes no blocking lock.`);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to build it.');
      return;
    }

    await client.query(`SET statement_timeout = ${BUILD_TIMEOUT_MS}`);
    await client.query(`SET lock_timeout = '10s'`);

    if (stale) {
      console.log(`\nDropping stale ${SCHEMA}.${INDEX}...`);
      await client.query(`DROP INDEX IF EXISTS ${SCHEMA}.${INDEX}`);
    }

    console.log(`\nBuilding ${SCHEMA}.${INDEX} (CONCURRENTLY)...`);
    const t0 = Date.now();
    const beat = setInterval(() => {
      console.log(`  still building... (${Math.round((Date.now() - t0) / 1000)}s)`);
    }, 30000);
    try {
      // CREATE INDEX CONCURRENTLY cannot run inside a transaction block — this is
      // a single autocommit statement on a dedicated client, so it is fine.
      await client.query(`CREATE INDEX CONCURRENTLY ${INDEX} ON ${SCHEMA}.${TABLE} ${DEF}`);
    } finally {
      clearInterval(beat);
    }

    const check = await client.query(
      `SELECT i.indisvalid, i.indisready, pg_relation_size(c.oid) AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE n.nspname = $1 AND c.relname = $2`,
      [SCHEMA, INDEX]
    );
    const row = check.rows[0];
    if (!row || !row.indisvalid || !row.indisready) {
      throw new Error(`index built but is not valid/ready — re-run with --apply to drop and retry`);
    }
    const mb = (Number(row.bytes) / 1048576).toFixed(1);
    console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s — ${SCHEMA}.${INDEX} is valid (${mb} MB).`);
    console.log(`Nightly reload will keep it (create-tevanaot-mvs.js). No deploy needed.`);
  } finally {
    client.release();
    await endPool();
  }
}

run().catch(err => { console.error('\nFAILED:', err.message); process.exit(1); });
