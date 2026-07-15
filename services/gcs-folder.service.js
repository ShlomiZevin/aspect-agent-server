const providerConfigService = require('./provider-config.service');

/**
 * Resolves the GCS folder a schema's loader reads CSVs from.
 * DB override (set from the Data Loader Configuration tab) > the caller's
 * hardcoded default. Each scripts/reload-*.js calls this instead of using
 * its own `GCS_FOLDER` constant directly, so changing the folder in the
 * admin UI actually redirects where the import reads from.
 */
async function getGcsFolder(schema, defaultFolder) {
  const value = await providerConfigService.get(`${schema}_gcs_folder`);
  return value || defaultFolder;
}

module.exports = { getGcsFolder };
