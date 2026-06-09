/**
 * Zol Stock data reload registration.
 * Wires the zolstock reloader into DataReloadService (admin dashboard).
 *
 * Disabled by default — set ZOLSTOCK_RELOAD_ENABLED=true in .env to enable.
 * The load/index functions are fill-ready skeletons in scripts/reload-zolstock.js;
 * complete FILE_TO_TABLE + column aliases + indexes once Itzik delivers the data.
 */

const { loadZolStock, indexZolStock, getZolStockDataInfo } = require('../../scripts/reload-zolstock');
const { getPool } = require('../../services/db.zolstock');

const DISABLED = process.env.ZOLSTOCK_RELOAD_ENABLED !== 'true';

const disabledFn = async () => {
  throw new Error('Zol Stock reload is disabled. Set ZOLSTOCK_RELOAD_ENABLED=true to enable.');
};

function register(dataReloadService) {
  dataReloadService.registerReloader('zolstock', {
    loadFn:          DISABLED ? disabledFn : loadZolStock,
    indexFn:         DISABLED ? disabledFn : indexZolStock,
    gcsFolderPrefix: 'zolstock/',
    dataInfoFn:      getZolStockDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
