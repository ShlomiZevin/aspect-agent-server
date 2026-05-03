/**
 * Zer4U data reload registration.
 * Registers the zer4u reloader with DataReloadService.
 * All zer4u-specific reload logic lives here or in scripts/reload-zer4u-zero-downtime.js.
 */

const { loadZer4u, indexZer4u, getZer4uDataInfo } = require('../../scripts/reload-zer4u-zero-downtime');
const { getPool } = require('../../services/db.zer4u');

// Zer4U has its own dedicated Cloud SQL database so reload is enabled by default.
// Set ZER4U_RELOAD_ENABLED=true in environment to enable; omit or set to anything else to disable.
const DISABLED = process.env.ZER4U_RELOAD_ENABLED !== 'true';

const disabledFn = async () => {
  throw new Error('Zer4U reload is disabled — waiting for dedicated database. Contact admin.');
};

function register(dataReloadService) {
  dataReloadService.registerReloader('zer4u', {
    loadFn:        DISABLED ? disabledFn : loadZer4u,
    indexFn:       DISABLED ? disabledFn : indexZer4u,
    gcsFolderPrefix: 'zer4u/',
    dataInfoFn:    getZer4uDataInfo,
    pool:          getPool(),
  });
}

module.exports = { register };
