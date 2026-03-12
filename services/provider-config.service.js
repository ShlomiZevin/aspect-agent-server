const db = require('./db.pg');
const { providerConfig } = require('../db/schema');
const { eq } = require('drizzle-orm');

/**
 * Provider Configuration Service
 *
 * Stores API keys and provider settings in the DB.
 * DB values override environment variables.
 * Changes take effect immediately for all subsequent LLM calls (no restart needed).
 *
 * Supported keys:
 *   openai_api_key, openai_org_id, openai_project_id
 *   anthropic_api_key, anthropic_admin_api_key
 *   gemini_api_key
 *   gcp_billing_project_id, gcp_billing_dataset, gcp_billing_service_account_json
 */

// Keys that map to environment variable fallbacks
const ENV_FALLBACKS = {
  openai_api_key:                    'OPENAI_API_KEY',
  openai_org_id:                     'OPENAI_ORG_ID',
  openai_project_id:                 'OPENAI_PROJECT_ID',
  anthropic_api_key:                 'ANTHROPIC_API_KEY',
  anthropic_admin_api_key:           'ANTHROPIC_ADMIN_API_KEY',
  gemini_api_key:                    'GEMINI_API_KEY',
  gcp_billing_project_id:            'GCP_BILLING_PROJECT_ID',
  gcp_billing_dataset:               'GCP_BILLING_DATASET',
  gcp_billing_service_account_json:  'GCP_BILLING_SERVICE_ACCOUNT_JSON',
};

// All known config keys (in display order)
const ALL_KEYS = Object.keys(ENV_FALLBACKS);

// Sensitive keys — value is masked in GET responses
const SENSITIVE_KEYS = new Set([
  'openai_api_key',
  'anthropic_api_key',
  'anthropic_admin_api_key',
  'gemini_api_key',
  'gcp_billing_service_account_json',
]);

class ProviderConfigService {
  constructor() {
    this._cache = null;       // Map<key, value> — loaded from DB
    this._cacheLoaded = false;
    this._drizzle = null;
  }

  _getDrizzle() {
    if (!this._drizzle) this._drizzle = db.getDrizzle();
    return this._drizzle;
  }

  /**
   * Load all config values from DB into cache.
   * Called once on first access, then kept hot.
   */
  async _ensureCache() {
    if (this._cacheLoaded) return;
    const rows = await this._getDrizzle().select().from(providerConfig);
    this._cache = new Map(rows.map(r => [r.key, r.value]));
    this._cacheLoaded = true;
  }

  /**
   * Invalidate in-memory cache (forces reload on next access).
   */
  invalidateCache() {
    this._cacheLoaded = false;
    this._cache = null;
  }

  /**
   * Get the effective value for a config key synchronously from in-memory cache.
   * Returns null if cache is not yet loaded (before first async get/list call).
   * Priority: DB value > env variable > null
   */
  getCached(key) {
    const dbValue = this._cache?.get(key);
    if (dbValue !== undefined && dbValue !== null && dbValue !== '') {
      return dbValue;
    }
    const envKey = ENV_FALLBACKS[key];
    return envKey ? (process.env[envKey] || null) : null;
  }

  /**
   * Get the effective value for a config key.
   * Priority: DB value > env variable > null
   */
  async get(key) {
    await this._ensureCache();
    const dbValue = this._cache?.get(key);
    if (dbValue !== undefined && dbValue !== null && dbValue !== '') {
      return dbValue;
    }
    const envKey = ENV_FALLBACKS[key];
    return envKey ? (process.env[envKey] || null) : null;
  }

  /**
   * Get multiple keys at once.
   * Returns { key: value } map with effective values.
   */
  async getMany(keys) {
    await this._ensureCache();
    const result = {};
    for (const key of keys) {
      result[key] = await this.get(key);
    }
    return result;
  }

  /**
   * List all config keys with their sources and masked values (for admin UI).
   */
  async list() {
    await this._ensureCache();
    return ALL_KEYS.map(key => {
      const dbValue = this._cache?.get(key) ?? null;
      const envKey = ENV_FALLBACKS[key];
      const envValue = envKey ? (process.env[envKey] || null) : null;
      const effectiveValue = (dbValue !== null && dbValue !== '') ? dbValue : envValue;

      return {
        key,
        source: (dbValue !== null && dbValue !== '') ? 'db' : (envValue ? 'env' : 'not_set'),
        isSet: !!effectiveValue,
        maskedValue: effectiveValue ? this._mask(key, effectiveValue) : null,
      };
    });
  }

  /**
   * Set a config key in the DB and update in-memory cache immediately.
   * LLM services will pick up the new key on the very next call.
   */
  async set(key, value) {
    if (!ALL_KEYS.includes(key)) {
      throw new Error(`Unknown config key: ${key}`);
    }

    const drizzle = this._getDrizzle();
    await drizzle
      .insert(providerConfig)
      .values({ key, value: value || null })
      .onConflictDoUpdate({
        target: providerConfig.key,
        set: { value: value || null, updatedAt: new Date() },
      });

    // Update in-memory cache directly — no DB re-read needed
    if (this._cacheLoaded && this._cache) {
      if (value) {
        this._cache.set(key, value);
      } else {
        this._cache.delete(key);
      }
    } else {
      // Cache not yet loaded — force reload on next access
      this.invalidateCache();
    }
  }

  /**
   * Delete a DB override for a key (falls back to env var).
   */
  async delete(key) {
    const drizzle = this._getDrizzle();
    await drizzle.delete(providerConfig).where(eq(providerConfig.key, key));

    // Remove from in-memory cache directly
    if (this._cacheLoaded && this._cache) {
      this._cache.delete(key);
    } else {
      this.invalidateCache();
    }
  }

  /**
   * Pre-load cache from DB. Call once on server startup so getCached()
   * is always ready before the first LLM request.
   */
  async initialize() {
    await this._ensureCache();
  }

  /**
   * Mask a sensitive value for display: show first 4 + last 4 chars.
   */
  _mask(key, value) {
    if (!SENSITIVE_KEYS.has(key)) return value;
    if (key === 'gcp_billing_service_account_json') {
      return '[JSON key uploaded]';
    }
    if (value.length <= 8) return '****';
    return value.slice(0, 4) + '****' + value.slice(-4);
  }
}

module.exports = new ProviderConfigService();
