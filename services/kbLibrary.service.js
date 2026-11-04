/**
 * KB library — adding and removing one file of a knowledge base (KB V2,
 * Pinecone). A KB is a namespace: indexing the first file creates it.
 *
 * Shared by the admin screen's bulk upload (/api/pinecone/index-bulk) and
 * the Builder MCP (task #949), so a file indexed by an AI assistant is
 * chunked, embedded and recorded exactly like one dropped on the screen.
 */

const db = require('./db.pg');
const { eq, and } = require('drizzle-orm');
const chunkerService = require('./kb.chunker.service');
const embeddingService = require('./kb.embedding.service');
const pineconeService = require('./kb.pinecone.service');
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

  const { vectorCount } = await pineconeService.indexFile({
    kbId: kbId ? parseInt(kbId) : 0,
    namespace: namespace || undefined,
    fileId,
    fileName,
    fileType: fileName.split('.').pop().toLowerCase(),
    agentId: parseInt(agentId) || 0,
    chunks,
    embeddings,
  });

  const drizzle = db.getDrizzle();
  if (drizzle) {
    await drizzle.insert(libraryFiles).values({
      indexName: process.env.PINECONE_INDEX_NAME || 'default',
      namespace: namespace || `kb-${kbId}`,
      fileId: String(fileId),
      fileName,
      fileSize: size,
      fileType: fileName.split('.').pop().toLowerCase(),
      chunkCount: vectorCount,
      embeddingTokens: totalTokens,
      embeddingCost: cost,
      status: 'completed',
    });
  }

  return { fileId, vectorCount, embeddingTokens: totalTokens, embeddingCost: cost };
}

/** The recorded files of a KB, newest first. */
async function listFiles(namespace) {
  return db.getDrizzle().select().from(libraryFiles)
    .where(and(eq(libraryFiles.indexName, process.env.PINECONE_INDEX_NAME || 'default'), eq(libraryFiles.namespace, namespace)));
}

/**
 * Remove one file: its vectors and its library_files row.
 * @returns {Promise<{ fileName: string } | null>} null when the KB has no such file.
 */
async function deleteFile(namespace, fileId) {
  const drizzle = db.getDrizzle();
  const [file] = (await listFiles(namespace)).filter(f => f.fileId === String(fileId));
  if (!file) return null;
  await pineconeService.deleteFile(namespace, parseInt(file.fileId));
  await drizzle.delete(libraryFiles).where(eq(libraryFiles.id, file.id));
  return { fileName: file.fileName };
}

module.exports = { indexFile, listFiles, deleteFile };
