/**
 * Teva Naot data reload registration.
 * Wires the tevanaot reloader into DataReloadService (admin dashboard).
 */

const { loadTevaNaot, indexTevaNaot, getTevaNaotDataInfo, FILE_TO_TABLE } = require('../../scripts/reload-tevanaot');
const { getPool } = require('../../services/db.tevanaot');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('tevanaot', {
    loadFn:          guardReloadFn('tevanaot', 'Teva Naot', loadTevaNaot),
    indexFn:         guardReloadFn('tevanaot', 'Teva Naot', indexTevaNaot),
    gcsFolderPrefix: 'tevanaot/',
    // Which delivered files this dataset actually loads — the GCS folder can
    // also hold retired exports, so listing the folder is not the same thing.
    fileMap:         FILE_TO_TABLE,
    dataInfoFn:      getTevaNaotDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
