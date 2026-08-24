/**
 * HQ — integration sync.
 *
 * Two deliberately separate phases:
 *
 *   DISCOVER  list every remote object. Fast, free, no content fetched.
 *             Produces the inventory a human picks from.
 *   SYNC      fetch + chunk + embed only what was picked, one at a time,
 *             reporting progress and stoppable at any point.
 *
 * Splitting them is the whole point: listing 800 Notion pages takes seconds,
 * but pulling their content is ~35-50 minutes of rate-limited fetching. Nobody
 * should start that blind, and nobody should be unable to stop it.
 *
 * NOTE: syncing runs **no LLM at all** — fetch, chunk, embed, store. Embeddings
 * for the whole workspace cost a few cents. The Scribe is opt-in per meeting and
 * is never invoked from here.
 */

const db = require('../../services/db.pg');
const atomsService = require('./atoms.service');
const ingest = require('./ingest.service');

// Runs live in-process; this lets a cancel request reach a running loop.
// A restart loses the registry, which is why `reclaimStaleRuns` exists.
const active = new Map(); // runId -> { cancelled: boolean }

// ─── Runs ────────────────────────────────────────────────────────────────────

async function createRun(sourceId, kind, total = 0, { trigger = 'manual', label = null, itemIds = null } = {}) {
  const { rows } = await db.query(
    `INSERT INTO hq_sync_runs (source_id, kind, total, trigger, label, item_ids)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [sourceId, kind, total, trigger, label, itemIds]
  );
  active.set(rows[0].id, { cancelled: false });
  return rows[0];
}

async function updateRun(runId, patch) {
  const sets = [];
  const params = [runId];
  for (const [key, col] of Object.entries({
    status: 'status', total: 'total', processed: 'processed', succeeded: 'succeeded',
    failed: 'failed', skipped: 'skipped', currentTitle: 'current_title', error: 'error',
  })) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${col} = $${params.length}`);
  }
  if (patch.finished) sets.push(`finished_at = NOW()`);
  if (!sets.length) return;
  await db.query(`UPDATE hq_sync_runs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
}

function cancelRun(runId) {
  const handle = active.get(Number(runId));
  if (!handle) return false;
  handle.cancelled = true;
  return true;
}

function isCancelled(runId) {
  return active.get(Number(runId))?.cancelled === true;
}

/**
 * A run only lives in memory, so a server restart mid-sync leaves a row stuck at
 * `running` forever and the UI spins. Same lesson as the Scribe: anything
 * fire-and-forget needs a way to notice it died.
 */
// This is a janitor for runs orphaned by a restart, and it is called from
// every `listRuns`. The UI polls that endpoint, so it was firing an UPDATE
// every few seconds per open tab — writes and pool pressure forever, for a
// sweep that only matters after a crash. Once a minute per process is plenty.
let lastSweep = 0;
const SWEEP_EVERY_MS = 60_000;

async function reclaimStaleRuns(staleMinutes = 10, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_EVERY_MS) return [];
  lastSweep = now;

  const { rows } = await db.query(
    `UPDATE hq_sync_runs
        SET status = 'failed',
            error = COALESCE(error, 'Interrupted — the server restarted mid-run.'),
            finished_at = NOW(), updated_at = NOW()
      WHERE status = 'running'
        AND updated_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(staleMinutes)]
  );
  // Any item left mid-flight goes back to pending so it can simply be re-run.
  if (rows.length) {
    await db.query(`UPDATE hq_sync_items SET status='pending', updated_at=NOW() WHERE status='syncing'`);
    console.log(`[hq] reclaimed ${rows.length} stalled sync run(s)`);
  }
  return rows.map(r => r.id);
}

// ─── Discover ────────────────────────────────────────────────────────────────

/**
 * Inventory everything a source can see. Cheap: metadata only, no content.
 *
 * The engine knows nothing about Notion or Drive — `connector.list()` returns a
 * flat list and everything below is the same for any source. See
 * hq/connectors/README.md.
 *
 * Re-running is how you find new or edited items: anything whose edit time has
 * moved past what we synced flips to `stale`.
 */
async function discover(sourceId, connector, { onProgress = null, full = false, trigger = 'manual' } = {}) {
  const run = await createRun(sourceId, 'discover', 0, { trigger, label: full ? 'Full refresh' : 'Refresh' });

  try {
    // The watermark is the newest edit we have ever seen here. Skipping it
    // (`full`) is the only way to notice things DELETED at the source, since a
    // deletion leaves nothing to sort by — so a full pass stays available and
    // is what "Re-read everything" runs.
    const { rows: [src] } = await db.query(
      'SELECT watermark_at FROM hq_sources WHERE id = $1', [sourceId]);
    const since = full ? null : src?.watermark_at || null;

    const { items } = await connector.list(
      { since },
      ({ found }) => onProgress?.({ phase: 'discover', found }),
    );
    await updateRun(run.id, { total: items.length });

    // A watermarked pass often can't see a changed item's parent. That's
    // handled in the upsert below (COALESCE keeps the parent we already knew),
    // so nothing extra is needed here.

    // Written 100 rows per statement. One statement per item meant ~800 round
    // trips and ~800 lines of query log for a refresh that usually changes
    // nothing — which is exactly what made a refresh look like a runaway job.
    const BATCH = 100;
    let added = 0, updated = 0, newest = src?.watermark_at ? new Date(src.watermark_at) : null;

    for (let i = 0; i < items.length; i += BATCH) {
      if (isCancelled(run.id)) break;
      const slice = items.slice(i, i + BATCH);

      const values = [];
      const params = [sourceId];
      for (const item of slice) {
        const edited = item.editedAt ? new Date(item.editedAt) : null;
        if (edited && (!newest || edited > newest)) newest = edited;
        const base = params.length;
        params.push(
          item.externalId,
          (item.title || '(untitled)').slice(0, 1000),
          item.url || null,
          item.parentTitle || null,
          item.objectType || 'page',
          item.editedAt || null,
          item.mimeType || null,
        );
        values.push(`($1,$${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
      }

      const { rows } = await db.query(
        `INSERT INTO hq_sync_items
           (source_id, external_id, title, url, parent_title, object_type, remote_edited_at, mime_type)
         VALUES ${values.join(',')}
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           title = EXCLUDED.title,
           url = EXCLUDED.url,
           -- Keep the parent we already knew when a watermarked pass can't see it.
           parent_title = COALESCE(EXCLUDED.parent_title, hq_sync_items.parent_title),
           object_type = EXCLUDED.object_type,
           mime_type = EXCLUDED.mime_type,
           remote_edited_at = EXCLUDED.remote_edited_at,
           -- Something already brought in that has since changed becomes stale,
           -- so the UI can offer "update just what moved" rather than everything.
           status = CASE
             WHEN hq_sync_items.status IN ('done','stale')
              AND EXCLUDED.remote_edited_at IS DISTINCT FROM hq_sync_items.synced_edited_at
             THEN 'stale'
             ELSE hq_sync_items.status
           END,
           updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        params
      );
      for (const r of rows) r.inserted ? added++ : updated++;
      await updateRun(run.id, { processed: Math.min(i + BATCH, items.length) });
      onProgress?.({ phase: 'discover', found: items.length, processed: added + updated });
    }

    // Only advance the watermark once the pass actually completed, or a cancel
    // halfway would make the skipped remainder invisible to every later refresh.
    if (newest && !isCancelled(run.id)) {
      await db.query(
        'UPDATE hq_sources SET watermark_at = $2, last_discover_at = NOW() WHERE id = $1',
        [sourceId, newest]);
    }

    await updateRun(run.id, { status: 'done', processed: items.length, succeeded: items.length, finished: true });
    active.delete(run.id);
    await atomsService.updateSource(sourceId, { lastStatus: 'ok', lastSyncAt: new Date() });

    return { runId: run.id, total: items.length, added, updated };
  } catch (err) {
    await updateRun(run.id, { status: 'failed', error: err.message, finished: true });
    active.delete(run.id);
    throw err;
  }
}

// ─── Sync ────────────────────────────────────────────────────────────────────

/**
 * Pull content for the given items, one at a time.
 *
 * `onProgress` fires per item so the UI can show exactly where it is. The loop
 * checks for cancellation between items — mid-item abort would leave a half
 * ingested atom, and an item takes ~2-4s, so waiting for the boundary is fine.
 */
async function syncItems(sourceId, connector, itemIds, {
  kind = null, onProgress = null, trigger = 'manual', label = null,
} = {}) {
  const source = (await atomsService.listSources()).find(s => s.id === sourceId);
  if (!source) throw new Error('source not found');

  const { rows: items } = await db.query(
    `SELECT * FROM hq_sync_items
      WHERE source_id = $1 AND id = ANY($2::int[])
      ORDER BY remote_edited_at DESC NULLS LAST`,
    [sourceId, itemIds]
  );

  const run = await createRun(sourceId, 'sync', items.length, {
    trigger, label: label || `${items.length} page${items.length === 1 ? '' : 's'}`, itemIds,
  });
  const resolvedKind = kind || source.default_kind || connector.defaultKind || 'doc';
  let succeeded = 0, failed = 0, processed = 0;

  onProgress?.({ phase: 'start', runId: run.id, total: items.length });

  for (const item of items) {
    if (isCancelled(run.id)) {
      await db.query(`UPDATE hq_sync_items SET status='pending', updated_at=NOW() WHERE id=$1 AND status='syncing'`, [item.id]);
      await updateRun(run.id, { status: 'cancelled', processed, succeeded, failed, finished: true });
      active.delete(run.id);
      onProgress?.({ phase: 'cancelled', runId: run.id, processed, succeeded, failed, total: items.length });
      return { runId: run.id, cancelled: true, processed, succeeded, failed };
    }

    await db.query(`UPDATE hq_sync_items SET status='syncing', updated_at=NOW() WHERE id=$1`, [item.id]);
    await updateRun(run.id, { currentTitle: item.title.slice(0, 500) });
    onProgress?.({ phase: 'item', runId: run.id, itemId: item.id, title: item.title, processed, total: items.length });

    try {
      const doc = await connector.fetch(item);
      const body = doc.body || '';

      const { atom, chunkCount, skipped } = await ingest.ingestDocument({
        kind: resolvedKind,
        title: doc.title,
        body,
        externalId: doc.externalId,
        externalUrl: doc.url,
        participants: doc.people,
        projects: doc.tags,
        occurredAt: doc.occurredAt,
      }, { sourceId, runScribe: false });   // never an LLM here

      await db.query(
        `UPDATE hq_sync_items
            SET status='done', atom_id=$2, chars=$3, chunks=$4, error=NULL,
                synced_edited_at=remote_edited_at, synced_at=NOW(), updated_at=NOW()
          WHERE id=$1`,
        [item.id, atom.id, (body || '').length, chunkCount ?? atom.chunk_count ?? 0]
      );
      succeeded++;
      onProgress?.({ phase: 'item_done', runId: run.id, itemId: item.id, title: doc.title,
                     chars: (body || '').length, chunks: chunkCount, skipped, processed: processed + 1, total: items.length });
    } catch (err) {
      await db.query(
        `UPDATE hq_sync_items SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`,
        [item.id, err.message.slice(0, 500)]
      );
      failed++;
      onProgress?.({ phase: 'item_failed', runId: run.id, itemId: item.id, title: item.title,
                     error: err.message, processed: processed + 1, total: items.length });
    }

    processed++;
    await updateRun(run.id, { processed, succeeded, failed });
  }

  await updateRun(run.id, { status: 'done', processed, succeeded, failed, currentTitle: null, finished: true });
  active.delete(run.id);
  await atomsService.updateSource(sourceId, { lastStatus: 'ok', lastSyncAt: new Date() });
  onProgress?.({ phase: 'done', runId: run.id, processed, succeeded, failed, total: items.length });

  return { runId: run.id, processed, succeeded, failed };
}

/**
 * Start a run and return immediately.
 *
 * The browser is not what keeps a run alive — closing the tab, losing wifi or
 * navigating away must not stop 40 minutes of fetching. Progress is written to
 * hq_sync_runs on every item, so the UI reads state from the database rather
 * than from a socket it happens to be holding open.
 */
function startSync(sourceId, connector, itemIds, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;

    syncItems(sourceId, connector, itemIds, {
      ...opts,
      onProgress: (p) => {
        // Hand the caller the run id as soon as it exists, then let the rest
        // of the loop finish on its own.
        if (!settled && p.runId) { settled = true; resolve({ runId: p.runId }); }
        opts.onProgress?.(p);
      },
    }).catch(err => {
      console.error('[hq] sync run failed:', err.message);
      if (!settled) { settled = true; reject(err); }
    });
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Recent runs, newest first — the "what has HQ been doing" list. Manual picks
 * and future scheduled jobs land in the same table so they read identically.
 */
async function listRuns(sourceId = null, limit = 25) {
  await reclaimStaleRuns().catch(() => {});
  const { rows } = await db.query(
    `SELECT r.id, r.kind, r.trigger, r.label, r.status, r.total, r.processed,
            r.succeeded, r.failed, r.current_title, r.error,
            r.started_at, r.finished_at, s.label AS source_label, s.kind AS source_kind
       FROM hq_sync_runs r
       JOIN hq_sources s ON s.id = r.source_id
      WHERE ($1::int IS NULL OR r.source_id = $1)
      ORDER BY r.started_at DESC
      LIMIT $2`,
    [sourceId, limit]
  );
  return rows.map(r => ({ ...r, live: active.has(r.id) }));
}

/**
 * The pages a run worked on.
 *
 * Read from the ids the run recorded when it started, not from current status —
 * an item's status moves on (a later run, an ignore, a reset), and a history
 * entry that rewrites itself afterwards is worse than no history.
 */
async function runItems(runId) {
  const { rows } = await db.query(
    `SELECT i.id, i.title, i.url, i.status, i.chars, i.error, i.parent_title, i.atom_id
       FROM hq_sync_runs r
       JOIN hq_sync_items i ON i.id = ANY(r.item_ids)
      WHERE r.id = $1
      ORDER BY i.title`,
    [runId]
  );
  return rows;
}

/** Any run still going, so a returning tab can pick the thread back up. */
async function runningRun(sourceId = null) {
  const runs = await listRuns(sourceId, 5);
  return runs.find(r => r.status === 'running') || null;
}


/**
 * `parent` and `type` are the bulk filters: they exist so a whole database's
 * worth of rows can be selected and ignored in one action, rather than page by
 * page. Everything is a plain equality match on indexed-enough columns.
 */
function itemFilters(sourceId, { status, search, type, parent, since, until }) {
  const where = ['source_id = $1'];
  const params = [sourceId];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (search) { params.push(`%${search}%`); where.push(`title ILIKE $${params.length}`); }
  if (type) { params.push(type); where.push(`object_type = $${params.length}`); }
  if (parent) { params.push(parent); where.push(`parent_title = $${params.length}`); }
  // Date window over when the page last changed in Notion — "what moved this
  // week" is the most common way to decide what's worth bringing in.
  if (since) { params.push(since); where.push(`remote_edited_at >= $${params.length}`); }
  if (until) { params.push(until); where.push(`remote_edited_at < $${params.length}`); }
  return { where: where.join(' AND '), params };
}

async function listItems(sourceId, opts = {}) {
  const { limit = 1000, offset = 0 } = opts;
  const { where, params } = itemFilters(sourceId, opts);
  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT id, external_id, title, url, parent_title, object_type, mime_type, status,
            chars, chunks, error, atom_id, remote_edited_at, synced_at
       FROM hq_sync_items
      WHERE ${where}
      ORDER BY remote_edited_at DESC NULLS LAST, id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

/** Every item id matching the current filters — what "select all" really means. */
async function itemIdsMatching(sourceId, opts = {}) {
  const { where, params } = itemFilters(sourceId, opts);
  const { rows } = await db.query(
    `SELECT id FROM hq_sync_items WHERE ${where}`, params
  );
  return rows.map(r => r.id);
}

/**
 * Faceted counts: every filter's numbers reflect the OTHER filters.
 *
 * Each facet is counted with its own dimension removed from the predicate.
 * Pick "Documents" and the Show counts narrow to documents — but the
 * Documents/Table-rows counts themselves stay comparable, so you can still see
 * what switching would give you. Counting every facet with the full filter set
 * would zero out the option you're already on and make the rail unusable.
 */
async function itemStats(sourceId, filters = {}) {
  const without = (drop) => {
    const rest = { ...filters };
    delete rest[drop];
    return itemFilters(sourceId, rest);
  };

  const forStatus = without('status');
  const forType = without('type');
  const forParent = without('parent');
  const all = itemFilters(sourceId, filters);

  const [statuses, types, parents, totals] = await Promise.all([
    db.query(
      `SELECT status, COUNT(*)::int n, COALESCE(SUM(chars),0)::int chars
         FROM hq_sync_items WHERE ${forStatus.where} GROUP BY status`, forStatus.params),
    db.query(
      `SELECT object_type, COUNT(*)::int n
         FROM hq_sync_items WHERE ${forType.where} GROUP BY object_type`, forType.params),
    db.query(
      `SELECT parent_title, COUNT(*)::int n,
              COUNT(*) FILTER (WHERE status = 'done')::int done
         FROM hq_sync_items
        WHERE ${forParent.where} AND parent_title IS NOT NULL
        GROUP BY parent_title ORDER BY n DESC LIMIT 40`, forParent.params),
    db.query(
      `SELECT COUNT(*)::int n FROM hq_sync_items WHERE ${all.where}`, all.params),
  ]);

  const rows = statuses.rows;
  return {
    byStatus: Object.fromEntries(rows.map(r => [r.status, r.n])),
    byType: Object.fromEntries(types.rows.map(r => [r.object_type, r.n])),
    parents: parents.rows.map(r => ({ title: r.parent_title, count: r.n, done: r.done })),
    // What the list is actually showing, with everything applied.
    total: totals.rows[0].n,
    // The "Everything"/"Both" options mean "this dimension unfiltered".
    statusTotal: rows.reduce((s, r) => s + r.n, 0),
    typeTotal: types.rows.reduce((s, r) => s + r.n, 0),
    syncedChars: rows.filter(r => r.status === 'done').reduce((s, r) => s + r.chars, 0),
  };
}

async function setItemStatus(sourceId, itemIds, status) {
  await db.query(
    `UPDATE hq_sync_items SET status=$3, updated_at=NOW() WHERE source_id=$1 AND id = ANY($2::int[])`,
    [sourceId, itemIds, status]
  );
}

async function latestRun(sourceId) {
  await reclaimStaleRuns().catch(() => {});
  const { rows } = await db.query(
    `SELECT * FROM hq_sync_runs WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [sourceId]
  );
  return rows[0] || null;
}

module.exports = {
  discover, syncItems, startSync, cancelRun, reclaimStaleRuns,
  listItems, itemIdsMatching, itemStats, setItemStatus, latestRun, listRuns, runItems, runningRun,
};
