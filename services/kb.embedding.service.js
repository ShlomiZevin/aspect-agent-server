/**
 * KB Embedding Service
 *
 * Generates embeddings using OpenAI's text-embedding-3-small model.
 * Handles batching for large sets of chunks.
 */

const OpenAI = require('openai');

// Default model for all new data
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const MAX_BATCH_SIZE = 2048;
const COST_PER_MILLION_TOKENS = 0.02;

// Legacy model for querying old data (embedded with ada-002 via LangChain)
const LEGACY_MODEL = 'text-embedding-ada-002';
const LEGACY_DIMENSIONS = 1536;

// Namespaces that were embedded with the legacy model
const LEGACY_NAMESPACES = new Set(['__default__']);

let openaiClient = null;

function getClient() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * Check if a namespace uses the legacy embedding model.
 * @param {string} namespace
 * @returns {boolean}
 */
function isLegacyNamespace(namespace) {
  return LEGACY_NAMESPACES.has(namespace);
}

/**
 * Embed a list of text chunks (always uses the new model for indexing).
 * @param {string[]} texts
 * @returns {Promise<{ embeddings: number[][], totalTokens: number, cost: number }>}
 */
async function embedTexts(texts) {
  if (!texts.length) return { embeddings: [], totalTokens: 0, cost: 0 };

  const client = getClient();
  const allEmbeddings = [];
  let totalTokens = 0;

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    for (const item of response.data) {
      allEmbeddings.push(item.embedding);
    }
    totalTokens += response.usage.total_tokens;
  }

  return {
    embeddings: allEmbeddings,
    totalTokens,
    cost: (totalTokens / 1_000_000) * COST_PER_MILLION_TOKENS,
  };
}

/**
 * Embed a single query text for similarity search.
 * Automatically picks the right model based on the target namespace.
 * @param {string} text
 * @param {Object} [options]
 * @param {string} [options.namespace] - Target namespace (determines model)
 * @returns {Promise<{ embedding: number[], tokens: number, model: string }>}
 */
async function embedQuery(text, options = {}) {
  const client = getClient();
  const useLegacy = options.namespace && isLegacyNamespace(options.namespace);
  const model = useLegacy ? LEGACY_MODEL : EMBEDDING_MODEL;
  const dimensions = useLegacy ? LEGACY_DIMENSIONS : EMBEDDING_DIMENSIONS;

  const params = { model, input: text };
  // ada-002 doesn't support the dimensions parameter
  if (!useLegacy) params.dimensions = dimensions;

  const response = await client.embeddings.create(params);

  return {
    embedding: response.data[0].embedding,
    tokens: response.usage.total_tokens,
    model,
  };
}

/**
 * Estimate embedding cost for a set of texts without calling the API.
 * @param {string[]} texts
 * @returns {{ estimatedTokens: number, estimatedCost: number }}
 */
function estimateCost(texts) {
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 4);
  return {
    estimatedTokens,
    estimatedCost: (estimatedTokens / 1_000_000) * COST_PER_MILLION_TOKENS,
  };
}

module.exports = {
  embedTexts,
  embedQuery,
  estimateCost,
  isLegacyNamespace,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  LEGACY_MODEL,
  LEGACY_NAMESPACES,
  COST_PER_MILLION_TOKENS,
};
