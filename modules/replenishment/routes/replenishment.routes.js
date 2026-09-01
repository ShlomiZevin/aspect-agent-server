/**
 * Smart Replenishment API — mounted under the modules router at
 * /api/modules/replenishment (see modules/routes/modules.routes.js).
 *
 *   GET  /:datasetId/suppliers                — supplier list + resolved lead times
 *   PUT  /:datasetId/suppliers/:key           — set/clear one supplier's overrides
 *   GET  /:datasetId/defaults                 — the dataset-level settings
 *   PUT  /:datasetId/defaults                 — update them
 *   GET  /:datasetId/recommendations          — ?supplier= &onlyDue= &horizonDays=
 *                                                &limit= &offset= &search=
 *   GET  /:datasetId/recommendations/:sku     — one item, with its full working
 *
 * EVERY route 404s unless the module is enabled AND ready. That is not
 * defensive tidiness: a module that is enabled but never initialized has no
 * views to read, and one that is ready but switched off must behave exactly
 * as though it were not installed. The client page uses the 404 to decide
 * whether its nav item exists at all.
 *
 * These are CLIENT-facing reads (the buyer's screen), so they are not behind
 * the super-admin gate. Writing a lead time is gated by the module's own
 * `clientCanEditLeadTimes` setting instead — the buyer owns lead times and is
 * the person who knows them, but a dataset can be configured otherwise.
 */

const express = require('express');
const router = express.Router();
const recommendations = require('../services/recommendations.service');
const supplierSettings = require('../services/supplier-settings.service');
const moduleService = require('../../services/module.service');
const { isSuperAdminRequest } = require('../../../services/super-admin');

const MODULE_ID = 'replenishment';

/** Turn a service-level `{error, code}` into a response; else null. */
function refuse(res, result) {
  if (result?.error) {
    res.status(result.code || 500).json({ error: result.error });
    return true;
  }
  return false;
}

router.get('/:datasetId/suppliers', async (req, res) => {
  try {
    const out = await recommendations.listSuppliers(req.params.datasetId);
    if (refuse(res, out)) return;
    res.json(out);
  } catch (err) {
    console.error('[replenishment] suppliers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Set or clear one supplier's overrides.
 *
 * A field sent as null CLEARS it and falls back to the dataset default —
 * that is how a buyer un-sets a lead time. Fields simply absent are left
 * alone, so a partial save cannot wipe values the form did not show.
 */
router.put('/:datasetId/suppliers/:key', async (req, res) => {
  try {
    const { datasetId, key } = req.params;
    const mod = await moduleService.getForDataset(datasetId, MODULE_ID);
    if (!mod?.live) return res.status(404).json({ error: `Replenishment is not live for ${datasetId}` });

    // Default is editable — the buyer owns lead times. A dataset can turn
    // that off, and then only a super-admin may write.
    const clientMayEdit = mod.settings?.clientCanEditLeadTimes !== false;
    if (!clientMayEdit && !isSuperAdminRequest(req)) {
      return res.status(403).json({ error: 'Delivery times are managed by the Aspect team for this dataset' });
    }

    const row = await supplierSettings.upsertOverride(
      datasetId, key, req.body || {}, req.body?.updatedBy || 'client');
    res.json({ supplierKey: key, saved: row });
  } catch (err) {
    console.error('[replenishment] supplier save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:datasetId/defaults', async (req, res) => {
  try {
    const mod = await moduleService.getForDataset(req.params.datasetId, MODULE_ID);
    if (!mod?.live) return res.status(404).json({ error: `Replenishment is not live for ${req.params.datasetId}` });
    res.json({
      datasetId: req.params.datasetId,
      defaults: mod.settings,
      sources: mod.settingsSources,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Dataset-level settings are an operator concern, not a buyer's. */
router.put('/:datasetId/defaults', async (req, res) => {
  try {
    if (!isSuperAdminRequest(req)) {
      return res.status(403).json({ error: 'Super-admin key required' });
    }
    const updated = await moduleService.saveSettings(
      req.params.datasetId, MODULE_ID, req.body?.defaults || {}, req.body?.updatedBy);
    if (!updated) return res.status(404).json({ error: `Unknown dataset: ${req.params.datasetId}` });
    res.json({ datasetId: req.params.datasetId, defaults: updated.settings, sources: updated.settingsSources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The /:sku route is registered BEFORE the list route would swallow it —
// Express matches in order, and `recommendations/:sku` must not be read as a
// query on `recommendations`.
router.get('/:datasetId/recommendations/:sku', async (req, res) => {
  try {
    const out = await recommendations.getBySku(req.params.datasetId, req.params.sku, {
      today: req.query.today,
    });
    if (refuse(res, out)) return;
    res.json(out);
  } catch (err) {
    console.error('[replenishment] sku detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:datasetId/recommendations', async (req, res) => {
  try {
    const out = await recommendations.getRecommendations(req.params.datasetId, {
      supplier: req.query.supplier,
      onlyDue: req.query.onlyDue === 'true',
      horizonDays: req.query.horizonDays ? Number(req.query.horizonDays) : undefined,
      limit: req.query.limit,
      offset: req.query.offset,
      search: req.query.search,
      today: req.query.today,
    });
    if (refuse(res, out)) return;
    res.json(out);
  } catch (err) {
    console.error('[replenishment] recommendations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
