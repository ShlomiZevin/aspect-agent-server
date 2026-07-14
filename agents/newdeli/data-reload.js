/**
 * New Deli data reload registration.
 * Wires the newdeli reloader into DataReloadService (admin dashboard).
 */

const { loadNewDeli, indexNewDeli, getNewDeliDataInfo } = require('../../scripts/reload-newdeli');
const { getPool } = require('../../services/db.newdeli');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('newdeli', {
    loadFn:          guardReloadFn('newdeli', 'New Deli', loadNewDeli),
    indexFn:         guardReloadFn('newdeli', 'New Deli', indexNewDeli),
    gcsFolderPrefix: 'newdeli/csv/',
    dataInfoFn:      getNewDeliDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
