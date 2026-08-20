/**
 * New Deli data reload registration.
 * Wires the newdeli reloader into DataReloadService (admin dashboard).
 */

const { loadNewDeli, indexNewDeli, getNewDeliDataInfo, FILE_TO_TABLE } = require('../../scripts/reload-newdeli');
const { getPool } = require('../../services/db.newdeli');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('newdeli', {
    loadFn:          guardReloadFn('newdeli', 'New Deli', loadNewDeli),
    indexFn:         guardReloadFn('newdeli', 'New Deli', indexNewDeli),
    gcsFolderPrefix: 'newdeli/csv/',
    // Which delivered files this dataset actually loads — the GCS folder can
    // also hold retired exports, so listing the folder is not the same thing.
    fileMap:         FILE_TO_TABLE,
    dataInfoFn:      getNewDeliDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
