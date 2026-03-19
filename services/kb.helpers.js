/**
 * KB Provider Helpers
 *
 * The `providers` field is a JSON array: ["openai", "google", "anthropic"]
 * These helpers standardize how we check and manipulate providers.
 */

/**
 * Check if a KB has a specific provider.
 * @param {Object} kb - Knowledge base record (must have `providers` field)
 * @param {string} provider - 'openai' | 'google' | 'anthropic'
 * @returns {boolean}
 */
function hasProvider(kb, provider) {
  if (!kb?.providers) return false;
  const arr = Array.isArray(kb.providers) ? kb.providers : JSON.parse(kb.providers);
  return arr.includes(provider);
}

/**
 * Get the providers array from a KB record.
 * @param {Object} kb
 * @returns {string[]}
 */
function getProviders(kb) {
  if (!kb?.providers) return [];
  return Array.isArray(kb.providers) ? kb.providers : JSON.parse(kb.providers);
}

/**
 * Get providers that the KB does NOT have yet (for sync targets).
 * @param {Object} kb
 * @returns {string[]}
 */
function getMissingProviders(kb) {
  const all = ['openai', 'google', 'anthropic'];
  const current = getProviders(kb);
  return all.filter(p => !current.includes(p));
}

module.exports = { hasProvider, getProviders, getMissingProviders };
