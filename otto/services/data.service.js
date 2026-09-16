/**
 * Executes a screen's compiled queries and caches the payload.
 *
 * THE ONLY DATA PATH A SCREEN HAS. The browser asks for a screen's data by
 * id; this service compiles the STORED spec (never anything from the
 * request), executes under a transaction-scoped statement_timeout on the
 * dataset's pool, and caches the payload keyed by the last completed import
 * — so a screen opened two hundred times costs one query run per nightly
 * reload, which is the ZolStock-30M-rows answer in operational form.
 *
 * KPI values are SQL-computed over the FULL filtered set, never over the
 * LIMITed rows a table shows — a truncated result set must not quietly
 * shrink a headline number.
 */

const { compileSpec } = require('./compiler.service');

const QUERY_TIMEOUT_MS = 15000;   // the chat default — a user is waiting
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // backstop when no reload stamp moves

/** cacheKey -> { payload, computedAt, reloadStamp } */
const cache = new Map();

/** When the dataset's data last changed — the cache invalidation signal and
 *  the "Data updated" stamp the client already shows. */
async function lastReloadStamp(datasetId) {
  try {
    const db = require('../../services/db.pg');
    const { rows } = await db.query(
      `SELECT completed_at FROM public.data_reload_runs
        WHERE schema_name = $1 AND status = 'completed' AND total_files IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1`,
      [datasetId]);
    return rows[0]?.completed_at ? new Date(rows[0].completed_at).toISOString() : null;
  } catch {
    return null;
  }
}

/** Label/type/format for one output column, resolved from the brief field,
 *  the computed column or the aggregate measure that defines it. */
function columnMeta(colId, rs, brief) {
  const field = brief.fields.find(f => f.id === colId && f.sourceId === rs.source);
  if (field) return { id: colId, label: field.label, type: field.type, format: field.format || 'text' };
  const computed = (rs.computed || []).find(c => c.id === colId);
  if (computed) return { id: colId, label: computed.label, type: 'number', format: computed.format || 'decimal' };
  const measure = rs.aggregate?.measures.find(m => m.id === colId);
  if (measure) return { id: colId, label: measure.label, type: 'number', format: measure.format || 'decimal' };
  return { id: colId, label: { en: colId, he: colId }, type: 'text', format: 'text' };
}

async function runWithTimeout(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const res = await client.query(sql);
    await client.query('COMMIT');
    return res.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a spec fresh — the build pipeline and cache misses both land here.
 * @returns {{resultSets, kpis, dataThrough, computedAt}}
 */
async function executeSpec(spec, brief, { pool, schemaName, datasetId }) {
  const compiled = compileSpec(spec, brief, schemaName);

  const resultSets = {};
  for (const [id, c] of Object.entries(compiled.resultSets)) {
    const rs = spec.resultSets.find(r => r.id === id);
    const rows = await runWithTimeout(pool, c.sql);
    resultSets[id] = {
      // The client has no brief, so every column travels with its own
      // bilingual label, type and format — the renderer needs nothing else.
      columns: c.columns.map(colId => columnMeta(colId, rs, brief)),
      rows,
      total: rows.length,
      truncated: rows.length >= c.limit,
    };
  }

  const kpis = {};
  for (const k of compiled.kpis) {
    const rows = await runWithTimeout(pool, k.sql);
    const v = rows[0]?.value;
    kpis[k.cardId] = v === null || v === undefined ? null : Number(v);
  }

  return {
    resultSets,
    kpis,
    // Quoted from the brief so the noteLine block renders the manifest's own
    // wording — the screen, the chat and the report must not phrase one
    // caveat three different ways.
    caveats: brief.caveats || [],
    dataThrough: await lastReloadStamp(datasetId),
    computedAt: new Date().toISOString(),
  };
}

/**
 * The serving path: cache per (dataset, screen), invalidated when a newer
 * completed import exists or the TTL backstop expires. A cold miss computes
 * under the same caps — slower for one user, safe for the DB.
 */
async function getScreenData(screen, brief, ctx) {
  const key = `${ctx.datasetId}:${screen.id}`;
  const reloadStamp = await lastReloadStamp(ctx.datasetId);
  const hit = cache.get(key);
  if (hit
      && hit.reloadStamp === reloadStamp
      && Date.now() - Date.parse(hit.payload.computedAt) < CACHE_TTL_MS) {
    return hit.payload;
  }
  const payload = await executeSpec(screen.screenSpec, brief, ctx);
  cache.set(key, { payload, reloadStamp });
  return payload;
}

/** Drop a screen's cache entry — called when a build stores a new spec. */
function invalidate(datasetId, screenId) {
  cache.delete(`${datasetId}:${screenId}`);
}

module.exports = { executeSpec, getScreenData, invalidate, lastReloadStamp, QUERY_TIMEOUT_MS };
