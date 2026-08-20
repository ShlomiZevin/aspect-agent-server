/**
 * The Stock data reload registration.
 * Wires the thestock reloader into DataReloadService (admin dashboard).
 */

const { loadTheStock, indexTheStock, getTheStockDataInfo, FILE_TO_TABLE } = require('../../scripts/reload-thestock');
const { getPool } = require('../../services/db.thestock');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('thestock', {
    loadFn:          guardReloadFn('thestock', 'The Stock', loadTheStock),
    indexFn:         guardReloadFn('thestock', 'The Stock', indexTheStock),
    gcsFolderPrefix: 'thestock/',
    // Which delivered files this dataset actually loads — the GCS folder can
    // also hold retired exports, so listing the folder is not the same thing.
    fileMap:         FILE_TO_TABLE,
    dataInfoFn:      getTheStockDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
