const providerConfigService = require('./provider-config.service');

/**
 * Wraps a reloader's load/index function with a live "is this schema's
 * reload enabled" check (DB override > <SCHEMA>_RELOAD_ENABLED env var >
 * disabled). Replaces the old pattern of baking a static DISABLED constant
 * in at module-load time, which required a redeploy to flip - this check
 * runs on every call, so toggling it in the Configuration tab takes effect
 * immediately.
 */
function guardReloadFn(schema, label, fn) {
  return async (...args) => {
    const enabled = await providerConfigService.get(`${schema}_reload_enabled`);
    if (enabled !== 'true') {
      throw new Error(`${label} reload is disabled. Enable it from the Data Loader Configuration tab.`);
    }
    return fn(...args);
  };
}

module.exports = { guardReloadFn };
