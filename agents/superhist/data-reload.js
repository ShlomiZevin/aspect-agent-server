/**
 * The Social Supermarket (הסופר החברתי) data reload registration.
 * Wires the superhist reloader into DataReloadService (admin dashboard).
 *
 * Disabled until switched on in the Data Loader CONFIGURATION TAB. That is a
 * row in provider_config, read live on every call by guardReloadFn — flipping
 * it takes effect immediately. The env var of the same name is only a fallback
 * for a schema with no row yet; editing .env and redeploying is the pattern
 * this replaced.
 *
 * The mapping, indexes and views are complete and were written against the
 * first delivery (2026-09-02); what they have never seen is that delivery
 * arriving through GCS rather than from disk.
 */

const { loadSuperHist, indexSuperHist, getSuperHistDataInfo, FILE_TO_TABLE } = require('../../scripts/reload-superhist');
const { getPool } = require('../../services/db.superhist');
const { guardReloadFn } = require('../../services/reload-guard');

function register(dataReloadService) {
  dataReloadService.registerReloader('superhist', {
    loadFn:          guardReloadFn('superhist', 'The Social Supermarket', loadSuperHist),
    indexFn:         guardReloadFn('superhist', 'The Social Supermarket', indexSuperHist),
    gcsFolderPrefix: 'superhist/',
    // Which delivered files this dataset actually loads — the GCS folder can
    // also hold retired exports, so listing the folder is not the same thing.
    fileMap:         FILE_TO_TABLE,
    dataInfoFn:      getSuperHistDataInfo,
    pool:            getPool(),
  });
}

module.exports = { register };
