/**
 * The knowledge-base vector store — pgvector in this environment's own
 * Postgres (board #1014, 2026-11-27). The ONE module that reads or writes
 * knowledge-base vectors: the KB library screen and its endpoints, the
 * Builder MCP, the KB Retriever add-on, the agent copy, Alfred's KB readers
 * and Lybi HQ all come through here.
 *
 * Table: kb_vectors (migrations 073 + 075). A KB is a NAMESPACE; a vector is
 * one chunk of one file: (namespace, id = 'file-<fileId>-chunk-<n>'). Each
 * row keeps the embedding model it was made with, and a search compares only
 * rows of the model the namespace's queries are embedded with
 * (kb.embedding.service decides per namespace).
 *
 * Until 2026-11 the vectors lived in ONE Pinecone index shared by every
 * environment. Each environment now holds its own; scripts/kb-copy-from-pinecone.js
 * moved them once. Nothing here talks to Pinecone.
 *
 * Search = exact-metric cosine over an HNSW index (`<=>`), score = 1 − cosine
 * distance — the same number Pinecone's cosine index returned. The database
 * runs HNSW with iterative scan (075), so a search filtered to one KB still
 * returns a full top K.
 */

const db = require('./db.pg');
const embeddingService = require('./kb.embedding.service');

/**
 * library_files.index_name / kb_links.index_name are from the Pinecone era
 * (the index a KB lived in). One environment = one database = one library,
 * so it is this one constant everywhere (075 folded other names into it).
 * Every reader and writer of those two tables uses it.
 */
const KB_LIBRARY = 'lybi';
const DIMENSIONS = embeddingService.EMBEDDING_DIMENSIONS; // 1536 — the column's size
const INSERT_BATCH = 100;

class KbStoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** "relation kb_vectors does not exist" → what to do about it. */
function explain(err) {
  if (err && err.code === '42P01') {
    return new KbStoreError(503, 'The knowledge store is not set up in this environment (run migration 075).');
  }
  return err;
}

/** Run fn(client) in one transaction on a pooled client. */
async function inTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw explain(err);
  } finally {
    client.release();
  }
}

async function q(sql, params, client = db) {
  try {
    return await client.query(sql, params);
  } catch (err) {
    throw explain(err);
  }
}

/** Legacy callers name a KB by number (`kb-<id>`); everything else by name. */
function getNamespace(kbId) {
  return `kb-${kbId}`;
}
function nsOf(namespaceOrKbId) {
  if (typeof namespaceOrKbId === 'number') return getNamespace(namespaceOrKbId);
  const s = String(namespaceOrKbId);
  return /^\d+$/.test(s) ? getNamespace(parseInt(s, 10)) : s;
}

const toVec = values => `[${values.join(',')}]`;
/** A file id back in the type it was given: numbers for library files, 'atom-<id>' for HQ. */
const fileIdOut = v => (v == null ? 0 : /^\d+$/.test(v) ? Number(v) : v);

/**
 * Is the store usable here? (the table exists). No external service, so this
 * is the whole "connection".
 * @returns {Promise<{ configured: boolean, store: 'pgvector', library: string, error?: string }>}
 */
async function getStatus() {
  try {
    await db.query('SELECT 1 FROM kb_vectors LIMIT 1');
    return { configured: true, store: 'pgvector', library: KB_LIBRARY };
  } catch (err) {
    return { configured: false, store: 'pgvector', library: KB_LIBRARY, error: explain(err).message };
  }
}

/**
 * Write rows into kb_vectors through `client` (anything with .query — a pool,
 * or a transaction's client). Batched multi-row inserts.
 * rows: { namespace, id, embeddingModel, embedding:number[], text, fileName, fileId, chunkIndex, metadata }
 * onConflict: 'replace' (the new row wins) | 'skip' (keep what is there).
 * @returns {Promise<number>} rows written
 */
async function insertVectors(client, rows, { onConflict = 'replace' } = {}) {
  let written = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const params = [];
    const tuples = batch.map(r => {
      if (!Array.isArray(r.embedding) || r.embedding.length !== DIMENSIONS) {
        throw new KbStoreError(400, `vector ${r.id} has ${r.embedding?.length} dimensions; the store holds ${DIMENSIONS}`);
      }
      params.push(r.namespace, r.id, r.embeddingModel, toVec(r.embedding), String(r.text || ''),
        r.fileName ?? null, r.fileId == null ? null : String(r.fileId),
        Number.isFinite(Number(r.chunkIndex)) ? Number(r.chunkIndex) : null,
        r.metadata ? JSON.stringify(r.metadata) : null);
      const b = params.length - 9;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::vector, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}::jsonb)`;
    });
    const conflict = onConflict === 'skip'
      ? 'ON CONFLICT (namespace, id) DO NOTHING'
      : `ON CONFLICT (namespace, id) DO UPDATE SET embedding_model = EXCLUDED.embedding_model, embedding = EXCLUDED.embedding,
           text = EXCLUDED.text, file_name = EXCLUDED.file_name, file_id = EXCLUDED.file_id,
           chunk_index = EXCLUDED.chunk_index, metadata = EXCLUDED.metadata, created_at = EXCLUDED.created_at`;
    const res = await q(
      `INSERT INTO kb_vectors (namespace, id, embedding_model, embedding, text, file_name, file_id, chunk_index, metadata)
       VALUES ${tuples.join(', ')} ${conflict}`, params, client);
    written += res.rowCount;
  }
  return written;
}

/**
 * Index one file's chunks into a KB. Replaces the file: its previous chunks
 * (same namespace + file id) are removed in the same transaction, so a
 * re-index never leaves stale chunks behind.
 * @returns {Promise<{ vectorCount: number, namespace: string }>}
 */
async function indexFile({ kbId, namespace: nsOverride, fileId, fileName, fileType, agentId, chunks, embeddings,
  embeddingModel = embeddingService.EMBEDDING_MODEL }) {
  const namespace = nsOverride || getNamespace(kbId);
  if (!chunks || chunks.length === 0 || !embeddings || embeddings.length === 0) {
    console.warn(`⚠️ indexFile: no chunks for "${fileName}" — nothing indexed`);
    return { vectorCount: 0, namespace };
  }
  if (chunks.length !== embeddings.length) {
    throw new KbStoreError(400, `${chunks.length} chunks but ${embeddings.length} embeddings for "${fileName}"`);
  }
  const type = fileType || String(fileName).split('.').pop().toLowerCase();
  const rows = chunks.map((chunk, i) => ({
    namespace,
    id: `file-${fileId}-chunk-${chunk.chunkIndex}`,
    embeddingModel,
    embedding: embeddings[i],
    text: chunk.text,
    fileName,
    fileId,
    chunkIndex: chunk.chunkIndex,
    metadata: { kbId: kbId || 0, fileType: type, totalChunks: chunks.length, agentId: agentId || 0 },
  }));
  await inTransaction(async client => {
    await q('DELETE FROM kb_vectors WHERE namespace = $1 AND file_id = $2', [namespace, String(fileId)], client);
    await insertVectors(client, rows, { onConflict: 'replace' });
  });
  console.log(`📌 Indexed ${rows.length} vectors for file "${fileName}" in KB "${namespace}"`);
  return { vectorCount: rows.length, namespace };
}

/** Remove one file's vectors. @returns {Promise<number>} vectors removed */
async function deleteFile(namespaceOrKbId, fileId, client = db) {
  const namespace = nsOf(namespaceOrKbId);
  const res = await q('DELETE FROM kb_vectors WHERE namespace = $1 AND file_id = $2', [namespace, String(fileId)], client);
  console.log(`🗑️ Deleted ${res.rowCount} vectors of file ${fileId} from KB "${namespace}"`);
  return res.rowCount;
}

/** Remove a whole KB's vectors, by its name. @returns {Promise<number>} */
async function deleteNamespaceByName(namespace, client = db) {
  const res = await q('DELETE FROM kb_vectors WHERE namespace = $1', [namespace], client);
  console.log(`🗑️ Deleted KB "${namespace}" (${res.rowCount} vectors)`);
  return res.rowCount;
}

/** Remove a legacy numbered KB (`kb-<id>`). */
async function deleteNamespace(kbId) {
  return deleteNamespaceByName(getNamespace(kbId));
}

/**
 * Every KB with its chunk count.
 * @returns {Promise<{ totalVectorCount: number, dimension: number, namespaces: Array<{ name: string, vectorCount: number }> }>}
 */
async function getStats() {
  const { rows } = await q('SELECT namespace, count(*)::int AS n FROM kb_vectors GROUP BY namespace ORDER BY namespace');
  return {
    totalVectorCount: rows.reduce((s, r) => s + r.n, 0),
    dimension: DIMENSIONS,
    namespaces: rows.map(r => ({ name: r.namespace, vectorCount: r.n })),
  };
}

/** True when the KB holds at least one chunk. */
async function namespaceExists(namespace) {
  const { rows } = await q('SELECT 1 FROM kb_vectors WHERE namespace = $1 LIMIT 1', [namespace]);
  return rows.length > 0;
}

/** One row as the callers have always seen a vector's metadata. */
function metadataOf(r) {
  return {
    ...(r.metadata || {}),
    namespace: r.namespace,
    fileId: fileIdOut(r.file_id),
    fileName: r.file_name || '',
    chunkIndex: r.chunk_index ?? 0,
    text: r.text || '',
  };
}

/**
 * A KB's chunks with metadata, in file / chunk order (a file's text, chunk by
 * chunk, when `fileId` is given).
 * @returns {Promise<Array<{ id: string, metadata: Object, score: null }>>}
 */
async function listVectors(namespaceOrKbId, { fileId, limit = 100 } = {}) {
  const namespace = nsOf(namespaceOrKbId);
  const params = [namespace, Math.max(1, Math.min(10000, parseInt(limit, 10) || 100))];
  let where = 'namespace = $1';
  if (fileId !== undefined && fileId !== null) { params.push(String(fileId)); where += ' AND file_id = $3'; }
  const { rows } = await q(
    `SELECT namespace, id, text, file_name, file_id, chunk_index, metadata FROM kb_vectors
      WHERE ${where} ORDER BY file_id, chunk_index, id LIMIT $2`, params);
  return rows.map(r => ({ id: r.id, metadata: metadataOf(r), score: null }));
}

/**
 * Search one or more KBs.
 * @param {Array<string|number>} namespaces
 * @param {string} queryText
 * @param {Object} [options]
 * @param {number} [options.topK=5]            results per KB
 * @param {number} [options.scoreThreshold=0.3]
 * @param {number} [options.maxTokens=3000]    budget for the joined results (≈ 4 chars a token)
 * @param {number[]} [options.embedding]       a query vector already made with the KB's model
 * @returns {Promise<{ results: Array, queryTimeMs: number, totalResults: number, tokensUsed: number }>}
 */
async function query(namespaces, queryText, options = {}) {
  const { topK = 5, scoreThreshold = 0.3, maxTokens = 3000, embedding: givenEmbedding } = options;
  const k = Math.max(1, Math.min(100, parseInt(topK, 10) || 5));
  const startTime = Date.now();

  const allResults = [];
  for (const nsInput of namespaces) {
    const nsName = nsOf(nsInput);
    // Embed with the model this KB's queries use (one call per KB — KBs may differ).
    const made = givenEmbedding
      ? { embedding: givenEmbedding, model: embeddingService.isLegacyNamespace(nsName) ? embeddingService.LEGACY_MODEL : embeddingService.EMBEDDING_MODEL }
      : await embeddingService.embedQuery(queryText, { namespace: nsName });
    const { rows } = await q(
      `SELECT text, file_name, file_id, chunk_index, metadata, 1 - (embedding <=> $1::vector) AS score
         FROM kb_vectors
        WHERE namespace = $2 AND embedding_model = $3
        ORDER BY embedding <=> $1::vector
        LIMIT $4`, [toVec(made.embedding), nsName, made.model, k]);
    for (const r of rows) {
      const score = Number(r.score);
      if (score >= scoreThreshold) {
        allResults.push({
          text: r.text || '',
          score,
          fileName: r.file_name || '',
          chunkIndex: r.chunk_index ?? 0,
          fileId: fileIdOut(r.file_id),
          kbId: r.metadata?.kbId ?? 0,
          fileType: r.metadata?.fileType || '',
          namespace: nsName,
        });
      }
    }
  }

  allResults.sort((a, b) => b.score - a.score);

  // Token budget (rough: 4 chars per token); the best hit is always kept.
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
 * A KB's vectors for copying to another environment, in pages
 * (GET /api/library/kbs/:namespace/vectors, and the agent copy's DB reader).
 * @returns {Promise<{ vectors: Array, next: string|null }>}
 */
async function exportVectors(namespace, { after = '', limit = 200 } = {}, client = db) {
  const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
  const { rows } = await q(
    `SELECT namespace, id, embedding_model, embedding::text AS embedding, text, file_name, file_id, chunk_index, metadata,
            created_at
       FROM kb_vectors WHERE namespace = $1 AND id > $2 ORDER BY id LIMIT $3`, [namespace, after || '', n], client);
  return {
    vectors: rows.map(r => ({
      namespace: r.namespace, id: r.id, embeddingModel: r.embedding_model, embedding: JSON.parse(r.embedding),
      text: r.text, fileName: r.file_name, fileId: r.file_id, chunkIndex: r.chunk_index, metadata: r.metadata,
    })),
    next: rows.length === n ? rows[rows.length - 1].id : null,
  };
}

/** Format results into a prompt section (the KB library's retrieval tester). */
function formatForPrompt(results) {
  if (!results.length) return '';
  const sections = results.map(r =>
    `### From: ${r.fileName} (relevance: ${r.score.toFixed(2)})\n${r.text}`,
  );
  return `## Relevant Knowledge Base Content\nThe following excerpts are from your knowledge base. Use them to inform your response.\n\n${sections.join('\n\n')}`;
}

module.exports = {
  KB_LIBRARY,
  DIMENSIONS,
  KbStoreError,
  inTransaction,
  getStatus,
  getNamespace,
  indexFile,
  insertVectors,
  deleteFile,
  deleteNamespace,
  deleteNamespaceByName,
  getStats,
  namespaceExists,
  listVectors,
  query,
  exportVectors,
  formatForPrompt,
};
