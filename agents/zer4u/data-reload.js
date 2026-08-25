/**
 * Zer4U data reload registration.
 * Registers the zer4u reloader with DataReloadService.
 * All zer4u-specific reload logic lives here or in scripts/reload-zer4u-zero-downtime.js.
 */

const { loadZer4u, indexZer4u, getZer4uDataInfo, FILE_TO_TABLE } = require('../../scripts/reload-zer4u-zero-downtime');
const { getPool } = require('../../services/db.zer4u');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('zer4u', {
    loadFn:        guardReloadFn('zer4u', 'Zer4U', loadZer4u),
    indexFn:       guardReloadFn('zer4u', 'Zer4U', indexZer4u),
    gcsFolderPrefix: 'zer4u/',
    // Which delivered files this dataset actually loads — the GCS folder can
    // also hold retired exports, so listing the folder is not the same thing.
    fileMap:         FILE_TO_TABLE,
    dataInfoFn:    getZer4uDataInfo,
    pool:          getPool(),
  });
}

module.exports = { register };
