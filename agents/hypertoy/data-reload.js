/**
 * Hyper Toy data reload registration.
 * Wires the hypertoy reloader into DataReloadService (admin dashboard).
 */

const { loadHyperToy, indexHyperToy, getHyperToyDataInfo, getHyperToyDataRange, FILE_TO_TABLE } = require('../../scripts/reload-hypertoy');
const { getPool } = require('../../services/db.hypertoy');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('hypertoy', {
    loadFn:          guardReloadFn('hypertoy', 'Hyper Toy', loadHyperToy),
    indexFn:         guardReloadFn('hypertoy', 'Hyper Toy', indexHyperToy),
    gcsFolderPrefix: 'hyper-toy/',
    // Which delivered files this dataset actually loads — the GCS folder can
    // also hold retired exports, so listing the folder is not the same thing.
    fileMap:         FILE_TO_TABLE,
    dataInfoFn:      getHyperToyDataInfo,
    dataRangeFn:     getHyperToyDataRange,
    pool:            getPool(),
  });
}

module.exports = { register };
