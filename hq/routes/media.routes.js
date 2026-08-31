/**
 * HQ — the multimedia library. Mounted at /api/hq/media.
 *
 * Default view is BY CONVERSATION, because that's how people look for things:
 * "the images from the chat where we did the launch". Folders are a second,
 * optional view for imposing an order after the fact.
 */

const express = require('express');
const router = express.Router();
const media = require('../services/media.service');

function fail(res, err) {
  console.error('[hq/media]', err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message });
}

router.get('/', async (req, res) => {
  try {
    res.json({
      items: await media.list({
        conversationId: req.query.conversationId ? parseInt(req.query.conversationId, 10) : null,
        folderId: req.query.folderId ? parseInt(req.query.folderId, 10) : null,
        jobId: req.query.jobId ? parseInt(req.query.jobId, 10) : null,
        workerId: req.query.workerId ? parseInt(req.query.workerId, 10) : null,
        limit: Math.min(parseInt(req.query.limit || '200', 10), 500),
      }),
    });
  } catch (err) { fail(res, err); }
});

/**
 * Stable file link — the address atoms and citations carry. Redirects to a
 * fresh signed GCS URL on every hit, so a link saved months ago still opens.
 */
router.get('/:id/file', async (req, res) => {
  try {
    const row = await media.byId(parseInt(req.params.id, 10));
    if (!row || !row.gcs_path) return res.status(404).json({ error: 'No such file' });
    res.redirect(302, await media.signedUrl(row.gcs_path, 60));
  } catch (err) { fail(res, err); }
});

/** The default browse: conversations that produced something, newest first. */
router.get('/by-conversation', async (_req, res) => {
  try {
    res.json({ conversations: await media.byConversation() });
  } catch (err) { fail(res, err); }
});

router.get('/folders', async (_req, res) => {
  try {
    res.json({ folders: await media.listFolders() });
  } catch (err) { fail(res, err); }
});

router.post('/folders', async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A folder needs a name' });
    res.json({ folder: await media.createFolder(name, req.body?.parentId || null) });
  } catch (err) { fail(res, err); }
});

router.post('/move', async (req, res) => {
  try {
    const { mediaIds = [], folderId = null } = req.body || {};
    if (!mediaIds.length) return res.status(400).json({ error: 'Nothing selected' });
    await media.moveToFolder(mediaIds, folderId);
    res.json({ ok: true, moved: mediaIds.length });
  } catch (err) { fail(res, err); }
});

router.delete('/:id', async (req, res) => {
  try {
    await media.remove(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

module.exports = router;
