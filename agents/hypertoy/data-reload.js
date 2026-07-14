/**
 * Hyper Toy data reload registration.
 * Wires the hypertoy reloader into DataReloadService (admin dashboard).
 */

const { loadHyperToy, indexHyperToy, getHyperToyDataInfo, getHyperToyDataRange } = require('../../scripts/reload-hypertoy');
const { getPool } = require('../../services/db.hypertoy');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('hypertoy', {
    loadFn:          guardReloadFn('hypertoy', 'Hyper Toy', loadHyperToy),
    indexFn:         guardReloadFn('hypertoy', 'Hyper Toy', indexHyperToy),
    gcsFolderPrefix: 'hyper-toy/',
    dataInfoFn:      getHyperToyDataInfo,
    dataRangeFn:     getHyperToyDataRange,
    pool:            getPool(),
  });
}

module.exports = { register };
