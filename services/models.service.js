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
 *     legacy:     optional boolean — superseded by a newer model (#975).
 *                 Still listed and selectable (existing agents use it),
 *                 but the pickers show it grey + italic, after the
 *                 current models. Not the same as `deprecated` (hidden).
 *     price:      optional { in, out } — USD per 1M tokens at list
 *                 price. Only set where the rate is known; costOf()
 *                 returns null for the rest rather than guessing.
 *   }
 *
 * `notes` is the tagline (task #975), one line for a dropdown:
 *   `<strength> — <weakness> · <speed> · <cost tier>`
 * The cost tier is NOT written by hand — `withCostTier()` appends it from
 * the price, so a price change moves the tier.
 *
 * SPEED is from a live chat's point of view: how long until the customer
 * sees the first word, thinking included. Measured 2026-11-12 through our
 * own runtime (runAddon → Talker → services/llm.js, staging keys) on a
 * short question and on a real account-opening judgement turn:
 *   Very fast < 1 s · Fast 1–2.5 s · Medium 2.5–5 s · Slow > 5 s;
 *   "slow to start" = thinks before it answers (adaptive thinking /
 *   reasoning effort), so the first word waits on the thinking.
 * Shlomi's daily-use verdicts win where they differ from one measurement
 * (Sonnet = Medium, Haiku = Fast, Opus = Slow).
 */

// Prices: provider list prices, verified 2026-11-12 (OpenAI's pricing page,
// Anthropic's models overview, Google's Gemini pricing page). Current models
// first within each provider, then the legacy ones.
const MODELS_RAW = [
  // ── Anthropic ──
  { id: 'claude-fable-5-2',  providerId: 'anthropic', name: 'Claude Fable 5.2',  notes: 'Strongest reasoning, for complex code-heavy jobs — overkill for chat · Slow, slow to start', price: { in: 8, out: 40 } },
  { id: 'claude-opus-5-5',   providerId: 'anthropic', name: 'Claude Opus 5.5',   notes: 'Top reasoning — far too slow for a live Talker · Slow, slow to start', price: { in: 4, out: 20 } },
  { id: 'claude-sonnet-5-5', providerId: 'anthropic', name: 'Claude Sonnet 5.5', notes: 'Great Thinker, sharp reasoning — robotic Hebrew as a Talker · Medium', price: { in: 2, out: 10 } },
  // Haiku 5.5: $0.10/$0.50 up to a 100K-token prompt; $0.50/$2.50 above it.
  { id: 'claude-haiku-5-5',  providerId: 'anthropic', name: 'Claude Haiku 5.5',  notes: 'Cheap Claude for extractors and quick steps — lighter reasoning · Fast', price: { in: 0.1, out: 0.5 } },
  { id: 'claude-sonnet-4-6', providerId: 'anthropic', name: 'Claude Sonnet 4.6', notes: 'Default Thinker, solid reasoning — robotic Hebrew as a Talker · Medium', price: { in: 3, out: 15 } },
  { id: 'claude-fable-5-1',  providerId: 'anthropic', name: 'Claude Fable 5.1',  notes: 'Very strong reasoning — replaced by Fable 5.2 (cheaper) · Slow, slow to start', price: { in: 10, out: 50 }, legacy: true },
  { id: 'claude-opus-5',     providerId: 'anthropic', name: 'Claude Opus 5',     notes: 'Top reasoning — replaced by Opus 5.5 (cheaper) · Slow, slow to start', price: { in: 5, out: 25 }, legacy: true },
  { id: 'claude-sonnet-5',   providerId: 'anthropic', name: 'Claude Sonnet 5',   notes: 'Good Thinker — replaced by Sonnet 5.5 · Medium', price: { in: 2, out: 10 }, legacy: true },
  { id: 'claude-opus-4-7',   providerId: 'anthropic', name: 'Claude Opus 4.7',   notes: 'Strong reasoning — replaced by Opus 5.5 (cheaper) · Slow', price: { in: 5, out: 25 }, legacy: true },
  { id: 'claude-haiku-4-5',  providerId: 'anthropic', name: 'Claude Haiku 4.5',  notes: 'Cheap and quick — replaced by Haiku 5.5 (far cheaper) · Fast', price: { in: 1, out: 5 }, legacy: true },

  // ── OpenAI ──
  { id: 'gpt-6.1-terra', providerId: 'openai', name: 'GPT-6.1 Terra', notes: 'Newest balanced GPT, natural writing — thinks before answering · Medium, slow to start', price: { in: 1, out: 5 } },
  { id: 'gpt-6.1-sol',   providerId: 'openai', name: 'GPT-6.1 Sol',   notes: 'Near-Astra reasoning, mid price — thinks first, not for the Talker · Medium, slow to start', price: { in: 2, out: 10 } },
  { id: 'gpt-6-astra',   providerId: 'openai', name: 'GPT-6 Astra',   notes: "OpenAI's top reasoning — thinks first, very expensive · Slow, slow to start", price: { in: 10, out: 50 } },
  { id: 'gpt-6-luna',    providerId: 'openai', name: 'GPT-6 Luna',    notes: 'Cheapest current GPT, fine for extractors — light reasoning · Fast', price: { in: 0.1, out: 0.5 } },
  { id: 'gpt-5.6-terra', providerId: 'openai', name: 'GPT-5.6 Terra', notes: 'Default Talker, good conversation — can sound robotic without strong prompting · Fast', price: { in: 2, out: 12 } },
  { id: 'gpt-4o-mini',   providerId: 'openai', name: 'GPT-4o mini',   notes: 'Default extractor, cheap and instant — old, weak reasoning · Very fast', price: { in: 0.15, out: 0.6 } },
  // `gpt-5.6` is OpenAI's alias for gpt-5.6-sol; kept as the id agents already use.
  { id: 'gpt-5.6',       providerId: 'openai', name: 'GPT-5.6 Sol',   notes: 'Strong all-round — replaced by 6.1 Sol (half the price) · Fast', price: { in: 4, out: 20 }, legacy: true },
  { id: 'gpt-5.6-luna',  providerId: 'openai', name: 'GPT-5.6 Luna',  notes: 'Cheap — replaced by 6 Luna (cheaper) · Fast', price: { in: 0.2, out: 1.2 }, legacy: true },
  { id: 'gpt-5.5',       providerId: 'openai', name: 'GPT-5.5',       notes: 'Strong all-round — older and pricey · Medium', price: { in: 5, out: 30 }, legacy: true },
  { id: 'gpt-4o',        providerId: 'openai', name: 'GPT-4o',        notes: 'Fluent and instant — old, weak reasoning · Very fast', price: { in: 2.5, out: 10 }, legacy: true },
  { id: 'gpt-5.4-mini',  providerId: 'openai', name: 'GPT-5.4 mini',  notes: 'Cheap and instant — replaced by 6 Luna (cheaper) · Very fast', price: { in: 0.75, out: 4.5 }, legacy: true },
  // Hidden from pickers — an old ChatGPT snapshot (Aug 2025), kept so
  // existing agents that reference it keep resolving.
  { id: 'gpt-5-chat-latest', providerId: 'openai', name: 'GPT-5 chat', notes: 'Legacy', deprecated: true },

  // ── Google ──
  // Both deprecated by Google (2026-11): closed to new accounts, and from
  // 2026-12-01 Google routes 2.5 Pro → gemini-3.8-flash and 2.5 Flash →
  // gemini-3.5-flash-lite. Speed not measured on 2026-11-12: the staging
  // Gemini key is out of prepaid credit (402). The successors are NOT added
  // yet — they could not be proven through llm.google.js (see the list of
  // candidates in BUILDER_V2.md #59).
  { id: 'gemini-2.5-pro',   providerId: 'google', name: 'Gemini 2.5 Pro',   notes: 'Long context — Google retires it (closed to new accounts) · Medium, slow to start', price: { in: 1.25, out: 10 }, legacy: true },
  { id: 'gemini-2.5-flash', providerId: 'google', name: 'Gemini 2.5 Flash', notes: 'Cheap — Google retires it (closed to new accounts) · Fast', price: { in: 0.3, out: 2.5 }, legacy: true },
];

/**
 * Cost tier, relative to the models in this list only (task #975). The
 * measure is one typical live-chat model call at list price: 4,000 input
 * tokens (prompt + history + KB) + 300 output tokens. Cut-offs:
 *   $      < $0.0025 a call   (Haiku 5.5, GPT-6 Luna, GPT-4o mini, …)
 *   $$     < $0.009           (GPT-6.1 Terra, Haiku 4.5, Gemini 2.5 Pro, …)
 *   $$$    < $0.018           (Sonnets, GPT-6.1 Sol, GPT-5.6 Terra, GPT-4o)
 *   $$$$   < $0.035           (Opus, GPT-5.6 Sol, GPT-5.5)
 *   $$$$$  ≥ $0.035           (Fable, GPT-6 Astra)
 * Thinking tokens are billed as output, so a think-first model costs more
 * per call than its tier says; the tier compares LIST prices only.
 */
const TIER_CALL = { in: 4000, out: 300 };
const TIER_CUTS = [0.0025, 0.009, 0.018, 0.035];
function costTier(price) {
  if (!price) return null;
  const usd = (TIER_CALL.in / 1e6) * price.in + (TIER_CALL.out / 1e6) * price.out;
  return '$'.repeat(1 + TIER_CUTS.filter(c => usd >= c).length);
}
function withCostTier(m) {
  const tier = costTier(m.price);
  return tier ? { ...m, notes: `${m.notes} · ${tier}` } : m;
}
const MODELS = MODELS_RAW.map(withCostTier);

// `webSearch`: the provider has a built-in web search tool that the Talker /
// Thinker "Web search" switch can turn on (task #967). Google's grounding is
// not wired, so on its models the switch is disabled.
const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', icon: 'A', webSearch: true },
  { id: 'openai',    label: 'OpenAI',    icon: 'O', webSearch: true },
  { id: 'google',    label: 'Google',    icon: 'G', webSearch: false },
];

/**
 * Web searches as a billed line in llm_usage (task #967) — no new column.
 * A turn that searched logs ONE extra row: model = one of these ids,
 * input_tokens 0, output_tokens = the NUMBER OF SEARCHES. The price is per
 * search — $10 per 1,000 at both providers (list price, checked 2026-11-08) —
 * so `out` is $10,000 per "1M" = $0.01 per search, and every reader that
 * prices rows with costOf() / priceOf() gets the search fee right unchanged.
 * The pages the model read are billed as ordinary input tokens on the model's
 * own row. These are NOT models: never offered in a picker, never accepted in
 * a config (getModel() does not know them).
 */
const WEB_SEARCH_USD = 10 / 1000;
const USAGE_ITEMS = [
  { id: 'web-search-openai',    providerId: 'openai',    name: 'Web search (OpenAI)',    kind: 'web_search', price: { in: 0, out: WEB_SEARCH_USD * 1e6 } },
  { id: 'web-search-anthropic', providerId: 'anthropic', name: 'Web search (Anthropic)', kind: 'web_search', price: { in: 0, out: WEB_SEARCH_USD * 1e6 } },
];
const _usageItemById = new Map(USAGE_ITEMS.map(m => [m.id, m]));

/** The llm_usage model id a provider's web searches are logged under. */
function webSearchUsageId(providerId) {
  return `web-search-${providerId}`;
}

/** True for an llm_usage row that counts web searches (output = searches), not tokens. */
function isWebSearchUsage(modelId) {
  return _usageItemById.get(modelId)?.kind === 'web_search';
}

/**
 * The current "everyday" GPT model — a step above the cheapest. The ONE
 * place that says which model that is today; anything that wants "the
 * common model" (e.g. the MCP door's simulated user, task #894) reads
 * this, so it moves when the everyday model changes.
 */
const EVERYDAY_MODEL = 'gpt-5.6-terra';

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
  return _byId.get(modelId)?.providerId || _usageItemById.get(modelId)?.providerId || null;
}

/** Can this model's provider run its built-in web search tool? (#967) */
function supportsWebSearch(modelId) {
  const pid = _byId.get(modelId)?.providerId;
  return !!(pid && PROVIDERS.find(p => p.id === pid)?.webSearch);
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
  const price = priceOf(modelId);
  if (!price) return null;
  return ((inputTokens || 0) / 1e6) * price.in + ((outputTokens || 0) / 1e6) * price.out;
}

/** List price { in, out } per 1M for a model OR a usage item (web search), or null. */
function priceOf(modelId) {
  return _byId.get(modelId)?.price || _usageItemById.get(modelId)?.price || null;
}

/** Display name for an llm_usage model id — a model or a usage item. */
function labelOf(modelId) {
  return _byId.get(modelId)?.name || _usageItemById.get(modelId)?.name || modelId;
}

module.exports = {
  getModel,
  providerOf,
  tryProviderOf,
  costOf,
  priceOf,
  labelOf,
  supportsWebSearch,
  webSearchUsageId,
  isWebSearchUsage,
  WEB_SEARCH_USD,
  listForApi,
  isKnownProvider,
  PROVIDERS,
  MODELS,
  EVERYDAY_MODEL,
};
