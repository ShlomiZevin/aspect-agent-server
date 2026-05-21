/**
 * Builder V2 — per-conversation memory.
 *
 * Thin wrapper over context.service so BuilderRunner can:
 *   1) load the field values collected so far in this conversation
 *      (used to render `## Memory` and `## Already collected` blocks
 *      in subsequent turns), and
 *   2) merge in new memory writes after each extractor runs.
 *
 * Storage shape (under namespace `builder_memory`, conversation-
 * scoped row in `context_data`):
 *
 *   {
 *     "_general":          { fieldA: 2, fieldB: "yes" },
 *     "<domain-name>":     { fieldC: "manager" },
 *     ...
 *   }
 *
 * `_general` bucket holds fields whose `domain` is empty/null —
 * keeps the storage shape uniform without inventing user-facing
 * "(ungrouped)" labels.
 */

const contextService = require('../../services/context.service');

const NAMESPACE = 'builder_memory';
const GENERAL_KEY = '_general';

function domainKey(domain) {
  return domain && String(domain).trim() ? String(domain) : GENERAL_KEY;
}

/**
 * Load the conversation's memory blob, or {} if there's nothing yet.
 * @param {number} userId
 * @param {number} conversationId
 */
async function loadMemory(userId, conversationId) {
  if (!userId || !conversationId) return {};
  const blob = await contextService.getContext(userId, NAMESPACE, conversationId);
  return blob && typeof blob === 'object' ? blob : {};
}

/**
 * Persist a memory blob (replaces the row).
 */
async function saveMemory(userId, conversationId, blob) {
  if (!userId || !conversationId) return;
  await contextService.saveContext(userId, NAMESPACE, blob, conversationId);
}

/**
 * Merge a list of writes into the existing blob, in place. Returns
 * the same blob ref so callers can chain. New non-null values
 * overwrite older ones for the same (domain, field) pair.
 *
 * @param {Object} blob       — the loaded memory shape
 * @param {Array<{domain: string|null, field: string, value: unknown}>} writes
 */
function applyWrites(blob, writes) {
  for (const w of writes) {
    if (w.value === null || w.value === undefined) continue;
    const k = domainKey(w.domain);
    if (!blob[k]) blob[k] = {};
    blob[k][w.field] = w.value;
  }
  return blob;
}

/**
 * Lookup a field value across all domains. First non-null hit wins.
 * Used to populate `## Already collected` for an extractor whose
 * fields may or may not have a configured domain — we don't ask the
 * caller to know which bucket the field lives in.
 */
function findFieldValue(blob, fieldName) {
  for (const domain of Object.keys(blob)) {
    const bucket = blob[domain];
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, fieldName)) {
      const v = bucket[fieldName];
      if (v !== null && v !== undefined) return v;
    }
  }
  return undefined;
}

/**
 * Get the value map for one domain. `null` resolves to `_general`.
 * Returns {} when there's nothing for that domain.
 */
function valuesForDomain(blob, domain) {
  const k = domainKey(domain);
  return blob[k] || {};
}

module.exports = {
  loadMemory,
  saveMemory,
  applyWrites,
  findFieldValue,
  valuesForDomain,
  NAMESPACE,
  GENERAL_KEY,
};
