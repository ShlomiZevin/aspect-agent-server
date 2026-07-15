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
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('zolstock', {
    loadFn:          guardReloadFn('zolstock', 'Zol Stock', loadZolStock),
    indexFn:         guardReloadFn('zolstock', 'Zol Stock', indexZolStock),
    gcsFolderPrefix: 'zolstock/',
    dataInfoFn:      getZolStockDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
