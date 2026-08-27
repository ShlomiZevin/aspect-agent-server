/**
 * Aspect Modules API — mounted at /api/modules (one line in server.js).
 *
 * Two audiences in one router, split by path prefix:
 *
 *   PUBLIC (no auth, customer-facing)
 *     GET  /api/modules/:datasetId                    — which modules are LIVE here
 *
 *   ADMIN (super-admin key required, every route)
 *     GET  /api/modules/admin/:datasetId              — all registered modules + state
 *     GET  /api/modules/admin/:datasetId/:moduleId    — one module
 *     PUT  /api/modules/admin/:datasetId/:moduleId/enabled   — { enabled }
 *     PUT  /api/modules/admin/:datasetId/:moduleId/settings  — { settings }
 *     POST /api/modules/admin/:datasetId/:moduleId/init      — start an init run
 *     GET  /api/modules/admin/:datasetId/:moduleId/runs/latest — poll progress
 *     GET  /api/modules/admin/:datasetId/:moduleId/runs/:runId
 *
 * ROUTE ORDER MATTERS: the admin sub-router is mounted BEFORE the public
 * `/:datasetId` route, or "admin" would be captured as a dataset id and every
 * admin call would 404 as an unknown dataset. Same hazard the insights router
 * documents for its `/:datasetId/insights` vs `/:datasetId/:insightId` pair.
 *
 * The public route deliberately returns a different, smaller shape than the
 * admin one — id and bilingual name only. It is called from a customer's
 * browser to decide whether to render a nav item, and settings, bindings and
 * model ids are none of that browser's business.
 */

const express = require('express');
const router = express.Router();
const moduleService = require('../services/module.service');
const moduleInitService = require('../services/module-init.service');
const { requireSuperAdmin } = require('../../services/super-admin');

// ── admin sub-router — gated as a whole ──────────────────────────────────
// Guarding the mount rather than each handler means a route added later
// cannot accidentally ship unprotected.
const admin = express.Router({ mergeParams: true });
admin.use(requireSuperAdmin);

/** Every registered module for a dataset, with state and resolved settings. */
admin.get('/:datasetId', async (req, res) => {
  try {
    const modules = await moduleService.listForDataset(req.params.datasetId);
    if (!modules) return res.status(404).json({ error: `Unknown dataset: ${req.params.datasetId}` });
    res.json({ datasetId: req.params.datasetId, modules });
  } catch (err) {
    console.error('[modules] admin list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

admin.get('/:datasetId/:moduleId', async (req, res) => {
  try {
    const { datasetId, moduleId } = req.params;
    const found = await moduleService.getForDataset(datasetId, moduleId);
    if (!found) return res.status(404).json({ error: `Unknown dataset or module: ${datasetId}/${moduleId}` });
    res.json(found);
  } catch (err) {
    console.error('[modules] admin get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The on/off button. Note this does NOT touch `status` — a module can be
 * enabled before it has ever been initialized (it simply is not live yet),
 * and disabling one must not throw away a converged binding.
 */
admin.put('/:datasetId/:moduleId/enabled', async (req, res) => {
  try {
    const { datasetId, moduleId } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must be { enabled: boolean }' });
    }
    const updated = await moduleService.setEnabled(datasetId, moduleId, enabled, req.body.updatedBy);
    if (!updated) return res.status(404).json({ error: `Unknown dataset or module: ${datasetId}/${moduleId}` });
    res.json(updated);
  } catch (err) {
    console.error('[modules] setEnabled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

admin.put('/:datasetId/:moduleId/settings', async (req, res) => {
  try {
    const { datasetId, moduleId } = req.params;
    const { settings } = req.body || {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'Body must be { settings: object }' });
    }
    const updated = await moduleService.saveSettings(datasetId, moduleId, settings, req.body.updatedBy);
    if (!updated) return res.status(404).json({ error: `Unknown dataset or module: ${datasetId}/${moduleId}` });
    res.json(updated);
  } catch (err) {
    console.error('[modules] saveSettings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Start (or re-start) an init run.
 *
 * Returns as soon as the run row exists — the pipeline continues in the
 * background and the client polls `/runs/latest`. Holding the request open
 * for a multi-minute pipeline is what the insights-jobs progress endpoint
 * exists to avoid.
 *
 * 409 when a run is already in progress: two concurrent inits would race on
 * the same binding and the same scratch schema.
 */
admin.post('/:datasetId/:moduleId/init', async (req, res) => {
  try {
    const { datasetId, moduleId } = req.params;
    const started = await moduleInitService.startInit(datasetId, moduleId, {
      updatedBy: req.body?.updatedBy,
    });
    if (started.error) return res.status(started.code || 500).json({ error: started.error });
    res.json({ runId: started.runId, status: 'running' });
  } catch (err) {
    console.error('[modules] init start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** The run the progress bar polls. `progress` is computed, never stored. */
admin.get('/:datasetId/:moduleId/runs/latest', async (req, res) => {
  try {
    const { datasetId, moduleId } = req.params;
    if (!moduleService.isKnownDataset(datasetId)) {
      return res.status(404).json({ error: `Unknown dataset: ${datasetId}` });
    }
    const run = await moduleInitService.getLatestRun(datasetId, moduleId);
    if (!run) return res.json({ run: null });
    res.json({ run, progress: moduleInitService.describeProgress(run) });
  } catch (err) {
    console.error('[modules] latest run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

admin.get('/:datasetId/:moduleId/runs/:runId', async (req, res) => {
  try {
    const run = await moduleInitService.getRun(Number(req.params.runId));
    if (!run) return res.status(404).json({ error: `Unknown run: ${req.params.runId}` });
    res.json({ run, progress: moduleInitService.describeProgress(run) });
  } catch (err) {
    console.error('[modules] get run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.use('/admin', admin);

// ── public ───────────────────────────────────────────────────────────────

/**
 * Which modules are live for this dataset — the call the client situation
 * page makes to decide whether its nav item exists at all.
 *
 * A dataset with nothing enabled answers `{ modules: [] }`, not a 404: the
 * dataset is real, it simply has no modules, and the page should render its
 * normal self rather than an error.
 */
router.get('/:datasetId', async (req, res) => {
  try {
    const status = await moduleService.getPublicStatus(req.params.datasetId);
    if (!status) return res.status(404).json({ error: `Unknown dataset: ${req.params.datasetId}` });
    res.json(status);
  } catch (err) {
    console.error('[modules] public status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
