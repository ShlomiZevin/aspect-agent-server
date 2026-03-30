/**
 * Zer4U data reload registration.
 * Registers the zer4u reloader with DataReloadService.
 * All zer4u-specific reload logic lives here or in scripts/reload-zer4u-zero-downtime.js.
 */

const { loadZer4u, indexZer4u, getZer4uDataInfo } = require('../../scripts/reload-zer4u-zero-downtime');

function register(dataReloadService) {
  dataReloadService.registerReloader('zer4u', {
    loadFn: loadZer4u,
    indexFn: indexZer4u,
    gcsFolderPrefix: 'zer4u/',
    dataInfoFn: getZer4uDataInfo,
  });
}

module.exports = { register };
