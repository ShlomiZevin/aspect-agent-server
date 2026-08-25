/**
 * "What data am I actually looking at?" — one answer, for the panel behind the
 * Last sync label.
 *
 * WHY THIS EXISTS. Users ask questions of a dataset whose shape they cannot
 * see. They do not know that inventory carries no dates, that sales stop on the
 * 17th, or that a file in the folder was retired months ago — so they ask
 * questions the data cannot answer and read the empty result as a fault. This
 * assembles what is already known into the smallest set of facts that makes the
 * scope legible before the question is typed.
 *
 * NO NEW STORAGE. Everything here is derived at read time from things that
 * already exist: the reload run history, the GCS listing, the reloader's own
 * file map, and the live catalog. Nothing is persisted, so nothing can go stale
 * or disagree with the loader.
 *
 * WHY THE FILE MAP MATTERS. Listing the GCS folder is NOT the same as listing
 * what was loaded — zolstock's folder still holds the 7.8GB `Facts_` export and
 * a 3.1GB inventory file that the four-file delivery retired. Showing those as
 * "your data" would be actively misleading, so a file is reported as processed
 * only when the reloader's own FILE_TO_TABLE claims it. Datasets that derive
 * their tables from filenames instead (zer4u) have no map, and there every CSV
 * in the folder genuinely is processed.
 */

const dataThrough = require('./data-through.service');

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // schema -> { at, value }

function bytes(n) {
  const size = Number(n);
  if (!size || Number.isNaN(size)) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = size;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Row count: the planner's estimate where it is trustworthy, an exact count where it is not. */
async function rowCount(pool, schema, relname) {
  try {
    const { rows } = await pool.query(
      `SELECT c.reltuples::bigint AS est
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, relname]
    );
    const est = Number(rows[0]?.est ?? -1);
    // reltuples is -1 before the first ANALYZE and drifts on small tables, so
    // anything under a million is counted exactly — it is cheap at that size
    // and these are the dimension tables users recognise by name.
    if (est >= 1_000_000) return { rows: est, exact: false };
    const { rows: c } = await pool.query(`SELECT count(*)::bigint AS n FROM ${schema}.${relname}`);
    return { rows: Number(c[0].n), exact: true };
  } catch {
    return { rows: null, exact: false };
  }
}

/**
 * @param {string} schemaName
 * @param {object} deps - { dataReloadService, pool }
 * @returns {Promise<{schema, lastSync, coverage, files, notes}>}
 */
async function getDataHealth(schemaName, { dataReloadService, pool, force = false } = {}) {
  const hit = cache.get(schemaName);
  if (!force && hit && (Date.now() - hit.at) < TTL_MS) return hit.value;

  const reloader = dataReloadService?.reloaders?.[schemaName];
  const dbPool = pool || reloader?.pool;
  if (!dbPool) throw Object.assign(new Error(`No pool for schema ${schemaName}`), { code: 404 });

  // ── last sync + overall coverage (both already computed elsewhere) ────────
  let lastSync = null, coverage = { from: null, through: null };
  try {
    const info = await dataReloadService.getDataInfo(schemaName);
    if (info?.lastRun) {
      lastSync = {
        at: info.lastRun.completed_at || null,
        status: info.lastRun.status || null,
        triggeredBy: info.lastRun.triggered_by || null,
        totalRows: info.lastRun.total_rows != null ? Number(info.lastRun.total_rows) : null,
      };
    }
    coverage = { from: info?.firstDataDate || null, through: info?.lastDataDate || null };
  } catch { /* the panel is still useful without it */ }

  // ── which delivered files are actually loaded ─────────────────────────────
  const fileMap = reloader?.fileMap || null;
  let gcsFiles = [];
  try {
    gcsFiles = await dataReloadService.getSourceFiles(schemaName);
  } catch { /* GCS may be unreachable; fall back to catalog-only */ }

  const processed = fileMap
    ? gcsFiles.filter(f => fileMap[f.basename])
    : gcsFiles;
  const ignored = fileMap
    ? gcsFiles.filter(f => !fileMap[f.basename]).map(f => f.basename)
    : [];

  const files = [];
  for (const f of processed) {
    const table = fileMap ? fileMap[f.basename] : null;
    const entry = {
      file: f.basename,
      table,
      size: bytes(f.size),
      updatedAt: f.updated || f.created || null,
      rows: null,
      exactRows: false,
      from: null,
      through: null,
      dateColumn: null,
    };
    if (table) {
      const [count, range] = await Promise.all([
        rowCount(dbPool, schemaName, table),
        dataThrough.rangeForRelation(dbPool, schemaName, table),
      ]);
      entry.rows = count.rows;
      entry.exactRows = count.exact;
      entry.from = range.first;
      entry.through = range.last;
      entry.dateColumn = range.dateColumn;
    }
    files.push(entry);
  }
  files.sort((a, b) => (b.rows || 0) - (a.rows || 0));

  // ── Stage 3: catalog-driven table inventory ──────────────────────────────
  // The `files` list above only covers tables mapped from a CURRENT source
  // file — derived tables, materialized views, and anything whose file was
  // renamed/retired drop out, which is exactly what made the panel read as
  // incomplete. This lists EVERY relation actually in the live schema, each
  // with the period it stores (or an explicit "snapshot" label when it has
  // no date column — an honest label beats a dash).
  const tables = [];
  try {
    const { rows: rels } = await dbPool.query(
      `SELECT table_name AS name, 'table' AS kind
         FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       UNION ALL
       SELECT matviewname AS name, 'view' AS kind
         FROM pg_matviews WHERE schemaname = $1
       ORDER BY 2, 1`, [schemaName]);
    for (const rel of rels) {
      const entry = { name: rel.name, kind: rel.kind, rows: null, from: null, through: null, dateless: false };
      try {
        const [count, range] = await Promise.all([
          rowCount(dbPool, schemaName, rel.name),
          dataThrough.rangeForRelation(dbPool, schemaName, rel.name),
        ]);
        entry.rows = count.rows;
        if (range?.first || range?.last) {
          entry.from = range.first;
          entry.through = range.last;
        } else {
          entry.dateless = true; // snapshot / dimension — no date column or all-NULL dates
        }
      } catch { entry.dateless = true; }
      tables.push(entry);
    }
  } catch { /* catalog listing is additive — the panel still works without it */ }

  // Last MV freshness assertion, when one has run since boot (Stage 3, item C).
  let freshness = null;
  try {
    freshness = require('./reload-freshness.service').lastResult(schemaName);
  } catch { /* absent = simply not shown */ }

  const value = {
    schema: schemaName,
    lastSync,
    coverage,
    files,
    tables,
    freshness,
    // Files sitting in the source folder that this dataset does NOT load.
    // Worth showing: zolstock's folder still holds the retired 7.8GB sales
    // export, and someone comparing folder contents to the panel would
    // otherwise conclude data had gone missing.
    // (Per-table date coverage is already carried on each row as from/through,
    // so a separate "no dates" list would just repeat it.)
    notes: { ignoredFiles: ignored },
  };
  cache.set(schemaName, { at: Date.now(), value });
  return value;
}

module.exports = { getDataHealth };
