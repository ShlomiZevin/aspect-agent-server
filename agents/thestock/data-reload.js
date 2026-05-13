/**
 * The Stock data reload registration.
 * Wires the thestock reloader into DataReloadService (admin dashboard).
 */

const { loadTheStock, indexTheStock, getTheStockDataInfo } = require('../../scripts/reload-thestock');
const { getPool } = require('../../services/db.thestock');

const DISABLED = process.env.THESTOCK_RELOAD_ENABLED !== 'true';

const disabledFn = async () => {
  throw new Error('The Stock reload is disabled. Set THESTOCK_RELOAD_ENABLED=true to enable.');
};

function register(dataReloadService) {
  dataReloadService.registerReloader('thestock', {
    loadFn:          DISABLED ? disabledFn : loadTheStock,
    indexFn:         DISABLED ? disabledFn : indexTheStock,
    gcsFolderPrefix: 'thestock/',
    dataInfoFn:      getTheStockDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
