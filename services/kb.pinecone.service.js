/**
 * KB Pinecone Service
 *
 * Manages vector storage in Pinecone: indexing, deletion, querying.
 * Uses a single index with namespaces per knowledge base.
 */

const { Pinecone } = require('@pinecone-database/pinecone');
const embeddingService = require('./kb.embedding.service');

const UPSERT_BATCH_SIZE = 100; // Pinecone max vectors per upsert

let pineconeClient = null;
let pineconeIndex = null;

/**
 * Get or create the Pinecone client (without requiring an index).
 */
function getClient() {
  if (pineconeClient) return pineconeClient;
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) throw new Error('PINECONE_API_KEY not set in environment variables');
  pineconeClient = new Pinecone({ apiKey });
  return pineconeClient;
}

/**
 * Initialize the Pinecone client and index reference.
 */
function init() {
  if (pineconeIndex) return;

  const client = getClient();
  const indexName = process.env.PINECONE_INDEX_NAME;
  if (!indexName) throw new Error('PINECONE_INDEX_NAME not set');

  pineconeIndex = client.index(indexName);
  console.log(`✅ Pinecone initialized: index="${indexName}"`);
}

/**
 * Check if Pinecone is configured (API key present).
 * @returns {{ configured: boolean, hasApiKey: boolean, indexName: string|null }}
 */
function getConnectionStatus() {
  return {
    configured: !!process.env.PINECONE_API_KEY && !!process.env.PINECONE_INDEX_NAME,
    hasApiKey: !!process.env.PINECONE_API_KEY,
    indexName: process.env.PINECONE_INDEX_NAME || null,
  };
}

/**
 * List all indexes in the Pinecone account.
 * @returns {Promise<Array<{ name: string, dimension: number, metric: string, host: string, status: string }>>}
 */
async function listIndexes() {
  const client = getClient();
  const response = await client.listIndexes();
  // Get detailed info for each index
  const indexes = [];
  for (const idx of (response.indexes || [])) {
    try {
      const detail = await client.describeIndex(idx.name);
      indexes.push({
        name: idx.name,
        dimension: detail.dimension,
        metric: detail.metric,
        host: detail.host,
        status: detail.status?.ready ? 'ready' : detail.status?.state || 'unknown',
        cloud: detail.spec?.serverless?.cloud || 'unknown',
        region: detail.spec?.serverless?.region || 'unknown',
      });
    } catch {
      indexes.push({
        name: idx.name,
        dimension: idx.dimension,
        metric: idx.metric,
        host: idx.host,
        status: 'unknown',
        cloud: 'unknown',
        region: 'unknown',
      });
    }
  }
  return indexes;
}

/**
 * Create a new serverless Pinecone index.
 * @param {string} name - Index name
 * @param {number} [dimension=1536] - Vector dimensions
 * @param {string} [metric='cosine'] - Distance metric
 * @param {string} [cloud='aws'] - Cloud provider
 * @param {string} [region='us-east-1'] - Cloud region
 * @returns {Promise<Object>}
 */
async function createIndex(name, dimension = 1536, metric = 'cosine', cloud = 'aws', region = 'us-east-1') {
  const client = getClient();
  const result = await client.createIndex({
    name,
    dimension,
    metric,
    spec: {
      serverless: { cloud, region },
    },
    waitUntilReady: true,
  });
  console.log(`✅ Created Pinecone index "${name}" (${dimension}d, ${metric})`);
  return result;
}

/**
 * Delete a Pinecone index.
 * @param {string} name - Index name
 * @returns {Promise<void>}
 */
async function deleteIndex(name) {
  const client = getClient();
  await client.deleteIndex(name);
  // Reset cached index ref if we deleted the active one
  if (name === process.env.PINECONE_INDEX_NAME) {
    pineconeIndex = null;
  }
  console.log(`🗑️ Deleted Pinecone index "${name}"`);
}

/**
 * Switch the active index (updates the cached reference).
 * @param {string} indexName
 */
function setActiveIndex(indexName) {
  const client = getClient();
  pineconeIndex = client.index(indexName);
  process.env.PINECONE_INDEX_NAME = indexName;
  console.log(`🔄 Switched active index to "${indexName}"`);
}

/**
 * Get the namespace string for a knowledge base.
 * @param {number} kbId
 * @returns {string}
 */
function getNamespace(kbId) {
  return `kb-${kbId}`;
}

/**
 * Index a file's chunks into Pinecone.
 * @param {Object} params
 * @param {number} params.kbId - Knowledge base ID
 * @param {number} params.fileId - Database file ID
 * @param {string} params.fileName - Original file name
 * @param {string} params.fileType - File extension
 * @param {number} params.agentId - Agent ID
 * @param {Array<{ text: string, chunkIndex: number }>} params.chunks - Chunks from the chunker
 * @param {number[][]} params.embeddings - Embedding vectors matching chunks
 * @returns {Promise<{ vectorCount: number, namespace: string }>}
 */
async function indexFile({ kbId, namespace: nsOverride, fileId, fileName, fileType, agentId, chunks, embeddings }) {
  init();
  const namespace = nsOverride || getNamespace(kbId);

  // Nothing to index (e.g. a scanned PDF with no text layer). Skip the
  // upsert — Pinecone rejects an empty batch with a cryptic error.
  if (!chunks || chunks.length === 0 || !embeddings || embeddings.length === 0) {
    console.warn(`⚠️ indexFile: no chunks for "${fileName}" — skipping upsert`);
    return { vectorCount: 0, namespace };
  }

  const nsObj = namespace === '__default__' ? pineconeIndex.namespace('') : pineconeIndex.namespace(namespace);

  const vectors = chunks.map((chunk, i) => ({
    id: `file-${fileId}-chunk-${chunk.chunkIndex}`,
    values: embeddings[i],
    metadata: {
      kbId: kbId || 0,
      namespace,
      fileId,
      fileName,
      fileType: fileType || fileName.split('.').pop().toLowerCase(),
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunks.length,
      agentId: agentId || 0,
      text: chunk.text.substring(0, 40000), // Pinecone metadata limit ~40KB
    },
  }));

  // Upsert in batches. Pinecone SDK v7 takes an options object
  // ({ records }) — older versions accepted a bare array.
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
    await nsObj.upsert({ records: batch });
  }

  console.log(`📌 Indexed ${vectors.length} vectors for file "${fileName}" in namespace "${namespace}"`);
  return { vectorCount: vectors.length, namespace };
}

/**
 * Delete all vectors for a specific file.
 * @param {string|number} namespaceOrKbId - Namespace name or KB ID
 * @param {number} fileId
 * @returns {Promise<void>}
 */
async function deleteFile(namespaceOrKbId, fileId) {
  init();
  const nsName = typeof namespaceOrKbId === 'number' ? getNamespace(namespaceOrKbId) : namespaceOrKbId;
  const ns = nsName === '__default__' ? pineconeIndex.namespace('') : pineconeIndex.namespace(nsName);

  // SDK v7: delete-by-metadata needs a `filter` wrapper (bare `{ fileId }`
  // throws "Either `ids` or `filter` must be provided").
  await ns.deleteMany({ filter: { fileId } });
  console.log(`🗑️ Deleted vectors for file ${fileId} from namespace "${nsName}"`);
}

/**
 * Delete an entire namespace (all vectors for a KB).
 * @param {number} kbId
 * @returns {Promise<void>}
 */
async function deleteNamespace(kbId) {
  init();
  const namespace = getNamespace(kbId);
  const ns = pineconeIndex.namespace(namespace);
  await ns.deleteAll();
  console.log(`🗑️ Deleted entire namespace "${namespace}"`);
}

/**
 * Delete an entire namespace by its RAW name (free-form KB names like
 * "lybi-kb", not the `kb-{id}` convention). Used by the V2 KB
 * workbench's "delete knowledge base" action.
 * @param {string} namespace
 * @returns {Promise<void>}
 */
async function deleteNamespaceByName(namespace) {
  init();
  const ns = namespace === '__default__' ? pineconeIndex.namespace('') : pineconeIndex.namespace(namespace);
  await ns.deleteAll();
  console.log(`🗑️ Deleted entire namespace "${namespace}"`);
}

/**
 * Get index-level stats (total vectors, namespace breakdown).
 * @returns {Promise<Object>}
 */
async function getIndexStats() {
  init();
  const stats = await pineconeIndex.describeIndexStats();
  return {
    totalVectorCount: stats.totalRecordCount,
    dimension: stats.dimension,
    namespaces: Object.entries(stats.namespaces || {}).map(([name, data]) => ({
      name,
      vectorCount: data.recordCount,
    })),
  };
}

/**
 * List vectors in a namespace (with metadata). Uses query with a random vector
 * (random gives better distribution of results than a zero vector).
 * @param {string} namespace - The namespace name (e.g. 'kb-1' or '__default__')
 * @param {Object} [options]
 * @param {number} [options.fileId] - Filter by file ID
 * @param {number} [options.limit=100] - Max vectors to return
 * @returns {Promise<Array<{ id: string, metadata: Object, score: number }>>}
 */
async function listVectors(namespace, options = {}) {
  init();
  // Support both namespace string and legacy kbId number
  const nsName = typeof namespace === 'number' ? getNamespace(namespace) : namespace;
  const ns = nsName === '__default__' ? pineconeIndex.namespace('') : pineconeIndex.namespace(nsName);
  const { fileId, limit = 100 } = options;

  const filter = {};
  if (fileId !== undefined) filter.fileId = fileId;

  // Use a random unit vector for better result distribution
  const dim = embeddingService.EMBEDDING_DIMENSIONS;
  const randomVec = Array.from({ length: dim }, () => Math.random() - 0.5);
  const norm = Math.sqrt(randomVec.reduce((s, v) => s + v * v, 0));
  const queryVector = randomVec.map(v => v / norm);

  const result = await ns.query({
    vector: queryVector,
    topK: limit,
    includeMetadata: true,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  });

  return (result.matches || []).map(m => ({
    id: m.id,
    metadata: m.metadata,
    score: m.score,
  }));
}

/**
 * Query Pinecone for relevant chunks across one or more namespaces.
 * @param {string[]} namespaces - Namespace names to search (e.g. ['kb-1', '__default__'])
 * @param {string} queryText - User query
 * @param {Object} [options]
 * @param {number} [options.topK=5] - Number of results per namespace
 * @param {number} [options.scoreThreshold=0.3] - Minimum similarity score
 * @param {number} [options.maxTokens=3000] - Max total tokens in results
 * @returns {Promise<{ results: Array, queryTimeMs: number, totalResults: number }>}
 */
async function query(namespaces, queryText, options = {}) {
  init();
  const { topK = 5, scoreThreshold = 0.3, maxTokens = 3000 } = options;
  const startTime = Date.now();

  // Query each namespace (may use different embedding models)
  const allResults = [];
  for (const nsInput of namespaces) {
    let nsName;
    if (typeof nsInput === 'number') {
      nsName = getNamespace(nsInput);
    } else if (/^\d+$/.test(nsInput)) {
      nsName = getNamespace(parseInt(nsInput));
    } else {
      nsName = nsInput;
    }

    // Embed with the right model for this namespace
    const { embedding, model: usedModel } = await embeddingService.embedQuery(queryText, { namespace: nsName });
    const ns = nsName === '__default__' ? pineconeIndex.namespace('') : pineconeIndex.namespace(nsName);

    const result = await ns.query({
      vector: embedding,
      topK,
      includeMetadata: true,
    });

    for (const match of (result.matches || [])) {
      if (match.score >= scoreThreshold) {
        allResults.push({
          text: match.metadata.text || match.metadata.chunkText || '',
          score: match.score,
          fileName: match.metadata.fileName || match.metadata.source || match.metadata.sourceArticle || match.id,
          chunkIndex: match.metadata.chunkIndex ?? 0,
          fileId: match.metadata.fileId ?? 0,
          kbId: match.metadata.kbId ?? 0,
          fileType: match.metadata.fileType || '',
          namespace: nsName,
        });
      }
    }
  }

  // Sort by score descending
  allResults.sort((a, b) => b.score - a.score);

  // Truncate to maxTokens (rough: 4 chars per token)
  let tokenCount = 0;
  const truncated = [];
  for (const r of allResults) {
    const chunkTokens = Math.ceil(r.text.length / 4);
    if (tokenCount + chunkTokens > maxTokens && truncated.length > 0) break;
    truncated.push(r);
    tokenCount += chunkTokens;
  }

  return {
    results: truncated,
    queryTimeMs: Date.now() - startTime,
    totalResults: allResults.length,
    tokensUsed: tokenCount,
  };
}

/**
 * Format query results into a prompt section for LLM injection.
 * @param {Array<{ text: string, score: number, fileName: string }>} results
 * @returns {string}
 */
function formatForPrompt(results) {
  if (!results.length) return '';

  const sections = results.map(r =>
    `### From: ${r.fileName} (relevance: ${r.score.toFixed(2)})\n${r.text}`
  );

  return `## Relevant Knowledge Base Content\nThe following excerpts are from your knowledge base. Use them to inform your response.\n\n${sections.join('\n\n')}`;
}

module.exports = {
  init,
  getConnectionStatus,
  listIndexes,
  createIndex,
  deleteIndex,
  setActiveIndex,
  getNamespace,
  indexFile,
  deleteFile,
  deleteNamespace,
  deleteNamespaceByName,
  getIndexStats,
  listVectors,
  query,
  formatForPrompt,
};
