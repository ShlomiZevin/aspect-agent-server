/**
 * HQ — the ingest pipeline.
 *
 *   capture → normalise → chunk → embed → index → (Scribe, for meetings)
 *
 * Reuses the KB stack wholesale (chunker / embedding / Pinecone) so retrieval
 * behaves identically to the rest of the platform. Vectors land in the `hq`
 * namespace of the shared `lybi` index; chunk metadata carries `atomId` so a
 * hit maps straight back to its atom for citations.
 */

const chunker = require('../../services/kb.chunker.service');
const embedding = require('../../services/kb.embedding.service');
const pinecone = require('../../services/kb.pinecone.service');
const atomsService = require('./atoms.service');
const scribe = require('./scribe.service');

const HQ_NAMESPACE = 'hq';
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;

/**
 * Chunk → embed → upsert one atom's body.
 * Returns the chunk count; 0 for an empty body (which is not an error — some
 * Notion pages are genuinely just a title).
 */
async function indexAtom(atom) {
  const body = (atom.body || '').trim();
  if (!body) {
    await atomsService.setAtomIndexed(atom.id, { chunkCount: 0, status: 'indexed' });
    return 0;
  }

  // Prefix each chunk with the atom's title so a retrieved fragment carries its
  // own context — without this, a mid-transcript chunk reads as orphaned text
  // and the model can't tell which meeting it came from.
  const header = `# ${atom.title}\n\n`;
  const chunks = chunker.chunkText(header + body, {
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  if (!chunks.length) {
    await atomsService.setAtomIndexed(atom.id, { chunkCount: 0, status: 'indexed' });
    return 0;
  }

  const { embeddings } = await embedding.embedTexts(chunks.map(c => c.text));

  // Clear prior vectors first so a re-sync of an edited page doesn't leave
  // stale chunks behind alongside the new ones.
  await pinecone.deleteFile(HQ_NAMESPACE, `atom-${atom.id}`).catch(() => {});

  await pinecone.indexFile({
    kbId: 0,
    namespace: HQ_NAMESPACE,
    fileId: `atom-${atom.id}`,
    fileName: atom.title,
    fileType: atom.kind,
    chunks,
    embeddings,
  });

  await atomsService.setAtomIndexed(atom.id, { chunkCount: chunks.length, status: 'indexed' });
  return chunks.length;
}

/**
 * Full pipeline for one normalised document.
 *
 * `runScribe` is fire-and-forget on purpose: transcripts are long and the
 * Scribe is a real LLM call, so the caller (an HTTP request) shouldn't wait on
 * it. The atom is returned immediately with `scribe_status: 'running'` and the
 * UI polls.
 */
async function ingestDocument(doc, { sourceId = null, runScribe = 'auto' } = {}) {
  const { atom, changed, created } = await atomsService.upsertAtom({ ...doc, sourceId });

  // Unchanged content: nothing to re-embed, nothing to re-summarise.
  if (!changed && atom.status === 'indexed') {
    return { atom, skipped: true, chunkCount: atom.chunk_count };
  }

  let chunkCount = 0;
  try {
    chunkCount = await indexAtom(atom);
  } catch (err) {
    await atomsService.setAtomIndexed(atom.id, { chunkCount: 0, status: 'failed', error: err.message });
    return { atom: { ...atom, status: 'failed', error: err.message }, skipped: false, chunkCount: 0 };
  }

  const wantScribe = runScribe === true || (runScribe === 'auto' && atom.kind === 'meeting');
  if (wantScribe && (atom.body || '').trim()) {
    await atomsService.setScribeStatus(atom.id, 'running');
    scribe.runScribe(atom.id).catch(err => {
      console.error(`[hq] scribe failed for atom ${atom.id}:`, err.message);
      atomsService.setScribeStatus(atom.id, 'failed', err.message).catch(() => {});
    });
  }

  const fresh = await atomsService.getAtom(atom.id);
  return { atom: fresh, skipped: false, chunkCount, created };
}

/** Remove an atom's vectors as well as its row. */
async function removeAtom(atomId) {
  await pinecone.deleteFile(HQ_NAMESPACE, `atom-${atomId}`).catch(() => {});
  await atomsService.deleteAtom(atomId);
}

module.exports = { HQ_NAMESPACE, indexAtom, ingestDocument, removeAtom };
