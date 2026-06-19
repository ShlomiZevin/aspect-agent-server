/**
 * Teva Naot data reload registration.
 * Wires the tevanaot reloader into DataReloadService (admin dashboard).
 */

const { loadTevaNaot, indexTevaNaot, getTevaNaotDataInfo } = require('../../scripts/reload-tevanaot');
const { getPool } = require('../../services/db.tevanaot');

const DISABLED = process.env.TEVANAOT_RELOAD_ENABLED !== 'true';

const disabledFn = async () => {
  throw new Error('Teva Naot reload is disabled. Set TEVANAOT_RELOAD_ENABLED=true to enable.');
};

function register(dataReloadService) {
  dataReloadService.registerReloader('tevanaot', {
    loadFn:          DISABLED ? disabledFn : loadTevaNaot,
    indexFn:         DISABLED ? disabledFn : indexTevaNaot,
    gcsFolderPrefix: 'tevanaot/',
    dataInfoFn:      getTevaNaotDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
