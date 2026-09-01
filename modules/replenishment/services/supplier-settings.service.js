/**
 * Per-supplier replenishment settings, and the resolution chain that turns
 * them into the parameters the engine runs on.
 *
 * THE CHAIN, most specific first:
 *   supplier override  (supplier_settings, this dataset + this supplier)
 *   dataset default    (the module's settings, set in the admin tab)
 *   code constant      (the descriptor's settingsSchema default)
 *
 * Every resolved value carries WHICH level it came from. That is not
 * bookkeeping: the client screen says "90 days — you set this" versus
 * "90 days — default, set it", the chat tool has to say which it used, and a
 * buyer who cannot tell those apart cannot judge the recommendation built on
 * top of them. `leadTimeSource` in particular is one of the eight named edge
 * cases in the engine battery.
 *
 * Storage is the PLATFORM DB. It has to be: dataset schemas are dropped and
 * rebuilt behind an atomic swap on every import, so a lead time stored there
 * would vanish on the next reload and the recommendations would quietly
 * revert to the default with nobody notified.
 */

const db = require('../../../services/db.pg');
const { supplierSettings } = require('../../../db/schema');
const { eq, and } = require('drizzle-orm');
const moduleService = require('../../services/module.service');

const MODULE_ID = 'replenishment';

/** Which module setting backs each per-supplier field. */
const FIELD_TO_DEFAULT = {
  leadTimeDays: 'defaultLeadTimeDays',
  reviewDays: 'defaultReviewDays',
  safetyDays: 'defaultSafetyDays',
  minOrderUnits: 'minOrderUnits',
};

/** Source levels, surfaced to every consumer. */
const SOURCE = {
  SUPPLIER: 'supplier',           // this supplier's own override
  DATASET_DEFAULT: 'dataset_default',
  CODE: 'code',
};

async function listOverrides(datasetId) {
  const drizzle = db.getDrizzle();
  return drizzle.select().from(supplierSettings)
    .where(eq(supplierSettings.datasetId, datasetId));
}

async function getOverride(datasetId, supplierKey) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(supplierSettings)
    .where(and(
      eq(supplierSettings.datasetId, datasetId),
      eq(supplierSettings.supplierKey, supplierKey),
    )).limit(1);
  return row || null;
}

/**
 * Upsert one supplier's overrides.
 *
 * A field explicitly set to null CLEARS the override and falls back to the
 * dataset default — that is how a buyer un-sets a lead time. Fields simply
 * absent from the patch are left alone, so a partial save cannot wipe values
 * the form did not show.
 */
async function upsertOverride(datasetId, supplierKey, patch, updatedBy) {
  const drizzle = db.getDrizzle();
  const allowed = ['supplierLabel', 'leadTimeDays', 'reviewDays', 'safetyDays', 'minOrderUnits', 'notes', 'excluded'];
  const values = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, k)) values[k] = patch[k];
  }

  const [row] = await drizzle.insert(supplierSettings)
    .values({ datasetId, supplierKey, ...values, updatedBy: updatedBy || null })
    .onConflictDoUpdate({
      target: [supplierSettings.datasetId, supplierSettings.supplierKey],
      set: { ...values, updatedBy: updatedBy || null, updatedAt: new Date() },
    })
    .returning();
  return row;
}

async function deleteOverride(datasetId, supplierKey) {
  const drizzle = db.getDrizzle();
  await drizzle.delete(supplierSettings).where(and(
    eq(supplierSettings.datasetId, datasetId),
    eq(supplierSettings.supplierKey, supplierKey),
  ));
}

/**
 * Resolve the engine parameters for ONE supplier.
 *
 * @param {object} moduleSettings the module's resolved settings (from module.service)
 * @param {object|null} override  this supplier's row, if any
 * @returns {object} engine settings + a `sources` map
 */
function resolveForSupplier(moduleSettings, override) {
  const values = {};
  const sources = {};

  for (const [field, defaultKey] of Object.entries(FIELD_TO_DEFAULT)) {
    const own = override ? override[field] : null;
    if (own !== null && own !== undefined) {
      values[field] = own;
      sources[field] = SOURCE.SUPPLIER;
    } else {
      const fallback = moduleSettings?.[defaultKey];
      values[field] = fallback === undefined ? null : fallback;
      // The module setting may itself have come from a code default, but from
      // a supplier's point of view it is "the dataset default" either way —
      // what the buyer needs to know is that THEY did not set it.
      sources[field] = fallback === undefined ? SOURCE.CODE : SOURCE.DATASET_DEFAULT;
    }
  }

  return {
    leadTimeDays: values.leadTimeDays,
    leadTimeSource: sources.leadTimeDays,
    reviewDays: values.reviewDays,
    safetyDays: values.safetyDays,
    minOrderUnits: values.minOrderUnits,
    // Kept out of the recommendations entirely. Not a FIELD_TO_DEFAULT entry:
    // it has no dataset-wide default to fall back to — a supplier is either
    // excluded or it is not, and only an override can say so.
    excluded: Boolean(override?.excluded),
    // Not per-supplier — these are dataset-wide and pass straight through.
    velocityWindowDays: moduleSettings?.velocityWindowDays,
    includeStoreStock: moduleSettings?.includeStoreStock,
    horizonDays: moduleSettings?.horizonDays,
    cartonRounding: moduleSettings?.cartonRounding,
    sources,
  };
}

/**
 * The whole chain for a dataset, ready to hand to the engine per supplier.
 * One query for the overrides, one for the module settings — never N.
 */
async function resolveAll(datasetId) {
  const mod = await moduleService.getForDataset(datasetId, MODULE_ID);
  if (!mod) return null;
  const overrides = await listOverrides(datasetId);
  const byKey = Object.fromEntries(overrides.map(o => [o.supplierKey, o]));

  return {
    moduleSettings: mod.settings,
    /** @returns engine settings for one supplier, with sources. */
    forSupplier: (supplierKey) => resolveForSupplier(mod.settings, byKey[supplierKey] || null),
    overrides: byKey,
  };
}

module.exports = {
  MODULE_ID,
  SOURCE,
  FIELD_TO_DEFAULT,
  listOverrides,
  getOverride,
  upsertOverride,
  deleteOverride,
  resolveAll,
  // exported for the offline battery
  resolveForSupplier,
};
