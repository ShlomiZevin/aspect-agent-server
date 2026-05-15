/**
 * Shared materialized-view builder for agent schemas.
 *
 * Why:
 *   - On small DB tiers (db-g1-small, ~1.7GB RAM, ~0.6 shared vCPU), aggregating
 *     over multi-million-row fact tables for every chat question is too slow
 *     even with covering indexes.
 *   - Pre-computed MVs reduce 5–40M row scans to thousands of row reads.
 *
 * What this does, per MV:
 *   1. Look it up in pg_matviews.
 *   2. If absent → CREATE MATERIALIZED VIEW (which builds it from the SELECT).
 *   3. If present but POPULATED=false → DROP + recreate (stale from a crash).
 *   4. If present and populated → REFRESH MATERIALIZED VIEW.
 *   5. Heartbeat every 30s during long builds/refreshes.
 *   6. Per-MV dedicated connection.
 *
 * MV definitions:
 *   { name, sql, indexes? }
 *   - sql: the full body `SELECT ...` (no `CREATE MATERIALIZED VIEW ... AS`)
 *   - indexes: array of { name, col } to create on the MV after build
 *     (a normal btree index on key columns makes MV reads fast)
 */

const HEARTBEAT_MS = 30000;

async function ensureMV({ pool, schema, mv, displayIdx, total, statementTimeoutMs, log }) {
  const client = await pool.connect();
  const startTime = Date.now();
  let heartbeat = null;

  try {
    await client.query(`SET statement_timeout = ${statementTimeoutMs}`);

    // Step 1: always DROP + CREATE. REFRESH would be cheaper-in-theory but it
    // can't handle schema changes (added/renamed columns) — and in our reload
    // flow we re-aggregate from scratch every time anyway, so REFRESH and
    // CREATE cost the same. DROP+CREATE is also robust against stale partial
    // entries from a cancelled prior run.
    const fqName = `${schema}.${mv.name}`;
    const action = 'CREATE';
    await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${fqName} CASCADE`);

    log(`  [${displayIdx}/${total}] ${action} ${mv.name}...`);

    const gerund = action === 'CREATE' ? 'creating' : 'refreshing';
    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`    ${mv.name} still ${gerund}... (${elapsed}s elapsed)`);
    }, HEARTBEAT_MS);

    if (action === 'CREATE') {
      await client.query(`CREATE MATERIALIZED VIEW ${fqName} AS ${mv.sql}`);
      // Index the MV (helps subsequent reads filter without a full MV scan).
      if (mv.indexes && mv.indexes.length > 0) {
        clearInterval(heartbeat);
        heartbeat = null;
        for (const idx of mv.indexes) {
          const idxStart = Date.now();
          log(`    indexing ${mv.name}.${idx.name}...`);
          await client.query(
            `CREATE INDEX ${idx.name} ON ${fqName} (${idx.col})`
          );
          log(`    indexed ${mv.name}.${idx.name} (${Date.now() - idxStart}ms)`);
        }
      }
    } else {
      // REFRESH. CONCURRENTLY would avoid locks but needs a UNIQUE index on
      // the MV — we don't add one (no natural PK on all MVs). Plain REFRESH
      // locks the MV briefly; on a small read load that's fine.
      await client.query(`REFRESH MATERIALIZED VIEW ${fqName}`);
    }

    if (heartbeat) clearInterval(heartbeat);
    log(`  [${displayIdx}/${total}] DONE ${mv.name} (${Date.now() - startTime}ms)`);
    return action === 'CREATE' ? 'created' : 'refreshed';
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    log(`  [${displayIdx}/${total}] FAILED ${mv.name}: ${err.message}`);
    return 'failed';
  } finally {
    client.release();
  }
}

/**
 * Build or refresh all MVs in the list. Sequential (one MV at a time).
 *
 * Returns { created, refreshed, failed } counts.
 * Throws if any MV is missing or unpopulated after the run.
 */
async function createMVsForSchema({ pool, schema, mvs, statementTimeoutMs, log }) {
  const total = mvs.length;
  let created = 0, refreshed = 0, failed = 0;

  log(`Building ${total} materialized views on ${schema} (timeout per MV: ${Math.round(statementTimeoutMs / 60000)}min)`);

  for (let i = 0; i < total; i++) {
    const result = await ensureMV({
      pool, schema, mv: mvs[i], displayIdx: i + 1, total, statementTimeoutMs, log,
    });
    if (result === 'created') created++;
    else if (result === 'refreshed') refreshed++;
    else failed++;
  }

  // Validation: every MV must be present and populated.
  const names = mvs.map(m => m.name);
  const client = await pool.connect();
  let invalid = 0;
  try {
    const res = await client.query(
      `SELECT matviewname, ispopulated
         FROM pg_matviews
        WHERE schemaname = $1 AND matviewname = ANY($2)`,
      [schema, names]
    );
    const byName = new Map(res.rows.map(r => [r.matviewname, r]));
    for (const name of names) {
      const row = byName.get(name);
      if (!row || !row.ispopulated) {
        invalid++;
        log(`  WARN ${name}: missing or unpopulated after run`);
      }
    }
  } finally {
    client.release();
  }

  log(`MV summary: ${created} created, ${refreshed} refreshed, ${failed} failed, ${invalid} invalid after run`);

  if (invalid > 0) {
    throw new Error(`${invalid} MV(s) are missing or unpopulated after the run — see log for names`);
  }

  return { created, refreshed, failed, invalid };
}

module.exports = { createMVsForSchema };
