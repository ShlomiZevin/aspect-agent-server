/**
 * KB library — adding and removing files of a knowledge base (KB V2). A KB
 * is a namespace in this environment's vector store
 * (services/kb.vectorStore.service, pgvector): indexing the first file
 * creates it.
 *
 * Shared by the admin screen's bulk upload (/api/pinecone/index-bulk), its
 * file / KB deletes, and the Builder MCP (task #949), so a file indexed by
 * an AI assistant is chunked, embedded and recorded exactly like one dropped
 * on the screen. A file = its vectors + its library_files row; the two are
 * written and removed together.
 */

const db = require('./db.pg');
const { eq, and } = require('drizzle-orm');
const chunkerService = require('./kb.chunker.service');
const embeddingService = require('./kb.embedding.service');
const vectorStore = require('./kb.vectorStore.service');
const { libraryFiles } = require('../db/schema');

/**
 * Chunk, embed and index one file into `namespace`, and record it in
 * library_files. Throws when no text can be extracted.
 * @returns {Promise<{ fileId: number, vectorCount: number, embeddingTokens: number, embeddingCost: number }>}
 */
async function indexFile({ namespace, kbId, agentId, buffer, fileName, mimetype, size, chunkSize = 1000, chunkOverlap = 200 }) {
  const { chunks } = await chunkerService.processFile(buffer, fileName, mimetype, { chunkSize, chunkOverlap });

  console.log(`📄 [index] "${fileName}" → ${chunks.length} chunks (size ${chunkSize}/${chunkOverlap})`);

  if (chunks.length === 0) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    throw new Error(
      ext === 'pdf'
        ? 'No text could be extracted — this looks like a scanned/image PDF (no text layer). OCR is needed to index it.'
        : 'No text could be extracted from this file.'
    );
  }

  const { embeddings, totalTokens, cost } = await embeddingService.embedTexts(chunks.map(c => c.text));
  const fileId = Date.now() + Math.floor(Math.random() * 10000);
  const ns = namespace || vectorStore.getNamespace(kbId);

  const { vectorCount } = await vectorStore.indexFile({
    kbId: kbId ? parseInt(kbId) : 0,
    namespace: ns,
    fileId,
    fileName,
    fileType: fileName.split('.').pop().toLowerCase(),
    agentId: parseInt(agentId) || 0,
    chunks,
    embeddings,
    embeddingModel: embeddingService.EMBEDDING_MODEL,
  });

  try {
    await db.getDrizzle().insert(libraryFiles).values({
      indexName: vectorStore.KB_LIBRARY,
      namespace: ns,
      fileId: String(fileId),
      fileName,
      fileSize: size,
      fileType: fileName.split('.').pop().toLowerCase(),
      chunkCount: vectorCount,
      embeddingTokens: totalTokens,
      embeddingCost: cost,
      status: 'completed',
    });
  } catch (err) {
    // No record → no file: take its vectors back out rather than leave chunks nobody can see or delete.
    await vectorStore.deleteFile(ns, fileId).catch(() => {});
    throw err;
  }

  return { fileId, vectorCount, embeddingTokens: totalTokens, embeddingCost: cost };
}

/** The recorded files of a KB. */
async function listFiles(namespace) {
  return db.getDrizzle().select().from(libraryFiles)
    .where(and(eq(libraryFiles.indexName, vectorStore.KB_LIBRARY), eq(libraryFiles.namespace, namespace)));
}

/** Vectors + record of one file, in one transaction. */
async function removeFileRow(file) {
  await vectorStore.inTransaction(async client => {
    await vectorStore.deleteFile(file.namespace, file.fileId, client);
    await client.query('DELETE FROM library_files WHERE id = $1', [file.id]);
  });
  return { fileName: file.fileName, namespace: file.namespace, fileId: file.fileId };
}

/**
 * Remove one file of a KB by its file id: its vectors and its library_files row.
 * @returns {Promise<{ fileName: string } | null>} null when the KB has no such file.
 */
async function deleteFile(namespace, fileId) {
  const [file] = (await listFiles(namespace)).filter(f => f.fileId === String(fileId));
  if (!file) return null;
  return removeFileRow(file);
}

/**
 * Remove one file by its library_files row id (the admin screen's file list).
 * @returns {Promise<{ fileName: string } | null>} null when there is no such row.
 */
async function deleteFileByRowId(id) {
  const [file] = await db.getDrizzle().select().from(libraryFiles).where(eq(libraryFiles.id, parseInt(id)));
  if (!file) return null;
  return removeFileRow(file);
}

/**
 * Remove a whole KB: every vector and every file record, in one transaction.
 * Links to agents stay (a retriever naming it then reads "missing", as before).
 * @returns {Promise<{ vectors: number, files: number }>}
 */
async function deleteKb(namespace) {
  return vectorStore.inTransaction(async client => {
    const vectors = await vectorStore.deleteNamespaceByName(namespace, client);
    const files = (await client.query('DELETE FROM library_files WHERE namespace = $1', [namespace])).rowCount;
    return { vectors, files };
  });
}

module.exports = { indexFile, listFiles, deleteFile, deleteFileByRowId, deleteKb };
