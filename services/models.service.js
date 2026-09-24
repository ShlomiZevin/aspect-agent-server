/**
 * Models registry — the single source of truth for the LLM models
 * the platform supports.
 *
 * Server-side hardcoded today. Exposed via GET /api/models so the
 * client (every dropdown that picks a model, every notes/blurb in
 * the UI) reads from the same list. A future DB-backed flavour can
 * swap the constants without changing the public surface.
 *
 * Every other place that needed to know "which provider does this
 * model belong to?" now calls `providerOf(modelId)` instead of
 * doing prefix matches on the model string.
 *
 * Shape:
 *   {
 *     id:         the canonical API id used in provider SDK calls
 *                 (e.g. 'claude-sonnet-4-6'). Stable, lowercase.
 *     providerId: 'openai' | 'anthropic' | 'google'
 *     name:       human-facing label shown in dropdowns
 *     notes:      short description — shown in dropdowns and
 *                 anywhere the model is identified to a user
 *     deprecated: optional boolean — hidden from new pickers but
 *                 still resolvable so old configs still run
 *     price:      optional { in, out } — USD per 1M tokens at list
 *                 price. Only set where the rate is known; costOf()
 *                 returns null for the rest rather than guessing.
 *   }
 */

const MODELS = [
  // ── Anthropic ──
  { id: 'claude-opus-5',     providerId: 'anthropic', name: 'Claude Opus 5',     notes: 'Newest top reasoning — same price as 4.7', price: { in: 5, out: 25 } },
  { id: 'claude-sonnet-5',   providerId: 'anthropic', name: 'Claude Sonnet 5',   notes: 'Newest balanced — same price as 4.6', price: { in: 3, out: 15 } },
  { id: 'claude-opus-4-7',   providerId: 'anthropic', name: 'Claude Opus 4.7',   notes: 'Top reasoning — slow & expensive', price: { in: 5, out: 25 } },
  { id: 'claude-sonnet-4-6', providerId: 'anthropic', name: 'Claude Sonnet 4.6', notes: 'Default for thinking — fast & sharp', price: { in: 3, out: 15 } },
  { id: 'claude-haiku-4-5',  providerId: 'anthropic', name: 'Claude Haiku 4.5',  notes: 'Cheap & fast', price: { in: 1, out: 5 } },

  // ── OpenAI ──
  { id: 'gpt-5.6',       providerId: 'openai', name: 'GPT-5.6 Sol',   notes: 'Newest, recommended' },
  { id: 'gpt-5.6-terra', providerId: 'openai', name: 'GPT-5.6 Terra', notes: 'Balanced — half price of Sol' },
  { id: 'gpt-5.6-luna',  providerId: 'openai', name: 'GPT-5.6 Luna',  notes: 'Cheap & fast' },
  { id: 'gpt-5.5',      providerId: 'openai', name: 'GPT-5.5',      notes: 'Strong all-round' },
  { id: 'gpt-4o',       providerId: 'openai', name: 'GPT-4o',       notes: 'Balanced' },
  { id: 'gpt-5.4-mini', providerId: 'openai', name: 'GPT-5.4 mini', notes: 'New mini — cheap & fast' },
  { id: 'gpt-4o-mini',  providerId: 'openai', name: 'GPT-4o mini',  notes: 'Old mini (default extractor)' },
  // Hidden from pickers — an old ChatGPT snapshot (Aug 2025), kept so
  // existing agents that reference it keep resolving.
  { id: 'gpt-5-chat-latest', providerId: 'openai', name: 'GPT-5 chat', notes: 'Legacy', deprecated: true },

  // ── Google ──
  { id: 'gemini-2.5-pro',   providerId: 'google', name: 'Gemini 2.5 Pro',   notes: 'Powerful, long context' },
  { id: 'gemini-2.5-flash', providerId: 'google', name: 'Gemini 2.5 Flash', notes: 'Cheap & fast (default talker)' },
];

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', icon: 'A' },
  { id: 'openai',    label: 'OpenAI',    icon: 'O' },
  { id: 'google',    label: 'Google',    icon: 'G' },
];

const VALID_PROVIDERS = new Set(PROVIDERS.map(p => p.id));

const _byId = new Map(MODELS.map(m => [m.id, m]));

/**
 * Get a model by id, or undefined if unknown.
 */
function getModel(modelId) {
  return _byId.get(modelId);
}

/**
 * Return the provider id for a model. Throws on unknown ids so
 * callers fail loudly instead of silently falling back to OpenAI
 * (the old behaviour of the prefix matcher).
 */
function providerOf(modelId) {
  const m = _byId.get(modelId);
  if (!m) {
    throw new Error(`Unknown model id: "${modelId}". Add it to services/models.service.js`);
  }
  return m.providerId;
}

/**
 * Soft variant — returns null instead of throwing. Use it when the
 * caller has a sensible fallback (logging code, defensive paths).
 */
function tryProviderOf(modelId) {
  return _byId.get(modelId)?.providerId || null;
}

/**
 * Full payload for `GET /api/models`. Groups by provider for UI
 * convenience and preserves declaration order within each group.
 */
function listForApi() {
  return {
    providers: PROVIDERS.map(p => ({
      ...p,
      models: MODELS.filter(m => m.providerId === p.id && !m.deprecated),
    })),
    models: MODELS.filter(m => !m.deprecated),
  };
}

function isKnownProvider(providerId) {
  return VALID_PROVIDERS.has(providerId);
}

/**
 * List-price USD for a token count, or null when the model has no known rate.
 * An estimate: llm_usage does not record prompt-cache hits, so a cached call
 * costs less than this says.
 */
function costOf(modelId, inputTokens, outputTokens) {
  const price = _byId.get(modelId)?.price;
  if (!price) return null;
  return ((inputTokens || 0) / 1e6) * price.in + ((outputTokens || 0) / 1e6) * price.out;
}

module.exports = {
  getModel,
  providerOf,
  tryProviderOf,
  costOf,
  listForApi,
  isKnownProvider,
  PROVIDERS,
  MODELS,
};
