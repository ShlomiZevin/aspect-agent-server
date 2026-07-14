/**
 * Teva Naot data reload registration.
 * Wires the tevanaot reloader into DataReloadService (admin dashboard).
 */

const { loadTevaNaot, indexTevaNaot, getTevaNaotDataInfo } = require('../../scripts/reload-tevanaot');
const { getPool } = require('../../services/db.tevanaot');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('tevanaot', {
    loadFn:          guardReloadFn('tevanaot', 'Teva Naot', loadTevaNaot),
    indexFn:         guardReloadFn('tevanaot', 'Teva Naot', indexTevaNaot),
    gcsFolderPrefix: 'tevanaot/',
    dataInfoFn:      getTevaNaotDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
