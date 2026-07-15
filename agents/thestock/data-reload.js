/**
 * The Stock data reload registration.
 * Wires the thestock reloader into DataReloadService (admin dashboard).
 */

const { loadTheStock, indexTheStock, getTheStockDataInfo } = require('../../scripts/reload-thestock');
const { getPool } = require('../../services/db.thestock');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('thestock', {
    loadFn:          guardReloadFn('thestock', 'The Stock', loadTheStock),
    indexFn:         guardReloadFn('thestock', 'The Stock', indexTheStock),
    gcsFolderPrefix: 'thestock/',
    dataInfoFn:      getTheStockDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
