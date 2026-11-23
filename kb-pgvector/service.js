/**
 * pgvector proof of concept — the same KB searched two ways.
 *
 * A KB copied from Pinecone into kb_vectors (migration 073,
 * kb-pgvector/copy-from-pinecone.js) is searched with ONE query vector:
 *   - Pinecone: today's runtime path, services/kb.pinecone.service.js `query`
 *     (what the KB Retriever add-on calls), given the vector;
 *   - pgvector: cosine distance over the HNSW index in this environment's
 *     own Postgres.
 * The vector is made once, by services/kb.embedding.service.js with the
 * namespace's own model (the same call the runtime makes), so both sides
 * rank the same vector against the same stored embeddings.
 *
 * Both sides return the raw top K — no min-score cut and no token budget —
 * so the lists compare one to one.
 */
const db = require('../services/db.pg');
const embeddingService = require('../services/kb.embedding.service');
const kbService = require('../services/kb.pinecone.service');

const MAX_TOP_K = 20;
const MAX_QUERY_CHARS = 2000;

class PocError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function indexName() {
  const name = process.env.PINECONE_INDEX_NAME;
  if (!name) throw new PocError(503, 'PINECONE_INDEX_NAME is not set in this environment');
  return name;
}

/** Rewrites "relation kb_vectors does not exist" into what to do about it. */
async function q(sql, params) {
  try {
    return await db.query(sql, params);
  } catch (err) {
    if (err.code === '42P01') throw new PocError(503, 'pgvector is not set up in this environment (migration 073)');
    throw err;
  }
}

/**
 * The agent's KBs (kb_links on this environment's Pinecone index) that have a
 * pgvector copy, and the one this page searches: `namespace` if given, else
 * the first.
 */
async function resolveKb(agentSlug, namespace) {
  const index = indexName();
  const { rows: [agent] } = await q(
    `SELECT id, slug FROM builder_agents WHERE slug = $1 AND archived_at IS NULL`, [agentSlug]);
  if (!agent) throw new PocError(404, `No agent "${agentSlug}"`);
  const { rows } = await q(
    `SELECT v.namespace, count(*)::int AS chunks, count(DISTINCT v.file_name)::int AS files,
            min(v.embedding_model) AS embedding_model, count(DISTINCT v.embedding_model)::int AS models,
            max(v.copied_at) AS copied_at
       FROM kb_links l
       JOIN kb_vectors v ON v.index_name = l.index_name AND v.namespace = l.namespace
      WHERE l.agent_id = $1 AND l.index_name = $2
      GROUP BY v.namespace ORDER BY v.namespace`, [agent.id, index]);
  if (!rows.length) throw new PocError(404, `"${agentSlug}" has no knowledge base copied into pgvector here`);
  const kb = namespace ? rows.find(r => r.namespace === namespace) : rows[0];
  if (!kb) throw new PocError(404, `"${namespace}" is not one of ${agentSlug}'s copied knowledge bases`);
  if (kb.models !== 1) throw new PocError(409, `${kb.namespace} holds vectors from more than one embedding model`);
  return { agent: agent.slug, index, kb, kbs: rows };
}

async function info(agentSlug, namespace) {
  const { agent, index, kb, kbs } = await resolveKb(agentSlug, namespace);
  let pineconeChunks = null;
  try {
    const stats = await kbService.getIndexStats();
    pineconeChunks = stats.namespaces.find(n => n.name === kb.namespace)?.vectorCount ?? 0;
  } catch { /* shown as unknown */ }
  return {
    agent, index,
    namespace: kb.namespace,
    chunks: kb.chunks,
    files: kb.files,
    pineconeChunks,
    embeddingModel: kb.embedding_model,
    dimensions: 1536,
    copiedAt: kb.copied_at,
    namespaces: kbs.map(k => k.namespace),
    maxTopK: MAX_TOP_K,
  };
}

/** One result row, the same shape on both sides. `key` = file + chunk, derived
 *  identically from the metadata on both sides (the vector ids follow it too;
 *  missing values default to 0 as kb.pinecone.service does). */
const row = (rank, r) => ({
  rank,
  key: `${r.fileId ?? 0}:${r.chunkIndex ?? 0}`,
  fileName: r.fileName || '',
  chunkIndex: r.chunkIndex ?? null,
  score: Number(r.score),
  text: r.text || '',
});

async function search(agentSlug, { query, topK, namespace } = {}) {
  const text = String(query || '').trim();
  if (!text) throw new PocError(400, 'query is required');
  if (text.length > MAX_QUERY_CHARS) throw new PocError(400, `query is longer than ${MAX_QUERY_CHARS} characters`);
  const k = Math.min(MAX_TOP_K, Math.max(1, parseInt(topK, 10) || 10));
  const { index, kb } = await resolveKb(agentSlug, namespace);

  // One vector, made the way the runtime makes it for this namespace.
  const t0 = Date.now();
  const { embedding, model } = await embeddingService.embedQuery(text, { namespace: kb.namespace });
  const embedMs = Date.now() - t0;
  if (model !== kb.embedding_model) {
    throw new PocError(409, `query embedded with ${model} but ${kb.namespace} was stored with ${kb.embedding_model}`);
  }

  // Pinecone — today's path, raw top K.
  const pc = await kbService.query([kb.namespace], text, {
    topK: k, scoreThreshold: -Infinity, maxTokens: Infinity, embedding,
  });

  // pgvector — cosine, one plain query. The planner picks the HNSW index or an
  // exact scan (small KBs); the database's hnsw.iterative_scan (migration 073)
  // keeps an HNSW walk going past other KBs' rows so top K stays full.
  const t1 = Date.now();
  const { rows: pgRows } = await db.query(
    `SELECT file_id, chunk_index, file_name, text, 1 - (embedding <=> $1::vector) AS score
       FROM kb_vectors
      WHERE index_name = $2 AND namespace = $3
      ORDER BY embedding <=> $1::vector
      LIMIT $4`, [`[${embedding.join(',')}]`, index, kb.namespace, k]);
  const pgMs = Date.now() - t1;

  const pinecone = pc.results.map((r, i) => row(i + 1, r));
  const pgvector = pgRows.map((r, i) => row(i + 1, {
    fileId: r.file_id == null ? null : Number(r.file_id), chunkIndex: r.chunk_index,
    fileName: r.file_name, score: r.score, text: r.text,
  }));

  const pgKeys = new Set(pgvector.map(r => r.key));
  const same = pinecone.filter(r => pgKeys.has(r.key)).length;
  const sameOrder = pinecone.length === pgvector.length && pinecone.every((r, i) => r.key === pgvector[i].key);
  const pgScore = new Map(pgvector.map(r => [r.key, r.score]));
  const maxScoreDiff = pinecone.reduce((m, r) => (pgScore.has(r.key) ? Math.max(m, Math.abs(r.score - pgScore.get(r.key))) : m), 0);

  return {
    query: text, topK: k, namespace: kb.namespace, embeddingModel: model, embedMs,
    overlap: { same, of: Math.max(pinecone.length, pgvector.length), sameOrder, maxScoreDiff },
    pinecone: { ms: pc.queryTimeMs, results: pinecone },
    pgvector: { ms: pgMs, results: pgvector },
  };
}

module.exports = { info, search, PocError, MAX_TOP_K };
