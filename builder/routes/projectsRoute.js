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

module.exports = router;
