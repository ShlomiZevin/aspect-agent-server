/**
 * Hyper Toy data reload registration.
 * Wires the hypertoy reloader into DataReloadService (admin dashboard).
 */

const { loadHyperToy, indexHyperToy, getHyperToyDataInfo } = require('../../scripts/reload-hypertoy');
const { getPool } = require('../../services/db.hypertoy');

const DISABLED = process.env.HYPERTOY_RELOAD_ENABLED !== 'true';

const disabledFn = async () => {
  throw new Error('Hyper Toy reload is disabled. Set HYPERTOY_RELOAD_ENABLED=true to enable.');
};

function register(dataReloadService) {
  dataReloadService.registerReloader('hypertoy', {
    loadFn:          DISABLED ? disabledFn : loadHyperToy,
    indexFn:         DISABLED ? disabledFn : indexHyperToy,
    gcsFolderPrefix: 'hyper-toy/',
    dataInfoFn:      getHyperToyDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
