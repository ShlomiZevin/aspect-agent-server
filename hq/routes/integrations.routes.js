/**
 * HQ — integrations. Mounted at /api/hq/integrations.
 *
 * Everything long-running streams SSE so the screen can show exactly where it
 * is and offer a stop button. Nothing here calls an LLM.
 */

const express = require('express');
const router = express.Router();

const notion = require('../services/notion.service');
const atomsService = require('../services/atoms.service');
const sync = require('../services/sync.service');

function fail(res, err, status = 500) {
  console.error('[hq/integrations]', err.message);
  if (!res.headersSent) res.status(status).json({ error: err.message });
}

/** Open an SSE stream and return a `send(event, data)` writer. */
function openStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The one provider row everything hangs off. */
async function notionSource() {
  return atomsService.getOrCreateProviderSource('notion', 'Notion workspace');
}

// ─── Providers ───────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    const src = await notionSource();
    const [stats, run] = await Promise.all([sync.itemStats(src.id), sync.latestRun(src.id)]);

    res.json({
      providers: [
        {
          id: 'notion',
          name: 'Notion',
          connected: notion.isConfigured(),
          sourceId: src.id,
          defaultKind: src.default_kind,
          stats,
          lastRun: run,
          lastSyncAt: src.last_sync_at,
        },
        // Declared but not built — the screen shows what's coming without pretending.
        { id: 'google_drive', name: 'Google Drive', connected: false, comingSoon: true },
        { id: 'meet',         name: 'Google Meet recordings', connected: false, comingSoon: true },
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
router.post('/notion/discover', async (req, res) => {
  const send = openStream(res);
  try {
    const src = await notionSource();
    const result = await sync.discoverNotion(src.id, {
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

router.get('/notion/items', async (req, res) => {
  try {
    const src = await notionSource();
    const items = await sync.listItems(src.id, {
      status: req.query.status || null,
      search: req.query.search || null,
      type: req.query.type || null,
      parent: req.query.parent || null,
      since: req.query.since || null,
      until: req.query.until || null,
      limit: Math.min(parseInt(req.query.limit || '1000', 10), 2000),
      offset: parseInt(req.query.offset || '0', 10),
    });
    res.json({ items, stats: await sync.itemStats(src.id) });
  } catch (err) { fail(res, err); }
});

/** Bulk include/exclude, so a big list can be curated before any fetching. */
router.post('/notion/items/status', async (req, res) => {
  try {
    const { itemIds = null, status, filters = null } = req.body || {};
    if (!['pending', 'skipped'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending or skipped' });
    }
    const src = await notionSource();

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
router.post('/notion/sync', async (req, res) => {
  try {
    const { itemIds = null, kind = null, filters = null, label = null } = req.body || {};
    const src = await notionSource();

    const ids = Array.isArray(itemIds) && itemIds.length
      ? itemIds
      : await sync.itemIdsMatching(src.id, filters || {});
    if (!ids.length) return res.status(400).json({ error: 'pick at least one page first' });

    const busy = await sync.runningRun(src.id);
    if (busy) {
      return res.status(409).json({ error: 'Something is already running here', run: busy });
    }

    const { runId } = await sync.startSync(src.id, ids, { kind, label, trigger: 'manual' });
    res.json({ ok: true, runId, total: ids.length });
  } catch (err) { fail(res, err); }
});

/** Everything HQ has run — manual picks now, scheduled jobs later. */
router.get('/runs', async (req, res) => {
  try {
    const src = await notionSource();
    res.json({ runs: await sync.listRuns(src.id, Math.min(parseInt(req.query.limit || '20', 10), 100)) });
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

router.get('/notion/run', async (_req, res) => {
  try {
    const src = await notionSource();
    res.json({ run: await sync.latestRun(src.id) });
  } catch (err) { fail(res, err); }
});

/** What HQ assigns to pages this integration pulls in. */
router.patch('/notion', async (req, res) => {
  try {
    const src = await notionSource();
    if (req.body?.defaultKind) {
      const db = require('../../services/db.pg');
      await db.query(`UPDATE hq_sources SET default_kind=$2, updated_at=NOW() WHERE id=$1`,
                     [src.id, req.body.defaultKind]);
    }
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

module.exports = router;
