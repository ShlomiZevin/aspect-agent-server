/**
 * The Otto gate — every /api/otto route sits behind this.
 *
 * v1 had NO auth at all: anyone with the URL could burn build tokens and
 * read or write any dataset's screens. The gate requires the `otto` module
 * to be LIVE for the dataset (enabled AND ready — moduleService.isLive is
 * the single definition, never re-derived here), which is also what makes
 * "client can create custom screens" a per-client admin switch with no new
 * infrastructure.
 *
 * Reads are gated too, deliberately: with the module off the shelf simply
 * omits the custom section, so nothing links here — a request arriving
 * anyway is a stale bookmark or a probe, and 403 is the right answer to
 * both.
 */

const moduleService = require('../../modules/services/module.service');
const datasetRegistry = require('../../insights/datasets/registry');

function requireOttoLive() {
  return async (req, res, next) => {
    try {
      const { datasetId } = req.params;
      const entry = datasetRegistry.get(datasetId);
      if (!entry) return res.status(404).json({ error: `Unknown dataset: ${datasetId}` });

      const module = await moduleService.getForDataset(datasetId, 'otto');
      if (!module?.live) {
        return res.status(403).json({ error: 'Otto is not enabled for this account' });
      }
      if (!module.binding) {
        // Live without a brief cannot happen through the normal flow (ready
        // implies a converged init), but a hand-edited row could get here —
        // and every downstream service would NPE on brief.sources.
        return res.status(503).json({ error: 'Otto has no dataset brief — run the module init' });
      }

      req.otto = {
        module,
        brief: module.binding,
        settings: module.settings,
        schemaName: entry.schemaName,
        pool: entry.getPool(),
      };
      next();
    } catch (err) {
      console.error('[otto] gate failed:', err);
      res.status(500).json({ error: 'Otto is unavailable right now' });
    }
  };
}

module.exports = { requireOttoLive };
