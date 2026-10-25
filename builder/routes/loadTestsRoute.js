/**
 * Load tests — the API behind Admin → Load tests (task #902).
 *
 *   GET  /api/load-tests?agentSlug=<slug>   the agent's runs, newest first
 *   GET  /api/load-tests/:id                one run with its conversations
 *   POST /api/load-tests/estimate           what a run would cost — nothing starts
 *        { slug, body: { conversations, … } }
 *   POST /api/load-tests                    release a run (refused over the $20 cap)
 *        { slug, by, body: { conversations, version?, start?, lines? | persona+turns+model?, label? } }
 *   POST /api/load-tests/:id/stop           { by } — conversations take no more turns
 *
 * Also called by the main server forwarding a release to the dedicated
 * simulation service (`SIMULATION_SERVICE_URL`), like /api/simulations.
 */

const express = require('express');
const loadTests = require('../services/loadTests');
const { publicBaseOf } = require('./publicBase');

const router = express.Router();

function fail(res, err, what) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  console.error(`[load-tests] ${what} failed:`, err);
  return res.status(500).json({ error: err.message });
}

router.get('/', async (req, res) => {
  try {
    const { agentSlug, limit } = req.query;
    if (!agentSlug) return res.status(400).json({ error: 'Missing agentSlug' });
    res.json({ loadTests: await loadTests.listRuns({ slug: String(agentSlug), limit }) });
  } catch (err) {
    fail(res, err, 'list');
  }
});

router.post('/estimate', async (req, res) => {
  try {
    const { slug, body } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'Missing slug' });
    res.json({ estimate: await loadTests.estimate({ slug: String(slug), body: body || {} }) });
  } catch (err) {
    fail(res, err, 'estimate');
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json({ loadTest: await loadTests.getRun(req.params.id) });
  } catch (err) {
    fail(res, err, 'read');
  }
});

router.post('/:id/stop', async (req, res) => {
  try {
    res.json({ loadTest: await loadTests.stopRun(req.params.id, (req.body || {}).by) });
  } catch (err) {
    fail(res, err, 'stop');
  }
});

router.post('/', async (req, res) => {
  try {
    const { slug, by, body } = req.body || {};
    if (!slug || !by) return res.status(400).json({ error: 'Missing slug or by' });
    res.status(201).json(await loadTests.releaseRun({
      slug, by: String(by).trim().slice(0, 60), body: body || {}, publicBase: publicBaseOf(req),
    }));
  } catch (err) {
    fail(res, err, 'release');
  }
});

module.exports = router;
