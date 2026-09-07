/**
 * Smart Tune — actionable proposals: the model proposes, code executes.
 *
 * A proposal is a PREVIEWED, deterministic change set. The chat tool creates
 * one from a structured filter; the buyer sees exactly which items it matched
 * (and the interpretation in words) before anything changes; Process is a
 * plain API call; execution acts on the SKU SNAPSHOT the buyer saw (decision
 * D5 — vanished SKUs are reported, never substituted), records the prior
 * per-SKU verdict state, and is one-click revertible.
 *
 * The tables (module_chat_proposals / module_bulk_operations) are framework-
 * level; this service is the replenishment module's use of them. When a second
 * module needs proposals, the generic seam is the tables + this shape.
 */

const db = require('../../../services/db.pg');
const { moduleChatProposals, moduleBulkOperations } = require('../../../db/schema');
const { eq, and } = require('drizzle-orm');
const scope = require('../scope');
const { GROUPS } = require('../groups');
const itemVerdicts = require('./item-verdicts.service');
const recommendations = require('./recommendations.service');

const MODULE_ID = 'replenishment';
const SCOPE_ID = 'tune';
const DEFAULT_EXPIRY_HOURS = 24;
const DEFAULT_MAX_ITEMS = 1000;
const PREVIEW_ROWS = 8;

/**
 * Create a proposal from a structured filter. Resolution is deterministic —
 * the same code path the tool and the screen read from — and the preview
 * carries the interpretation in words plus a sample of the matched rows.
 */
async function create(datasetId, {
  filter = {}, targetGroup, reason, conversationId, createdBy, settings = {},
}) {
  if (!itemVerdicts.VALID_GROUPS.has(targetGroup)) {
    return { error: `unknown target group '${targetGroup}'` };
  }
  const maxItems = Number(settings.proposalMaxItems) || DEFAULT_MAX_ITEMS;
  const expiryHours = Number(settings.proposalExpiryHours) || DEFAULT_EXPIRY_HOURS;

  // Resolve against the live computed rows. onlyDue:false — a tune can move
  // any item of the group, not only the due ones.
  const res = await recommendations.getRecommendations(datasetId, {
    onlyDue: false,
    group: filter.currentGroup || undefined,
    supplier: filter.supplier || undefined,
    search: filter.nameContains || filter.search || undefined,
    category: filter.category || undefined,
    subcategory: filter.subcategory || undefined,
    skus: Array.isArray(filter.skus) && filter.skus.length ? filter.skus : undefined,
  });
  if (res.error) return { error: res.error };

  const matched = res.recommendations;
  if (matched.length === 0) {
    return {
      empty: true,
      interpreted: describeFilter(filter, 0, res.totalUnscoped),
    };
  }
  if (matched.length > maxItems) {
    return {
      overCap: true,
      matchedCount: matched.length,
      maxItems,
      interpreted: describeFilter(filter, matched.length, res.totalUnscoped),
    };
  }

  const interpreted = describeFilter(filter, matched.length, res.totalUnscoped);
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.insert(moduleChatProposals).values({
    datasetId,
    moduleId: MODULE_ID,
    scopeId: SCOPE_ID,
    filter,
    interpreted,
    target: { assignGroup: targetGroup, reason: reason ?? null },
    skuSnapshot: matched.map(r => r.sku),
    conversationId: conversationId ?? null,
    createdBy: createdBy ?? null,
    expiresAt: new Date(Date.now() + expiryHours * 3600 * 1000),
  }).returning();

  return {
    proposalId: row.id,
    interpreted,
    targetGroup,
    count: matched.length,
    expiresAt: row.expiresAt,
    sample: matched.slice(0, PREVIEW_ROWS).map(r => ({
      sku: r.sku,
      item: r.itemName || r.sku,
      inStock: r.warehouseQty,
      stockTracked: r.stockTracked,
      salesPerDay: Number((r.velocityDaily ?? 0).toFixed(3)),
      orderByDate: r.orderByDate,
      group: r.group,
    })),
  };
}

/** The scope wording plus the move, in one line the buyer can check. */
function describeFilter(filter, matched, ofTotal) {
  const scopeLine = scope.describeScope({
    skus: filter.skus, category: filter.category,
    subcategory: filter.subcategory, search: filter.nameContains || filter.search,
  }, matched, ofTotal);
  const parts = [];
  if (filter.currentGroup) parts.push(`currently in group "${filter.currentGroup}"`);
  if (filter.supplier) parts.push(`supplier "${filter.supplier}"`);
  const extra = parts.length ? ` (${parts.join(', ')})` : '';
  return scopeLine
    ? `${scopeLine}${extra}`
    : `Scope: ${matched.toLocaleString('en-GB')} of ${ofTotal.toLocaleString('en-GB')} items${extra}.`;
}

async function get(proposalId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(moduleChatProposals)
    .where(eq(moduleChatProposals.id, Number(proposalId))).limit(1);
  return row || null;
}

/**
 * Current state of one proposal, for a card re-rendered from history: the
 * stored preview is in the chat message; what changed since is the status and
 * (when executed) the operation the Undo button needs.
 */
async function status(datasetId, proposalId) {
  const p = await get(proposalId);
  if (!p || p.datasetId !== datasetId) return { error: 'Unknown proposal', code: 404 };
  const drizzle = db.getDrizzle();
  const [op] = await drizzle.select().from(moduleBulkOperations)
    .where(eq(moduleBulkOperations.proposalId, p.id))
    .limit(1);
  const expired = p.status === 'proposed' && new Date(p.expiresAt) < new Date();
  return {
    proposalId: p.id,
    status: expired ? 'expired' : p.status,
    expiresAt: p.expiresAt,
    targetGroup: p.target?.assignGroup ?? null,
    operation: op
      ? { operationId: op.id, status: op.status, applied: op.applied, skipped: op.skipped }
      : null,
  };
}

/**
 * Execute against the SNAPSHOT. Skus that no longer exist in the live view are
 * counted and reported, never silently substituted; the prior verdict state is
 * recorded so the whole operation reverts exactly.
 */
async function execute(datasetId, proposalId, { executedBy } = {}) {
  const p = await get(proposalId);
  if (!p || p.datasetId !== datasetId) return { error: 'Unknown proposal', code: 404 };
  if (p.status !== 'proposed') return { error: `Proposal is ${p.status} — it cannot be executed`, code: 409 };
  if (new Date(p.expiresAt) < new Date()) {
    await setStatus(proposalId, 'expired');
    return { error: 'The preview expired — ask again to get a fresh one', code: 410 };
  }

  const snapshot = (p.skuSnapshot || []).map(String);
  const targetGroup = p.target?.assignGroup;
  if (!itemVerdicts.VALID_GROUPS.has(targetGroup)) return { error: 'Corrupt proposal target', code: 500 };

  // Existence check against the CURRENT view — a reload may have removed rows
  // between preview and Process.
  const still = await recommendations.getRecommendations(datasetId, { skus: snapshot, onlyDue: false });
  if (still.error) return still;
  const alive = new Set(still.recommendations.map(r => r.sku));
  const apply = snapshot.filter(s => alive.has(s));
  const skipped = snapshot.length - apply.length;

  const priorState = await itemVerdicts.bulkAssign(datasetId, apply, targetGroup, {
    note: p.target?.reason || `Smart Tune ${new Date().toISOString().slice(0, 10)}`,
    updatedBy: executedBy,
  });

  const drizzle = db.getDrizzle();
  const [op] = await drizzle.insert(moduleBulkOperations).values({
    proposalId: p.id,
    datasetId,
    moduleId: MODULE_ID,
    priorState,
    applied: apply.length,
    skipped,
    executedBy: executedBy ?? null,
  }).returning();
  await setStatus(proposalId, 'executed');

  return { operationId: op.id, applied: apply.length, skipped, targetGroup };
}

async function cancel(datasetId, proposalId) {
  const p = await get(proposalId);
  if (!p || p.datasetId !== datasetId) return { error: 'Unknown proposal', code: 404 };
  if (p.status !== 'proposed') return { error: `Proposal is already ${p.status}`, code: 409 };
  await setStatus(proposalId, 'cancelled');
  return { ok: true };
}

/** One-click undo: restore the recorded prior state exactly, per sku. */
async function revert(datasetId, operationId, { revertedBy } = {}) {
  const drizzle = db.getDrizzle();
  const [op] = await drizzle.select().from(moduleBulkOperations)
    .where(and(
      eq(moduleBulkOperations.id, Number(operationId)),
      eq(moduleBulkOperations.datasetId, datasetId),
    )).limit(1);
  if (!op) return { error: 'Unknown operation', code: 404 };
  if (op.status === 'reverted') return { error: 'Already reverted', code: 409 };

  await itemVerdicts.restorePrior(datasetId, op.priorState, { updatedBy: revertedBy });
  await drizzle.update(moduleBulkOperations)
    .set({ status: 'reverted', revertedAt: new Date() })
    .where(eq(moduleBulkOperations.id, op.id));
  return { ok: true, restored: (op.priorState || []).length };
}

async function setStatus(proposalId, status) {
  const drizzle = db.getDrizzle();
  await drizzle.update(moduleChatProposals).set({ status })
    .where(eq(moduleChatProposals.id, Number(proposalId)));
}

module.exports = { MODULE_ID, SCOPE_ID, create, get, status, execute, cancel, revert, GROUPS };
