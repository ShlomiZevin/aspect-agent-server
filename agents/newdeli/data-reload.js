/**
 * New Deli data reload registration.
 * Wires the newdeli reloader into DataReloadService (admin dashboard).
 */

const { loadNewDeli, indexNewDeli, getNewDeliDataInfo } = require('../../scripts/reload-newdeli');
const { getPool } = require('../../services/db.newdeli');

const DISABLED = process.env.NEWDELI_RELOAD_ENABLED !== 'true';

const disabledFn = async () => {
  throw new Error('New Deli reload is disabled. Set NEWDELI_RELOAD_ENABLED=true to enable.');
};

function register(dataReloadService) {
  dataReloadService.registerReloader('newdeli', {
    loadFn:          DISABLED ? disabledFn : loadNewDeli,
    indexFn:         DISABLED ? disabledFn : indexNewDeli,
    gcsFolderPrefix: 'newdeli/csv/',
    dataInfoFn:      getNewDeliDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
