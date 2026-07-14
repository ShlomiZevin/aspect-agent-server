/**
 * Zer4U data reload registration.
 * Registers the zer4u reloader with DataReloadService.
 * All zer4u-specific reload logic lives here or in scripts/reload-zer4u-zero-downtime.js.
 */

const { loadZer4u, indexZer4u, getZer4uDataInfo } = require('../../scripts/reload-zer4u-zero-downtime');
const { getPool } = require('../../services/db.zer4u');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('zer4u', {
    loadFn:        guardReloadFn('zer4u', 'Zer4U', loadZer4u),
    indexFn:       guardReloadFn('zer4u', 'Zer4U', indexZer4u),
    gcsFolderPrefix: 'zer4u/',
    dataInfoFn:    getZer4uDataInfo,
    pool:          getPool(),
  });
}

module.exports = { register };
