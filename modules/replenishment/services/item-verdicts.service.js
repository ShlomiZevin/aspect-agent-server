/**
 * Procurement Groups — the buyer's verdict layer.
 *
 * A verdict row EXISTS only while a buyer override is in force. Clearing a
 * verdict deletes the row and the item goes back to following the computed
 * suggestion — there is no stored "follow suggestion" state to drift.
 *
 * Platform DB (survives every dataset-schema swap), same rule as
 * supplier_settings. `suggested_at_verdict` records what the classifier said
 * when the buyer decided, so a later recompute that disagrees can flag the row
 * for review instead of silently fighting the buyer.
 */

const db = require('../../../services/db.pg');
const { replenishmentItemVerdicts } = require('../../../db/schema');
const { eq, and, inArray, sql } = require('drizzle-orm');
const { GROUPS } = require('../groups');

const VALID_GROUPS = new Set(Object.values(GROUPS));

/** Every verdict for a dataset, as a Map sku → row. One query, never N. */
async function mapForDataset(datasetId) {
  const drizzle = db.getDrizzle();
  const rows = await drizzle.select().from(replenishmentItemVerdicts)
    .where(eq(replenishmentItemVerdicts.datasetId, datasetId));
  return new Map(rows.map(r => [r.sku, r]));
}

/**
 * Set (or clear) one verdict. `assignedGroup: null` clears — that is how the
 * combo's "follow suggestion" works and how Undo restores a no-verdict state.
 */
async function setVerdict(datasetId, sku, { assignedGroup, suggestedAtVerdict, note, updatedBy }) {
  const drizzle = db.getDrizzle();
  if (assignedGroup === null || assignedGroup === undefined) {
    await drizzle.delete(replenishmentItemVerdicts).where(and(
      eq(replenishmentItemVerdicts.datasetId, datasetId),
      eq(replenishmentItemVerdicts.sku, sku),
    ));
    return null;
  }
  if (!VALID_GROUPS.has(assignedGroup)) {
    throw new Error(`unknown group '${assignedGroup}'`);
  }
  const [row] = await drizzle.insert(replenishmentItemVerdicts)
    .values({
      datasetId, sku, assignedGroup,
      suggestedAtVerdict: suggestedAtVerdict ?? null,
      note: note ?? null,
      updatedBy: updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [replenishmentItemVerdicts.datasetId, replenishmentItemVerdicts.sku],
      set: {
        assignedGroup,
        suggestedAtVerdict: suggestedAtVerdict ?? null,
        note: note ?? null,
        updatedBy: updatedBy ?? null,
        // The DATABASE clock, deliberately: the revert ownership guard
        // compares this against an operation's executedAt, which the DB also
        // stamps (defaultNow). Mixing the app server's clock in — the old
        // `new Date()` — made "was this touched after the operation?"
        // depend on clock skew between two machines.
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

/**
 * Bulk apply for Smart Tune. Returns the PRIOR state per sku (verdict row or
 * null), which is what makes the operation revertible.
 */
async function bulkAssign(datasetId, skus, assignedGroup, { note, updatedBy } = {}) {
  if (!VALID_GROUPS.has(assignedGroup)) throw new Error(`unknown group '${assignedGroup}'`);
  const drizzle = db.getDrizzle();
  const prior = skus.length
    ? await drizzle.select().from(replenishmentItemVerdicts).where(and(
      eq(replenishmentItemVerdicts.datasetId, datasetId),
      inArray(replenishmentItemVerdicts.sku, skus),
    ))
    : [];
  const priorBySku = new Map(prior.map(r => [r.sku, r]));

  for (const sku of skus) {
    // Sequential upserts keep this simple and safely idempotent; a Smart Tune
    // batch is capped at proposalMaxItems, and ~500 upserts run in well under
    // a second on the platform DB.
    await setVerdict(datasetId, sku, { assignedGroup, note, updatedBy });
  }
  return skus.map(sku => ({
    sku,
    prior: priorBySku.has(sku)
      ? { assignedGroup: priorBySku.get(sku).assignedGroup, note: priorBySku.get(sku).note }
      : null,
  }));
}

/**
 * Restore a bulk operation's prior state exactly, per sku.
 *
 * With `changedAfter` set (the operation's own executedAt), the restore is
 * OWNERSHIP-GUARDED: a sku whose verdict was touched after that moment — by
 * another session, another proposal, or a buyer's manual Move — is SKIPPED
 * and counted, never clobbered back to this operation's older memory. The
 * operation's own writes land just before its executedAt, so untouched rows
 * pass the strict comparison.
 */
async function restorePrior(datasetId, priorState, { updatedBy, changedAfter } = {}) {
  const entries = priorState || [];
  let restored = 0;
  let skippedChanged = 0;

  // One read for the whole batch, never N.
  const current = changedAfter && entries.length
    ? new Map((await db.getDrizzle().select().from(replenishmentItemVerdicts).where(and(
      eq(replenishmentItemVerdicts.datasetId, datasetId),
      inArray(replenishmentItemVerdicts.sku, entries.map(e => e.sku)),
    ))).map(r => [r.sku, r]))
    : null;

  for (const entry of entries) {
    if (current) {
      const row = current.get(entry.sku);
      if (!row) {
        // The verdict was CLEARED since the operation. If the prior state was
        // "no verdict", the clear already IS the restore — count it done. If
        // a prior verdict existed, someone deliberately cleared this item
        // after our move; resurrecting the old verdict would overrule them.
        if (entry.prior) { skippedChanged += 1; continue; }
        restored += 1;
        continue;
      }
      if (new Date(row.updatedAt) > new Date(changedAfter)) {
        skippedChanged += 1;
        continue;
      }
    }
    if (entry.prior) {
      await setVerdict(datasetId, entry.sku, {
        assignedGroup: entry.prior.assignedGroup, note: entry.prior.note, updatedBy,
      });
    } else {
      await setVerdict(datasetId, entry.sku, { assignedGroup: null });
    }
    restored += 1;
  }
  return { restored, skippedChanged };
}

module.exports = { mapForDataset, setVerdict, bulkAssign, restorePrior, VALID_GROUPS };
