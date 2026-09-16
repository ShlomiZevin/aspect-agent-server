/**
 * The generic document store custom screens will write user-typed data to
 * (notes, statuses, adjustments — shapes we cannot predict, so JSONB under
 * a composite key instead of a table per module).
 *
 * Ships now so the first editable-column request is an API call away, not a
 * migration away; NO v1 block writes here yet. The (dataset, module) scope
 * is enforced in every query — one client's screen physically cannot reach
 * another's rows, whatever its JS does.
 */

const db = require('../../services/db.pg');
const { customModuleData } = require('../../db/schema');
const { eq, and } = require('drizzle-orm');

const MAX_DOC_BYTES = 64 * 1024;
const MAX_DOCS_PER_COLLECTION = 5000;

const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,200}$/;

function assertSegment(name, value) {
  if (!SEGMENT_RE.test(String(value || ''))) {
    const err = new Error(`${name} must match ${SEGMENT_RE}`);
    err.status = 400;
    throw err;
  }
}

async function getDoc(datasetId, moduleId, collection, docId) {
  assertSegment('collection', collection);
  assertSegment('docId', docId);
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(customModuleData)
    .where(and(
      eq(customModuleData.datasetId, datasetId),
      eq(customModuleData.moduleId, moduleId),
      eq(customModuleData.collection, collection),
      eq(customModuleData.docId, docId),
    )).limit(1);
  return row ? { docId: row.docId, data: row.data, updatedAt: row.updatedAt } : null;
}

async function listDocs(datasetId, moduleId, collection) {
  assertSegment('collection', collection);
  const drizzle = db.getDrizzle();
  const rows = await drizzle.select().from(customModuleData)
    .where(and(
      eq(customModuleData.datasetId, datasetId),
      eq(customModuleData.moduleId, moduleId),
      eq(customModuleData.collection, collection),
    )).limit(MAX_DOCS_PER_COLLECTION);
  return rows.map(r => ({ docId: r.docId, data: r.data, updatedAt: r.updatedAt }));
}

async function putDoc(datasetId, moduleId, collection, docId, data) {
  assertSegment('collection', collection);
  assertSegment('docId', docId);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    const err = new Error('data must be a JSON object');
    err.status = 400;
    throw err;
  }
  if (JSON.stringify(data).length > MAX_DOC_BYTES) {
    const err = new Error(`document exceeds ${MAX_DOC_BYTES} bytes`);
    err.status = 413;
    throw err;
  }
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.insert(customModuleData)
    .values({ datasetId, moduleId, collection, docId, data })
    .onConflictDoUpdate({
      target: [
        customModuleData.datasetId, customModuleData.moduleId,
        customModuleData.collection, customModuleData.docId,
      ],
      set: { data, updatedAt: new Date() },
    })
    .returning();
  return { docId: row.docId, data: row.data, updatedAt: row.updatedAt };
}

module.exports = { getDoc, listDocs, putDoc };
