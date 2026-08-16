/**
 * HQ — API routes. Mounted at /api/hq.
 *
 * Internal tier: these endpoints serve Lybi's own company brain, never a
 * customer surface (docs/guides/LYBI_HQ.md §1).
 */

const express = require('express');
const router = express.Router();

const db = require('../../services/db.pg');
const pinecone = require('../../services/kb.pinecone.service');
const notion = require('../services/notion.service');
const atomsService = require('../services/atoms.service');
const ingest = require('../services/ingest.service');
const scribe = require('../services/scribe.service');
const askService = require('../services/ask.service');
const drop = require('../services/drop.service');
const budget = require('../services/budget.service');

function fail(res, err, status = 500) {
  console.error('[hq]', err.message);
  res.status(status).json({ error: err.message });
}

// ─── Status ──────────────────────────────────────────────────────────────────

router.get('/status', async (_req, res) => {
  try {
    const counts = await atomsService.countAtoms();
    const total = counts.reduce((sum, r) => sum + r.count, 0);

    res.json({
      ok: true,
      notionConfigured: notion.isConfigured(),
      totalAtoms: total,
      byKind: counts.reduce((acc, r) => {
        acc[r.kind] = (acc[r.kind] || 0) + r.count;
        return acc;
      }, {}),
      indexed: counts.filter(r => r.status === 'indexed').reduce((s, r) => s + r.count, 0),
      failed: counts.filter(r => r.status === 'failed').reduce((s, r) => s + r.count, 0),
      budget: await budget.budgetStatus(),
    });
  } catch (err) { fail(res, err); }
});

// ─── Drop ────────────────────────────────────────────────────────────────────

/** Tell the client what a pasted string is, before it commits to importing. */
router.post('/drop/inspect', async (req, res) => {
  try {
    const parsed = drop.classifyInput(req.body?.input);
    if (parsed.type !== 'notion') return res.json(parsed);

    if (!notion.isConfigured()) {
      return res.json({ ...parsed, error: 'NOTION_TOKEN is not set on the server.' });
    }

    const { type, object } = await notion.resolveObject(parsed.id);
    let rowCount = null;
    if (type === 'database') {
      const pages = await notion.listDatabasePages(object.id);
      rowCount = pages.length;
    }

    res.json({
      type: 'notion',
      id: object.id,
      notionType: type,
      title: notion.titleOf(object),
      url: object.url || null,
      rowCount,
    });
  } catch (err) { fail(res, err, 400); }
});

/**
 * Import. Streams progress over SSE because a meetings database can be
 * hundreds of pages and a silent multi-minute POST is indistinguishable from
 * a hang.
 */
router.post('/drop', async (req, res) => {
  const { input, kind = 'auto', title = null } = req.body || {};
  const parsed = drop.classifyInput(input);

  if (parsed.type === 'empty') return res.status(400).json({ error: 'nothing to drop' });

  // Text and plain URLs are quick — plain JSON is fine.
  if (parsed.type === 'text') {
    try {
      const { atom } = await drop.dropText(parsed.text, { title, kind: kind === 'auto' ? 'note' : kind });
      return res.json({ ok: true, type: 'text', atom });
    } catch (err) { return fail(res, err, 400); }
  }

  if (parsed.type === 'url') {
    try {
      const { atom } = await drop.dropText(`[${parsed.url}](${parsed.url})`, {
        title: title || parsed.url,
        kind: kind === 'auto' ? 'doc' : kind,
        sourceUrl: parsed.url,
      });
      return res.json({ ok: true, type: 'url', atom });
    } catch (err) { return fail(res, err, 400); }
  }

  // Notion — SSE.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await drop.dropNotion(parsed.id, {
      kind,
      onProgress: p => send('progress', p),
    });
    send('done', {
      ok: true,
      type: 'notion',
      label: result.label,
      notionType: result.type,
      total: result.total,
      ingested: result.ingested,
      failures: result.results.filter(r => !r.ok),
    });
  } catch (err) {
    console.error('[hq] drop failed:', err.message);
    send('error', { error: err.message });
  } finally {
    res.end();
  }
});

// ─── Sources ─────────────────────────────────────────────────────────────────

router.get('/sources', async (_req, res) => {
  try {
    res.json({ sources: await atomsService.listSources() });
  } catch (err) { fail(res, err); }
});

router.post('/sources/:id/resync', async (req, res) => {
  try {
    const sources = await atomsService.listSources();
    const source = sources.find(s => s.id === parseInt(req.params.id, 10));
    if (!source) return res.status(404).json({ error: 'source not found' });
    if (source.kind !== 'notion') return res.status(400).json({ error: 'only Notion sources re-sync today' });

    const result = await drop.dropNotion(source.config.notionId, { kind: 'auto' });
    res.json({ ok: true, ingested: result.ingested, total: result.total });
  } catch (err) { fail(res, err); }
});

router.delete('/sources/:id', async (req, res) => {
  try {
    await atomsService.deleteSource(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// ─── Atoms ───────────────────────────────────────────────────────────────────

router.get('/atoms', async (req, res) => {
  try {
    // Clear any Scribe run orphaned by a restart before we report status.
    await atomsService.reclaimStaleScribes().catch(() => {});

    const atoms = await atomsService.listAtoms({
      kind: req.query.kind || null,
      search: req.query.search || null,
      limit: Math.min(parseInt(req.query.limit || '100', 10), 500),
      offset: parseInt(req.query.offset || '0', 10),
    });
    res.json({ atoms });
  } catch (err) { fail(res, err); }
});

router.get('/atoms/:id', async (req, res) => {
  try {
    const atom = await atomsService.getAtom(parseInt(req.params.id, 10));
    if (!atom) return res.status(404).json({ error: 'not found' });
    res.json({ atom });
  } catch (err) { fail(res, err); }
});

/** Everything must be correctable — see LYBI_HQ.md §2b. */
router.patch('/atoms/:id', async (req, res) => {
  try {
    const atom = await atomsService.patchAtom(parseInt(req.params.id, 10), req.body || {});
    res.json({ atom });
  } catch (err) { fail(res, err); }
});

router.delete('/atoms/:id', async (req, res) => {
  try {
    await ingest.removeAtom(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** Re-run the Scribe — the point of keeping full transcripts. */
router.post('/atoms/:id/scribe', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await atomsService.setScribeStatus(id, 'running');
    res.json({ ok: true, status: 'running' });

    scribe.runScribe(id).catch(err => {
      console.error(`[hq] scribe failed for atom ${id}:`, err.message);
      atomsService.setScribeStatus(id, 'failed', err.message).catch(() => {});
    });
  } catch (err) { fail(res, err); }
});

router.post('/atoms/:id/reindex', async (req, res) => {
  try {
    const atom = await atomsService.getAtom(parseInt(req.params.id, 10));
    if (!atom) return res.status(404).json({ error: 'not found' });
    const chunkCount = await ingest.indexAtom(atom);
    res.json({ ok: true, chunkCount });
  } catch (err) { fail(res, err); }
});

/**
 * Start fresh: forget everything HQ has read.
 *
 * The vector store is wiped by NAMESPACE, not atom by atom. Deleting per atom
 * only reaches chunks whose atom row still exists — anything orphaned by an
 * earlier failed delete would survive and keep surfacing in answers, which is
 * the exact failure a "start fresh" button exists to rule out.
 *
 * Kept on purpose: the connector inventory (reset to "not yet") and the
 * watermark, so an 800-page list doesn't need rediscovering just to re-pick
 * from it. `full: true` drops those too, for a genuinely blank slate.
 */
router.post('/reset', async (req, res) => {
  try {
    if ((req.body || {}).confirm !== 'DELETE') {
      return res.status(400).json({ error: 'reset needs an explicit confirmation' });
    }
    const full = (req.body || {}).full === true;

    const { rows: [before] } = await db.query('SELECT COUNT(*)::int n FROM hq_atoms');

    // Vectors first: once the rows are gone we can no longer name what to drop.
    // An absent namespace 404s from Pinecone, but that IS the desired state —
    // otherwise pressing "start fresh" twice would fail the second time.
    let vectorsCleared = true;
    try {
      await pinecone.deleteNamespaceByName(ingest.HQ_NAMESPACE);
    } catch (err) {
      const missing = err?.status === 404 || /not found|does not exist/i.test(err?.message || '');
      if (!missing) throw err;
      console.log('[hq] reset: vector namespace was already empty');
    }

    await db.query('DELETE FROM hq_sync_runs');
    await db.query('DELETE FROM hq_links');
    await db.query('DELETE FROM hq_atoms');

    if (full) {
      await db.query('DELETE FROM hq_sync_items');
      await db.query('DELETE FROM hq_sources');
    } else {
      await db.query(
        `UPDATE hq_sync_items
            SET status='pending', atom_id=NULL, chars=NULL, chunks=NULL,
                error=NULL, synced_at=NULL, synced_edited_at=NULL, updated_at=NOW()`);
      // Non-provider sources only ever described a one-off import that no
      // longer exists; the provider row owns the page list and must survive.
      await db.query(`DELETE FROM hq_sources WHERE config->>'provider' IS DISTINCT FROM 'true'`);
      await db.query(`UPDATE hq_sources SET last_sync_at = NULL, last_status = 'pending'`);
    }

    res.json({ ok: true, removed: before.n, vectorsCleared, full });
  } catch (err) { fail(res, err); }
});

// ─── Ask ─────────────────────────────────────────────────────────────────────

router.post('/ask', async (req, res) => {
  try {
    const result = await askService.ask(req.body?.question);
    res.json(result);
  } catch (err) { fail(res, err, 400); }
});

// Integrations live in their own router — see integrations.routes.js.
router.use('/integrations', require('./integrations.routes'));

module.exports = router;
