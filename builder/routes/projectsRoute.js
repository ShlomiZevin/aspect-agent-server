/**
 * Builder V2 — doc CRUD routes (`/api/builder/*`).
 *
 * Mounts an Express Router that the main server.js wires in. The
 * route handlers are thin shells over `builderProjects.service`.
 *
 * Auth model: today the client sends `ownerUserId` in the query /
 * body (the existing localStorage dummy id). Production-grade
 * auth comes later; this matches how v1 endpoints handle it.
 */

const express = require('express');
const projects = require('../services/builderProjects');

const router = express.Router();

/**
 * GET /api/builder/projects/list?ownerUserId=:uid
 *   Returns a flat list of the user's projects (one row per agent)
 *   for the BuilderHomePage. Names — not ids — for everything the
 *   UI displays.
 */
router.get('/projects/list', async (req, res) => {
  try {
    const { ownerUserId } = req.query;
    if (!ownerUserId) {
      return res.status(400).json({ error: 'Missing ownerUserId' });
    }
    const list = await projects.listProjects({ ownerUserId });
    res.json({ projects: list });
  } catch (err) {
    console.error('[builder] GET projects/list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/builder/projects?agentSlug=:slug&ownerUserId=:uid
 *   Returns the full nested ProjectDoc, or 404 if not bootstrapped.
 */
router.get('/projects', async (req, res) => {
  try {
    const { agentSlug, ownerUserId } = req.query;
    if (!agentSlug || !ownerUserId) {
      return res.status(400).json({ error: 'Missing agentSlug or ownerUserId' });
    }
    const doc = await projects.hydrateProject({ agentSlug, ownerUserId });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (err) {
    console.error('[builder] GET projects failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/builder/projects/:projectId
 *   Tears down a project: every agent under it, every agent version,
 *   every crew, every crew version. Conversations / messages tied to
 *   the legacy agents table are intentionally left in place.
 */
router.delete('/projects/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    await projects.deleteProject({ projectId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] DELETE project failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/builder/projects
 *   Bootstrap a new project + agent + initial crew.
 *   Body: { ownerUserId, projectId, projectName,
 *           agentId, agentSlug, agentVersionId, agentBody,
 *           crewId, crewVersionId, crewBody }
 */
router.post('/projects', async (req, res) => {
  try {
    const args = req.body || {};
    if (!args.ownerUserId || !args.projectId || !args.agentId || !args.agentSlug ||
        !args.agentVersionId || !args.crewId || !args.crewVersionId) {
      return res.status(400).json({ error: 'Missing required ids' });
    }
    await projects.createProject(args);
    const doc = await projects.hydrateProject({
      agentSlug: args.agentSlug,
      ownerUserId: args.ownerUserId,
    });
    res.status(201).json(doc);
  } catch (err) {
    console.error('[builder] POST projects failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/builder/projects/:projectId/duplicate
 *   Body: { newSlug, newName, workspaceId? }
 *   Deep-copies the project's agent + crews (active versions only) into
 *   a fresh project with new ids + slug. Returns { projectId, agentId,
 *   slug, name }. 409 on a slug already taken.
 */
router.post('/projects/:projectId/duplicate', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { newSlug, newName, workspaceId } = req.body || {};
    const result = await projects.duplicateProject({ projectId, newSlug, newName, workspaceId });
    res.status(201).json(result);
  } catch (err) {
    const status = err.code === 'slug_taken' ? 409
      : err.code === 'bad_input' ? 400
      : err.code === 'not_found' ? 404
      : 500;
    if (status === 500) console.error('[builder] duplicate project failed:', err);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ─── Agent shell mutations (rename / move / archive) ──────────────

/**
 * PATCH /api/builder/agents/:agentId
 *   Body may carry any of:
 *     { name, slug }        → rename (display name + URL slug)
 *     { workspaceId|null }  → move into a workspace / to top level
 *     { archived: bool }    → archive / restore
 *   Applied in that order. Returns { ok, slug? } (new slug on rename).
 */
router.patch('/agents/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const body = req.body || {};
    let result = { ok: true };

    if (body.name !== undefined || body.slug !== undefined) {
      const renamed = await projects.renameAgent({
        agentId, name: body.name, slug: body.slug,
      });
      result.slug = renamed.slug;
      result.name = renamed.name;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'workspaceId')) {
      await projects.moveAgent({ agentId, workspaceId: body.workspaceId || null });
    }
    if (typeof body.archived === 'boolean') {
      await projects.setAgentArchived({ agentId, archived: body.archived });
    }

    res.json(result);
  } catch (err) {
    const status = err.code === 'slug_taken' ? 409
      : err.code === 'bad_input' ? 400
      : err.code === 'not_found' ? 404
      : 500;
    if (status === 500) console.error('[builder] PATCH agent failed:', err);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ─── Agent version actions ────────────────────────────────────────

/**
 * POST /api/builder/agents/:agentId/versions
 *   Save As — create a new agent version. Body: { versionId, body, description? }
 */
router.post('/agents/:agentId/versions', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { versionId, body, description } = req.body || {};
    if (!versionId || !body) return res.status(400).json({ error: 'Missing versionId or body' });
    await projects.saveAgentVersionAs({ agentId, versionId, body, description });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] POST agent version failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/builder/agents/:agentId/versions/:versionId
 *   Save — overwrite an existing agent version's body. Body: { body }
 */
router.put('/agents/:agentId/versions/:versionId', async (req, res) => {
  try {
    const { agentId, versionId } = req.params;
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'Missing body' });
    await projects.saveAgentVersion({ agentId, versionId, body });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] PUT agent version failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/builder/agents/:agentId/active   Body: { versionId }
 * PUT /api/builder/agents/:agentId/viewing  Body: { versionId }
 */
router.put('/agents/:agentId/active', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { versionId } = req.body || {};
    if (!versionId) return res.status(400).json({ error: 'Missing versionId' });
    await projects.setAgentActive({ agentId, versionId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] PUT agent active failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/agents/:agentId/viewing', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { versionId } = req.body || {};
    if (!versionId) return res.status(400).json({ error: 'Missing versionId' });
    await projects.setAgentViewing({ agentId, versionId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] PUT agent viewing failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/builder/agents/:agentId/versions/:versionId
 *   Refuses to delete the last/active/viewing version — service
 *   throws a labelled error and we return 409 with the reason so
 *   the UI can show "switch viewing/active first".
 */
router.delete('/agents/:agentId/versions/:versionId', async (req, res) => {
  try {
    const { agentId, versionId } = req.params;
    await projects.deleteAgentVersion({ agentId, versionId });
    res.json({ ok: true });
  } catch (err) {
    const guard = ['is_active', 'is_viewing', 'last_version'].includes(err.code);
    const status = err.code === 'not_found' ? 404 : guard ? 409 : 500;
    if (status === 500) console.error('[builder] DELETE agent version failed:', err);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ─── Crew lifecycle ───────────────────────────────────────────────

/**
 * POST /api/builder/agents/:agentId/crews
 *   Body: { crewId, versionId, body }
 */
router.post('/agents/:agentId/crews', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { crewId, versionId, body } = req.body || {};
    if (!crewId || !versionId || !body) {
      return res.status(400).json({ error: 'Missing crewId, versionId, or body' });
    }
    await projects.createCrew({ agentId, crewId, versionId, body });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] POST crew failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/builder/crews/:crewId
 */
router.delete('/crews/:crewId', async (req, res) => {
  try {
    const { crewId } = req.params;
    await projects.deleteCrew({ crewId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] DELETE crew failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Crew version actions ─────────────────────────────────────────

router.post('/crews/:crewId/versions', async (req, res) => {
  try {
    const { crewId } = req.params;
    const { versionId, body, description } = req.body || {};
    if (!versionId || !body) return res.status(400).json({ error: 'Missing versionId or body' });
    await projects.saveCrewVersionAs({ crewId, versionId, body, description });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] POST crew version failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/crews/:crewId/versions/:versionId', async (req, res) => {
  try {
    const { crewId, versionId } = req.params;
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'Missing body' });
    await projects.saveCrewVersion({ crewId, versionId, body });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] PUT crew version failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/crews/:crewId/active', async (req, res) => {
  try {
    const { crewId } = req.params;
    const { versionId } = req.body || {};
    if (!versionId) return res.status(400).json({ error: 'Missing versionId' });
    await projects.setCrewActive({ crewId, versionId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] PUT crew active failed:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/crews/:crewId/viewing', async (req, res) => {
  try {
    const { crewId } = req.params;
    const { versionId } = req.body || {};
    if (!versionId) return res.status(400).json({ error: 'Missing versionId' });
    await projects.setCrewViewing({ crewId, versionId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[builder] PUT crew viewing failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/builder/crews/:crewId/versions/:versionId
 *   Same guard semantics as the agent variant — 409 with code when
 *   the version is last/active/viewing so the UI can react.
 */
router.delete('/crews/:crewId/versions/:versionId', async (req, res) => {
  try {
    const { crewId, versionId } = req.params;
    await projects.deleteCrewVersion({ crewId, versionId });
    res.json({ ok: true });
  } catch (err) {
    const guard = ['is_active', 'is_viewing', 'last_version'].includes(err.code);
    const status = err.code === 'not_found' ? 404 : guard ? 409 : 500;
    if (status === 500) console.error('[builder] DELETE crew version failed:', err);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
