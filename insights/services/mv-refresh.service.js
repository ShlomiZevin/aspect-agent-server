/**
 * Materialized-view freshness: detection and refresh.
 *
 * THE GAP THIS CLOSES. `REFRESH MATERIALIZED VIEW` existed in exactly one place
 * — scripts/lib/mv-builder.js, invoked by hand via scripts/create-<ds>-mvs.js.
 * Nothing in the reload pipeline refreshed anything. Views were current only
 * because a person remembered to run the script after a load. Meanwhile the SQL
 * rules deliberately route most aggregate questions through those views
 * ("PREFER these for aggregations"), so a data reload without that manual step
 * makes every aggregate answer silently report the previous load's business as
 * current. That is the worst failure shape we have: confident, plausible, and
 * wrong — and it applied to every dataset, not one client.
 *
 * DETECTION IS THE POINT, NOT JUST REFRESHING. Refreshing on a schedule still
 * fails silently if the refresh itself errors. So freshness is measured
 * directly — each view's own MAX(date) against the fact table's — and that
 * verdict is available to callers who want to refuse, or caveat, an answer
 * built on a stale view.
 *
 * Generic by construction: views are discovered from pg_matviews and the fact
 * table from the registry, so a newly added dataset or view is covered with no
 * code change. A view without a usable date column is reported as `unknown`
 * rather than guessed at.
 */

const registry = require('../datasets/registry');

// The fact-table map and date-column list are shared with the chat path via
// services/data-through.service.js — one definition, so a new dataset is
// registered in exactly one place.
const { KNOWN_FACT_TABLES, DATE_COLUMNS, pickDateColumn } = require('../../services/data-through.service');

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // datasetId -> { at, value }
const running = new Set();
const lastChecked = new Map(); // datasetId -> epoch ms of the last staleness probe
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

async function columnsOf(pool, schema, relname) {
  const { rows } = await pool.query(
    `SELECT a.attname FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
    [schema, relname]
  );
  return rows.map(r => r.attname);
}

/**
 * The newest source date a given view SHOULD contain. Reads the view's own
 * definition and reuses its `record_type = '...'` predicate (if any) so the
 * comparison is like-for-like. Without this, a wide fact table holding several
 * record kinds with different date ranges makes every narrow view look stale.
 */
async function baselineFor(pool, schema, matviewname, factTable, factDateCol, unfilteredMax) {
  if (!factTable || !factDateCol) return null;
  try {
    const { rows } = await pool.query('SELECT pg_get_viewdef($1::regclass, true) AS def', [`${schema}.${matviewname}`]);
    const def = rows[0]?.def || '';
    const m = /record_type\s*=\s*'([^']+)'/i.exec(def);
    if (!m) return unfilteredMax;
    const { rows: r2 } = await pool.query(
      `SELECT MAX("${factDateCol}")::text AS m FROM ${schema}.${factTable}
        WHERE record_type = $1 AND "${factDateCol}" <= CURRENT_DATE`,
      [m[1]]
    );
    return r2[0]?.m || unfilteredMax;
  } catch {
    return unfilteredMax;
  }
}

/**
 * @returns {Promise<{schema, factTable, factMax, views: Array<{name, dateColumn, mvMax, stale, reason}>}|null>}
 */
async function getFreshness(datasetId, { force = false } = {}) {
  const hit = cache.get(datasetId);
  if (!force && hit && (Date.now() - hit.at) < TTL_MS) return hit.value;

  const entry = registry.get(datasetId);
  if (!entry) return null;
  const pool = entry.getPool();
  const schema = entry.schemaName;

  try {
    const { rows: mvRows } = await pool.query(
      'SELECT matviewname FROM pg_matviews WHERE schemaname = $1 ORDER BY matviewname',
      [schema]
    );
    if (mvRows.length === 0) {
      const value = { schema, factTable: null, factMax: null, views: [] };
      cache.set(datasetId, { at: Date.now(), value });
      return value;
    }

    const factTable = KNOWN_FACT_TABLES[schema] || null;
    let factMax = null;
    let factDateCol = null;
    if (factTable) {
      factDateCol = pickDateColumn(await columnsOf(pool, schema, factTable));
      if (factDateCol) {
        // The fact table is large; MAX on an indexed date column is a cheap
        // backward index scan, not a sequential scan.
        //
        // Future dates are excluded deliberately. zolstock's wholesale rows
        // carry dates up to 2026-12-06 — months ahead of today — so a bare
        // MAX() reported the data as ending in December and flagged every
        // view as stale when sales genuinely end 2026-06-04. A baseline that
        // trusts junk dates would trigger a full refresh of an 868 MB view on
        // every tick, forever.
        const { rows } = await pool.query(
          `SELECT MAX("${factDateCol}")::text AS m FROM ${schema}.${factTable} WHERE "${factDateCol}" <= CURRENT_DATE`
        );
        factMax = rows[0]?.m || null;
      }
    }

    const views = [];
    for (const { matviewname } of mvRows) {
      const dateColumn = pickDateColumn(await columnsOf(pool, schema, matviewname));
      if (!dateColumn || !factMax) {
        views.push({ name: matviewname, dateColumn, mvMax: null, stale: null, reason: dateColumn ? 'no fact baseline' : 'no date column' });
        continue;
      }
      const { rows } = await pool.query(`SELECT MAX("${dateColumn}")::text AS m FROM ${schema}.${matviewname}`);
      const mvMax = rows[0]?.m || null;

      // The baseline must cover the SAME rows the view does. zolstock's views
      // aggregate sales only, while the fact table also holds wholesale rows
      // that run two months later — comparing against the unfiltered table
      // reported every view as permanently stale and would have rebuilt an
      // 868 MB view on every tick forever. So the view's own record_type
      // predicate is read from its definition and applied to the baseline.
      const baseline = await baselineFor(pool, schema, matviewname, factTable, factDateCol, factMax);
      const stale = mvMax !== null && baseline !== null ? mvMax < baseline : null;
      views.push({
        name: matviewname, dateColumn, mvMax, baseline, stale,
        reason: stale ? `view ends ${mvMax}, its source data ends ${baseline}` : null,
      });
    }

    const value = { schema, factTable, factMax, views };
    cache.set(datasetId, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`⚠️  MV freshness check failed for ${datasetId}: ${err.message}`);
    return null;
  }
}

/** @returns {Promise<string[]>} names of views that are provably behind the fact table. */
async function listStale(datasetId) {
  const f = await getFreshness(datasetId, { force: true });
  return f ? f.views.filter(v => v.stale === true).map(v => v.name) : [];
}

/**
 * Refreshes the named views (or every stale one). CONCURRENTLY is used where a
 * UNIQUE index exists, because a plain REFRESH takes ACCESS EXCLUSIVE and
 * blocks every read of that view for its whole duration — with the rules
 * routing most aggregates through views, that is a partial outage rather than
 * a slow moment.
 */
async function refresh(datasetId, { views = null, log = console.log } = {}) {
  const entry = registry.get(datasetId);
  if (!entry) return { refreshed: [], failed: [] };
  if (running.has(datasetId)) return { refreshed: [], failed: [], skipped: 'already running' };

  const pool = entry.getPool();
  const schema = entry.schemaName;
  const targets = views || await listStale(datasetId);
  if (targets.length === 0) return { refreshed: [], failed: [] };

  running.add(datasetId);
  const refreshed = [], failed = [];
  try {
    for (const name of targets) {
      const { rows: uniq } = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexdef ILIKE 'CREATE UNIQUE%' LIMIT 1`,
        [schema, name]
      );
      const concurrently = uniq.length > 0;
      const t0 = Date.now();
      try {
        await pool.query(`REFRESH MATERIALIZED VIEW ${concurrently ? 'CONCURRENTLY ' : ''}${schema}.${name}`);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log(`[mv-refresh] ${schema}.${name} refreshed in ${secs}s${concurrently ? ' (concurrently)' : ''}`);
        refreshed.push({ name, seconds: +secs, concurrently });
      } catch (err) {
        log(`[mv-refresh] ${schema}.${name} FAILED: ${err.message}`);
        failed.push({ name, error: err.message });
      }
    }
  } finally {
    running.delete(datasetId);
    cache.delete(datasetId);
  }
  return { refreshed, failed };
}

/**
 * Tick-callable: refresh only what is provably stale, and only when something
 * is. Same self-checking shape as DataReloadService.ensureIndexed — safe to
 * call every minute, because it costs one MAX() per view when there is nothing
 * to do. Deliberately NOT clock-scheduled: a view must be rebuilt after its
 * load finishes, whenever that happens, not at a fixed hour.
 */
async function ensureMVsRefreshed(datasetId, { log = console.log } = {}) {
  // Throttled rather than probed every tick. The probe is cheap per view, but
  // "cheap" times six schemas times every minute of every day is a standing
  // background cost for a condition that can only change when a load lands.
  const last = lastChecked.get(datasetId) || 0;
  if (Date.now() - last < CHECK_INTERVAL_MS) return { action: 'skipped', reason: 'checked recently' };
  lastChecked.set(datasetId, Date.now());

  const stale = await listStale(datasetId);
  if (stale.length === 0) return { action: 'skipped', reason: 'all views current' };
  log(`[mv-refresh] ${datasetId}: ${stale.length} stale view(s) — ${stale.join(', ')}`);
  const result = await refresh(datasetId, { views: stale, log });
  return { action: 'refreshed', ...result };
}

module.exports = { getFreshness, listStale, refresh, ensureMVsRefreshed, KNOWN_FACT_TABLES };
