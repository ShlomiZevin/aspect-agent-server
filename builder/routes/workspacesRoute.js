/**
 * Builder V2 — Workspaces routes (`/api/builder/workspaces`).
 *
 * Named folders grouping agents on the builder home page. Mounted
 * under its own prefix so the catch-all projectsRoute doesn't shadow
 * it (same pattern as repoRoute).
 *
 *   GET    /                       → list all workspaces
 *   POST   /                       → create { id, ownerUserId?, name }
 *   PATCH  /:id                    → rename { name }
 *   DELETE /:id?cascade=orphan|agents
 *           orphan (default) → agents move to top level
 *           agents           → agents under it are deleted too
 */

const express = require('express');
const workspaces = require('../services/builderWorkspaces');

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const list = await workspaces.listWorkspaces();
    res.json({ workspaces: list });
  } catch (err) {
    console.error('[builder] GET workspaces failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { id, ownerUserId, name } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const ws = await workspaces.createWorkspace({ id, ownerUserId, name });
    res.status(201).json({ workspace: ws });
  } catch (err) {
    console.error('[builder] POST workspace failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body || {};
    await workspaces.renameWorkspace({ id, name });
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'bad_input' ? 400 : 500;
    if (status === 500) console.error('[builder] PATCH workspace failed:', err);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cascade = req.query.cascade === 'agents' ? 'agents' : 'orphan';
    await workspaces.deleteWorkspace({ id, cascade });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] DELETE workspace failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
