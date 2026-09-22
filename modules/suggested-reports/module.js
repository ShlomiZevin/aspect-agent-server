/**
 * Suggested Reports — Aspect Module, kind 'app'.
 *
 * The switch for the nightly regeneration of a dataset's shared "Suggested
 * reports" (insights/services/insights-refresh.service.js). Each run
 * re-investigates the dataset's whole bootstrap prompt set on Claude — about
 * 15-50 calls and 120-380K input tokens per client per night — whether or not
 * anyone opens the product, billed to the customer's own key. So it is OFF
 * unless this module is enabled for the dataset, and a dataset with no row
 * (every dataset, on the day this shipped) generates nothing.
 *
 * Turning it on generates a fresh set right away (onEnabled); from then on the
 * nightly tick keeps it current after each data load. Turning it off stops the
 * nightly run and leaves the last set in place.
 *
 * APP module: nothing to audit, bind or build, so no data hooks. The card shows
 * what the generation has cost (usage), because that cost is the whole reason
 * this is a switch.
 */

const usage = require('./usage');

module.exports = {
  id: 'suggested-reports',
  kind: 'app',
  scope: 'dataset',
  name: { en: 'Suggested reports', he: 'דוחות מוצעים' },
  version: 1,

  // Enabling IS the setting — there is nothing else to configure.
  settingsSchema: [],
  notificationEvents: [],

  /** Fired (not awaited) when an admin switches the module on. */
  onEnabled(datasetId) {
    // Lazy: insights-refresh pulls in the investigation pipeline, which the
    // module registry must not load at boot.
    const insightsRefresh = require('../../insights/services/insights-refresh.service');
    return insightsRefresh.ensureInsightsRefreshed({ force: true, onlyDataset: datasetId });
  },

  usage: usage.summarize,
};
