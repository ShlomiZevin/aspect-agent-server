/**
 * Model route (task #984) — WHERE an agent's model calls go.
 *
 *   'direct' — our own provider keys, straight to Anthropic / OpenAI /
 *              Google. The default, and byte-for-byte what every agent did
 *              before #984.
 *   'vertex' — the same models, same prompts, same request shapes, but the
 *              SDK client talks to Google Vertex AI in a Google Cloud
 *              project (a bank may require that every model call stays in
 *              Google Cloud). Auth = Application Default Credentials (on
 *              Cloud Run: the service account, which needs
 *              roles/aiplatform.user); no API keys on this route.
 *
 * The route is a per-agent setting (`agentBody.modelRoute`), passed
 * EXPLICITLY down every call made on the agent's behalf as the llm option
 * `modelRoute` — no hidden lookups. llm.js checks it before any provider
 * call; the provider files pick their client from it.
 *
 * Rules (Shlomi, 2026-11-17):
 *   - NO fallback. With route 'vertex' a call never goes to a direct API —
 *     not on an error, not on missing config, not for web search. Every
 *     such case throws a ModelRouteError (code 'model_route') naming what
 *     is wrong, and the add-on fails loudly.
 *   - A Vertex agent may only use models that exist on Vertex
 *     (`vertex` on each model in services/models.service.js).
 *   - Knowledge-base embeddings (kb.embedding.service.js) and transcription
 *     stay direct for now — see BUILDER_V2.md #60.
 *
 * Environment (per environment; later a bank's own project):
 *   VERTEX_PROJECT_ID   the Google Cloud project that runs the calls (required for 'vertex')
 *   VERTEX_LOCATION     Vertex location for Claude + Gemini, default 'global'.
 *                       OpenAI models on Vertex are served from 'global' only.
 */

const modelsService = require('./models.service');

const ROUTES = ['direct', 'vertex'];
const DEFAULT_LOCATION = 'global';
/** OpenAI models on Vertex exist on the global endpoint only (private preview, 2026-11). */
const OPENAI_LOCATION = 'global';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

class ModelRouteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelRouteError';
    this.code = 'model_route';
    // Not a provider error: never retried, never "fixed" by trying again.
    this.status = null;
  }
}

/** Anything that isn't exactly 'vertex' is Direct (absent = Direct). */
function normalize(route) {
  return route === 'vertex' ? 'vertex' : 'direct';
}

/** The route an agent body asks for. */
function routeOfAgentBody(body) {
  return normalize(body && body.modelRoute);
}

/** Is this route Vertex? (the only non-default) */
function isVertex(route) {
  return normalize(route) === 'vertex';
}

/**
 * The Vertex project + location for this environment. Throws (loudly) when
 * the project is not configured — a Vertex agent must never run direct
 * because a setting is missing.
 */
function vertexConfig() {
  const projectId = String(process.env.VERTEX_PROJECT_ID || '').trim();
  const location = String(process.env.VERTEX_LOCATION || '').trim() || DEFAULT_LOCATION;
  if (!projectId) {
    throw new ModelRouteError(
      'This agent\'s model route is Vertex, but VERTEX_PROJECT_ID is not set on this server, so the call was not made '
      + '(it never falls back to the direct API). Set VERTEX_PROJECT_ID (and optionally VERTEX_LOCATION, default "global") '
      + 'in this environment, or switch the agent to Direct.',
    );
  }
  return { projectId, location };
}

/** True when the model exists on Vertex AI. Unknown models are not. */
function onVertex(modelId) {
  const m = modelsService.getModel(modelId);
  return !!(m && m.vertex);
}

/**
 * Throw unless the model can run on Vertex. The message names the model
 * so the author knows which add-on to change.
 */
function assertVertexModel(modelId) {
  if (onVertex(modelId)) return;
  const m = modelsService.getModel(modelId);
  const name = m ? `${m.name} (${modelId})` : `"${modelId || 'no model'}"`;
  throw new ModelRouteError(
    `Model ${name} is not available on Vertex AI, and this agent's model route is Vertex — the call was not made `
    + '(it never falls back to the direct API). Pick a Vertex model for this add-on, or switch the agent to Direct.',
  );
}

/** The id Vertex knows the model by (same as ours unless the registry says otherwise). */
function vertexModelId(modelId) {
  const m = modelsService.getModel(modelId);
  return (m && m.vertex && m.vertexId) || modelId;
}

/**
 * A model call that is not possible on Vertex (a feature Vertex lacks).
 * Thrown by the provider files before any request is sent.
 */
function unsupported(what) {
  return new ModelRouteError(
    `${what} is not available on Vertex AI, and this agent's model route is Vertex — the call was not made `
    + '(it never falls back to the direct API). Turn that option off for this add-on, or switch the agent to Direct.',
  );
}

/** Base URL of the OpenAI-compatible Responses endpoint for OpenAI models on Vertex. */
function openaiBaseURL(projectId) {
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`
    + `/locations/${OPENAI_LOCATION}/publishers/openai/v1`;
}

let _auth = null;
/**
 * A Google access token from Application Default Credentials. The
 * library caches the token and refreshes it before it expires (~1 h), so
 * calling this per model call is cheap and never hands out a stale token.
 */
async function googleAccessToken() {
  if (!_auth) {
    const { GoogleAuth } = require('google-auth-library');
    _auth = new GoogleAuth({ scopes: [GOOGLE_SCOPE] });
  }
  let token;
  try {
    token = await _auth.getAccessToken();
  } catch (err) {
    throw new ModelRouteError(
      `This agent's model route is Vertex, but no Google credentials could be loaded (${err.message}). `
      + 'On Cloud Run the service account needs roles/aiplatform.user; locally run `gcloud auth application-default login`. '
      + 'The call was not made (it never falls back to the direct API).',
    );
  }
  if (!token) {
    throw new ModelRouteError('This agent\'s model route is Vertex, but Google returned no access token. The call was not made.');
  }
  return token;
}

/**
 * Usage logging: the provider column carries the route for Vertex calls
 * ('anthropic@vertex', 'openai@vertex', 'google@vertex'); Direct rows keep
 * the plain provider exactly as before. No schema change.
 */
const VERTEX_SUFFIX = '@vertex';
function usageProvider(providerId, route) {
  return isVertex(route) && providerId ? `${providerId}${VERTEX_SUFFIX}` : providerId;
}
/** The route an llm_usage `provider` value records. */
function routeOfUsageProvider(provider) {
  return typeof provider === 'string' && provider.endsWith(VERTEX_SUFFIX) ? 'vertex' : 'direct';
}

// ─── What in an agent cannot run on Vertex ─────────────────────────

const SECTION_LABELS = { cortex: 'Agent level', liveBrain: 'Live Brain', profiler: 'Profiler', ask: 'Ask Profiler', trigger: 'KB trigger', query: 'KB query' };

/** 'field-extractor' → 'Field Extractor' — for an add-on with no name. */
function pluginLabel(id) {
  return String(id || 'add-on').split('-').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * Everything in an agent that would FAIL on the Vertex route — the list the
 * Builder and the MCP show before/after switching:
 *   reason 'model'      — a model that is not available on Vertex;
 *   reason 'web_search' — an add-on with Web search on, on an OpenAI model
 *                         (hosted web search does not exist on Vertex;
 *                         Claude's basic web search does).
 * Walks the whole agent (agent body + every crew body) for model references
 * (`{ providerId, modelId }`), so nested ones count too (KB Retriever's
 * trigger/query models, Live Brain / Profiler panels, Ask Profiler).
 *
 * @param {object} agentBody — agent body (or AgentDoc)
 * @param {Array<object>} [crews] — crew bodies (or CrewDocs / { body })
 * @returns {Array<{ reason: 'model'|'web_search', where: string, crew: string|null,
 *                   addon: string|null, modelId: string, modelName: string }>}
 */
function vertexProblems(agentBody, crews = []) {
  const out = [];
  const seen = new Set();
  const add = (reason, where, crew, addon, modelId) => {
    const key = `${reason}|${where}|${modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const m = modelsService.getModel(modelId);
    out.push({ reason, where, crew, addon: addon || null, modelId, modelName: m ? m.name : modelId });
  };
  const walk = (node, trail, crew, addonLabel) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, trail, crew, addonLabel)); return; }
    let label = addonLabel;
    let t = trail;
    if (typeof node.pluginId === 'string') {
      label = String((node.config && node.config.name) || node.name || pluginLabel(node.pluginId)).trim() || pluginLabel(node.pluginId);
      t = [...trail, label];
      const mid = node.config && node.config.model && node.config.model.modelId;
      if (node.config && node.config.webSearch && node.config.webSearch.enabled
          && typeof mid === 'string' && modelsService.tryProviderOf(mid) === 'openai') {
        add('web_search', t.join(' · '), crew, label, mid);
      }
    } else if (typeof node.title === 'string' && node.title.trim()) {
      t = [...trail, node.title.trim()];
    }
    if (typeof node.modelId === 'string' && node.modelId && !onVertex(node.modelId)) {
      add('model', t.join(' · ') || 'Agent', crew, label, node.modelId);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'versions' || k === 'crews' || !v || typeof v !== 'object') continue;
      walk(v, SECTION_LABELS[k] && typeof v.pluginId !== 'string' ? [...t, SECTION_LABELS[k]] : t, crew, label);
    }
  };
  if (agentBody) walk({ ...agentBody, crews: undefined, versions: undefined }, [], null, null);
  for (const c of Array.isArray(crews) ? crews : []) {
    const body = (c && c.body) || c || {};
    const name = String(body.name || (c && c.name) || 'crew').trim() || 'crew';
    walk({ ...body, crews: undefined, versions: undefined }, [`Crew "${name}"`], name, null);
  }
  return out;
}

/** One line per problem, for logs / the MCP. */
function describeProblem(p) {
  return p.reason === 'web_search'
    ? `${p.where} — Web search on ${p.modelName}: OpenAI web search does not exist on Vertex (turn it off, or use a Claude model)`
    : `${p.where} — ${p.modelName} (${p.modelId}) is not on Vertex`;
}

module.exports = {
  ROUTES,
  DEFAULT_LOCATION,
  OPENAI_LOCATION,
  ModelRouteError,
  normalize,
  routeOfAgentBody,
  isVertex,
  vertexConfig,
  onVertex,
  assertVertexModel,
  vertexModelId,
  unsupported,
  openaiBaseURL,
  googleAccessToken,
  usageProvider,
  routeOfUsageProvider,
  vertexProblems,
  describeProblem,
  // tests only
  _resetAuth() { _auth = null; },
};
