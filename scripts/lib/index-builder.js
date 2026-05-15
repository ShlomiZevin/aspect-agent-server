/**
 * Shared index-builder for agent schemas (thestock, hypertoy, newdeli).
 *
 * Why this exists:
 *   - `CREATE INDEX IF NOT EXISTS` checks only the name, not validity. A prior
 *     cancelled build can leave an entry in pg_class with `indisvalid=false`;
 *     IF NOT EXISTS then silently skips and the planner never uses the "index".
 *   - We need idempotent, observable, restartable indexing on big tables.
 *
 * What this does, per index:
 *   1. Look up pg_index.indisvalid / indisready for `schema.name`.
 *   2. If a row exists AND both flags are true → SKIP (real, usable index).
 *   3. If a row exists but flags are false → DROP and rebuild (recover stale).
 *   4. If no row exists → build from scratch.
 *   5. Heartbeat to the logger every 30s while CREATE INDEX runs.
 *   6. Per-index dedicated connection — one failure can't poison the others.
 *
 * Index definitions:
 *   { name, table, col, include? }
 *   - col: raw column list, already quoted as needed
 *   - include: optional INCLUDE list for covering indexes (PG 11+)
 *
 * Tuning:
 *   No SET maintenance_work_mem / max_parallel_maintenance_workers. On
 *   shared-CPU tiers like db-g1-small, those overrides hurt — defaults are
 *   already tuned to the instance.
 */

const HEARTBEAT_MS = 30000;

async function ensureIndex({ pool, schema, idx, displayIdx, total, statementTimeoutMs, log }) {
  const client = await pool.connect();
  const startTime = Date.now();
  let heartbeat = null;

  try {
    await client.query(`SET statement_timeout = ${statementTimeoutMs}`);

    // Step 1: is the index already present? Check validity.
    const existing = await client.query(
      `SELECT i.indisvalid, i.indisready
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_index   i ON i.indexrelid = c.oid
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, idx.name]
    );

    if (existing.rows.length > 0) {
      const { indisvalid, indisready } = existing.rows[0];
      if (indisvalid && indisready) {
        log(`  [${displayIdx}/${total}] SKIP ${idx.name} (already valid)`);
        return 'skipped';
      }
      // Stale entry from a cancelled prior build — drop and recreate.
      log(`  [${displayIdx}/${total}] ${idx.name} exists but INVALID — dropping...`);
      await client.query(`DROP INDEX IF EXISTS ${schema}.${idx.name}`);
    }

    // Step 2: build the index.
    const includeClause = idx.include ? ` INCLUDE (${idx.include})` : '';
    const includeMsg    = idx.include ? ` INCLUDE (${idx.include})` : '';
    const sql = `CREATE INDEX ${idx.name} ON ${schema}.${idx.table} (${idx.col})${includeClause}`;
    log(`  [${displayIdx}/${total}] BUILD ${idx.name} ON ${idx.table} (${idx.col})${includeMsg}...`);

    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`    ${idx.name} still building... (${elapsed}s elapsed)`);
    }, HEARTBEAT_MS);

    await client.query(sql);
    clearInterval(heartbeat);
    log(`  [${displayIdx}/${total}] DONE ${idx.name} (${Date.now() - startTime}ms)`);
    return 'built';
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    log(`  [${displayIdx}/${total}] FAILED ${idx.name}: ${err.message}`);
    return 'failed';
  } finally {
    client.release();
  }
}

/**
 * Create all indexes in the list. Each index runs on its own connection
 * sequentially (one at a time, but isolated from neighbours).
 *
 * Returns { built, skipped, failed, invalid } counts.
 * Throws if any index ended up INVALID after the run.
 */
async function createIndexesForSchema({ pool, schema, indexes, statementTimeoutMs, log }) {
  const total = indexes.length;
  let built = 0, skipped = 0, failed = 0;

  log(`Building ${total} indexes on ${schema} (timeout per index: ${Math.round(statementTimeoutMs / 60000)}min)`);

  for (let i = 0; i < total; i++) {
    const result = await ensureIndex({
      pool, schema, idx: indexes[i], displayIdx: i + 1, total, statementTimeoutMs, log,
    });
    if (result === 'built') built++;
    else if (result === 'skipped') skipped++;
    else failed++;
  }

  // Final validation: every index must be indisvalid AND indisready.
  const names = indexes.map(i => i.name);
  const client = await pool.connect();
  let invalid = 0;
  try {
    const res = await client.query(
      `SELECT c.relname, i.indisvalid, i.indisready
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_index   i ON i.indexrelid = c.oid
        WHERE n.nspname = $1 AND c.relname = ANY($2)`,
      [schema, names]
    );
    const byName = new Map(res.rows.map(r => [r.relname, r]));
    for (const name of names) {
      const row = byName.get(name);
      if (!row || !row.indisvalid || !row.indisready) {
        invalid++;
        log(`  WARN ${name}: missing or INVALID after run`);
      }
    }
  } finally {
    client.release();
  }

  log(`Index summary: ${built} built, ${skipped} skipped (already valid), ${failed} failed, ${invalid} invalid after run`);

  if (invalid > 0) {
    throw new Error(`${invalid} index(es) are missing or INVALID after the run — see log for names`);
  }

  return { built, skipped, failed, invalid };
}

module.exports = { createIndexesForSchema };
