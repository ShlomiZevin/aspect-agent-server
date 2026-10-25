/**
 * Simulation jobs — the API behind Admin → Simulations (task #897).
 *
 *   GET  /api/simulations?agentSlug=<slug>   the agent's jobs, newest first
 *   GET  /api/simulations/:id                one job
 *   POST /api/simulations                    release a job
 *
 * Two callers use the POST: the Admin screen's "New simulation" form, and
 * the main server forwarding a release to the dedicated simulation
 * service (`SIMULATION_SERVICE_URL`, see builder/services/simulationJobs.js).
 * Assistants release jobs through `/builder/mcp/simulations`, which also
 * checks the person's name against the task-board roster.
 */

const express = require('express');
const simulationJobs = require('../services/simulationJobs');
const { publicBaseOf } = require('./publicBase');

const router = express.Router();

function fail(res, err, what) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(`[simulations] ${what} failed:`, err);
  return res.status(500).json({ error: err.message });
}

router.get('/', async (req, res) => {
  try {
    const { agentSlug, limit } = req.query;
    if (!agentSlug) return res.status(400).json({ error: 'Missing agentSlug' });
    res.json({ simulations: await simulationJobs.listJobs({ slug: String(agentSlug), limit }) });
  } catch (err) {
    fail(res, err, 'list');
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json({ simulation: await simulationJobs.getJob(req.params.id) });
  } catch (err) {
    fail(res, err, 'read');
  }
});

router.post('/', async (req, res) => {
  try {
    const { slug, by, body } = req.body || {};
    if (!slug || !by) return res.status(400).json({ error: 'Missing slug or by' });
    // Released from the Admin screen, or forwarded by the main server (which
    // marks the body itself). Either way releaseJob decides where it runs.
    res.status(201).json(await simulationJobs.releaseJob({
      slug, by: String(by).trim().slice(0, 60), body: body || {}, publicBase: publicBaseOf(req),
    }));
  } catch (err) {
    fail(res, err, 'release');
  }
});

module.exports = router;
