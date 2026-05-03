/**
 * Zer4U data reload registration.
 * Registers the zer4u reloader with DataReloadService.
 * All zer4u-specific reload logic lives here or in scripts/reload-zer4u-zero-downtime.js.
 */

const { loadZer4u, indexZer4u, getZer4uDataInfo } = require('../../scripts/reload-zer4u-zero-downtime');
const { getPool } = require('../../services/db.zer4u');

// Zer4U reload is disabled until it gets its own dedicated Cloud SQL database.
// Heavy indexing operations (CREATE INDEX on 26M+ row tables) block the shared DB
// and affect other services (Lybi etc). Set DISABLE_ZER4U_RELOAD=false to re-enable.
const DISABLED = process.env.DISABLE_ZER4U_RELOAD !== 'false';

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
