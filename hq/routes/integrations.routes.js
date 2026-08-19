/**
 * HQ — integrations. Mounted at /api/hq/integrations.
 *
 * Everything long-running streams SSE so the screen can show exactly where it
 * is and offer a stop button. Nothing here calls an LLM.
 */

const express = require('express');
const router = express.Router();

const connectors = require('../connectors');
const atomsService = require('../services/atoms.service');
const sync = require('../services/sync.service');

function fail(res, err, status = null) {
  console.error('[hq/integrations]', err.message);
  // Connectors tag their own errors (an unbuilt source is a 404, not a crash).
  if (!res.headersSent) res.status(status || err.status || 500).json({ error: err.message });
}

/** Open an SSE stream and return a `send(event, data)` writer. */
function openStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Resolve `:provider` to its connector plus the one hq_sources row it hangs off.
 * Every route below is source-agnostic — adding Drive adds no routes.
 */
async function resolve(providerId) {
  const connector = connectors.get(providerId);
  const source = await atomsService.getOrCreateProviderSource(connector.id, connector.label);
  return { connector, source };
}

// ─── Providers ───────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    const built = await Promise.all(connectors.list().map(async (c) => {
      const source = await atomsService.getOrCreateProviderSource(c.id, c.label);
      const [stats, run] = await Promise.all([
        sync.itemStats(source.id), sync.latestRun(source.id),
      ]);
      return {
        id: c.id,
        name: c.name,
        connected: c.isConfigured(),
        sourceId: source.id,
        defaultKind: source.default_kind,
        stats,
        lastRun: run,
        lastSyncAt: source.last_sync_at,
      };
    }));

    res.json({
      providers: [
        ...built,
        // Declared but not built — the screen shows what's coming without pretending.
        ...connectors.PLANNED.map(p => ({ ...p, connected: false, comingSoon: true })),
      ],
    });
  } catch (err) { fail(res, err); }
});

// ─── Discover ────────────────────────────────────────────────────────────────

/**
 * Metadata only — fast, free, fetches no page content.
 *
 * Default is watermarked: only pages edited since the last successful pass.
 * `full: true` re-reads the whole workspace, which is the only way to notice a
 * page that was deleted in Notion.
 */
router.post('/:provider/discover', async (req, res) => {
  const send = openStream(res);
  try {
    const { source: src, connector } = await resolve(req.params.provider);
    const result = await sync.discover(src.id, connector, {
      full: req.body?.full === true,
      onProgress: p => send('progress', p),
    });
    send('done', { ...result, stats: await sync.itemStats(src.id) });
  } catch (err) {
    console.error('[hq/integrations] discover failed:', err.message);
    send('error', { error: err.message });
  } finally { res.end(); }
});

// ─── Items ───────────────────────────────────────────────────────────────────

router.get('/:provider/items', async (req, res) => {
  try {
    const { source: src, connector } = await resolve(req.params.provider);
    const filters = {
      status: req.query.status || null,
      search: req.query.search || null,
      type: req.query.type || null,
      parent: req.query.parent || null,
      since: req.query.since || null,
      until: req.query.until || null,
    };
    const items = await sync.listItems(src.id, {
      ...filters,
      limit: Math.min(parseInt(req.query.limit || '1000', 10), 2000),
      offset: parseInt(req.query.offset || '0', 10),
    });
    // Same filters, so every facet count reflects what's currently selected.
    res.json({ items, stats: await sync.itemStats(src.id, filters) });
  } catch (err) { fail(res, err); }
});

/** Bulk include/exclude, so a big list can be curated before any fetching. */
router.post('/:provider/items/status', async (req, res) => {
  try {
    const { itemIds = null, status, filters = null } = req.body || {};
    if (!['pending', 'skipped'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending or skipped' });
    }
    const { source: src, connector } = await resolve(req.params.provider);

    // `filters` lets the UI say "everything currently listed" without shipping
    // hundreds of ids up the wire — the same predicate the list was built from.
    const ids = Array.isArray(itemIds) && itemIds.length
      ? itemIds
      : await sync.itemIdsMatching(src.id, filters || {});
    if (!ids.length) return res.json({ ok: true, changed: 0, stats: await sync.itemStats(src.id) });
    await sync.setItemStatus(src.id, ids, status);
    res.json({ ok: true, changed: ids.length, stats: await sync.itemStats(src.id) });
  } catch (err) { fail(res, err); }
});

// ─── Sync ────────────────────────────────────────────────────────────────────

/**
 * Start pulling content for the chosen items, and answer straight away.
 *
 * The run does NOT belong to this request — closing the tab, losing wifi or
 * navigating away leaves it running, because a 40-minute job that dies with a
 * socket is not a job anyone can trust. Progress is persisted per item, so the
 * UI (or a new tab, or another person) reads it back from /runs.
 */
router.post('/:provider/sync', async (req, res) => {
  try {
    const { itemIds = null, kind = null, filters = null, label = null } = req.body || {};
    const { source: src, connector } = await resolve(req.params.provider);

    const ids = Array.isArray(itemIds) && itemIds.length
      ? itemIds
      : await sync.itemIdsMatching(src.id, filters || {});
    if (!ids.length) return res.status(400).json({ error: 'pick at least one page first' });

    const busy = await sync.runningRun(src.id);
    if (busy) {
      return res.status(409).json({ error: 'Something is already running here', run: busy });
    }

    const { runId } = await sync.startSync(src.id, connector, ids, { kind, label, trigger: 'manual' });
    res.json({ ok: true, runId, total: ids.length });
  } catch (err) { fail(res, err); }
});

/** Everything HQ has run — manual picks now, scheduled jobs later. */
router.get('/runs', async (req, res) => {
  try {
    // No source filter: Activity shows every source in one place, and each row
    // already names which one it was.
    res.json({ runs: await sync.listRuns(null, Math.min(parseInt(req.query.limit || '20', 10), 100)) });
  } catch (err) { fail(res, err); }
});

/** Which pages a given run actually touched, and how each one turned out. */
router.get('/runs/:runId/items', async (req, res) => {
  try {
    res.json({ items: await sync.runItems(req.params.runId) });
  } catch (err) { fail(res, err); }
});

router.post('/runs/:runId/cancel', async (req, res) => {
  try {
    const stopped = sync.cancelRun(req.params.runId);
    // Not being in the registry means it already finished, or a restart lost
    // it — either way the caller should stop waiting.
    res.json({ ok: true, stopping: stopped });
  } catch (err) { fail(res, err); }
});

router.get('/:provider/run', async (req, res) => {
  try {
    const { source: src } = await resolve(req.params.provider);
    res.json({ run: await sync.latestRun(src.id) });
  } catch (err) { fail(res, err); }
});

/** What HQ assigns to pages this integration pulls in. */
router.patch('/:provider', async (req, res) => {
  try {
    const { source: src, connector } = await resolve(req.params.provider);
    if (req.body?.defaultKind) {
      const db = require('../../services/db.pg');
      await db.query(`UPDATE hq_sources SET default_kind=$2, updated_at=NOW() WHERE id=$1`,
                     [src.id, req.body.defaultKind]);
    }
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

module.exports = router;
