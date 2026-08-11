/**
 * Aspect Intelligence per-dataset config storage.
 *
 * Same shape as services/schedule-config.service.js: one JSON blob per
 * dataset in the generic `provider_config` key/value table, written via
 * insert().onConflictDoUpdate() — no dedicated migration/table needed.
 * Registry defaults (../datasets/registry.js) are layered underneath a
 * stored override, so a dataset with no row yet still resolves to sensible
 * (but disabled) values.
 *
 * Version history is scoped PER SECTION, not one combined dataset-wide
 * history — "Config" (brandLabel/dataModelDescription) and "Prompts"
 * (bootstrapPrompts/examplePrompts) are edited and saved independently (see
 * DatasetConfigPage/DatasetPromptsPage), so each gets its own history array
 * on the same blob (`configHistory`, `promptsHistory`) rather than one
 * combined list where restoring one section would be entangled with the
 * other's edits. setConfig() snapshots the PRE-write state of whichever
 * section(s) the patch actually touches (newest first, capped at
 * HISTORY_LIMIT). restoreVersion() re-applies a past snapshot via
 * setConfig() itself, so restoring is itself snapshotted too — nothing is
 * ever destructively lost.
 */

const db = require('../../services/db.pg');
const { providerConfig } = require('../../db/schema');
const { eq } = require('drizzle-orm');
const registry = require('../datasets/registry');

const HISTORY_LIMIT = 20;

// Which config fields belong to each independently-versioned section.
const SECTION_FIELDS = {
  config: ['brandLabel', 'dataModelDescription'],
  prompts: ['bootstrapPrompts', 'examplePrompts'],
};

function keyFor(datasetId) {
  return `intel_config_${datasetId}`;
}

function defaultsFor(datasetId) {
  const entry = registry.get(datasetId);
  if (!entry) return null;
  return {
    // Verified/live by default: hypertoy (reconciled to the client's own Qlik
    // dashboard) and zolstock (33/33 figures matched in the 2026-08-11
    // accuracy suite — the best result of the 6 datasets — after the
    // items/stores dimension tables and schema-rules landed). The other four
    // still default off until they get the same pass.
    enabled: entry.id === 'hypertoy' || entry.id === 'zolstock',
    dataModelDescription: entry.defaultDataModelDescription,
    brandLabel: entry.defaultBrandLabel,
    bootstrapPrompts: entry.defaultBootstrapPrompts,
    examplePrompts: entry.defaultExamplePrompts,
  };
}

async function getRawValue(datasetId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(providerConfig).where(eq(providerConfig.key, keyFor(datasetId))).limit(1);
  return row?.value || null;
}

/** Parses the stored blob (or defaults if none) into every field, INCLUDING both section histories — internal use only, see parseEntry() for the public (history-stripped) shape. */
function parseFull(raw, datasetId) {
  const defaults = defaultsFor(datasetId);
  if (!raw) return { ...defaults, configHistory: [], promptsHistory: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled,
      dataModelDescription: parsed.dataModelDescription || defaults.dataModelDescription,
      brandLabel: parsed.brandLabel || defaults.brandLabel,
      bootstrapPrompts: Array.isArray(parsed.bootstrapPrompts) ? parsed.bootstrapPrompts : defaults.bootstrapPrompts,
      examplePrompts: Array.isArray(parsed.examplePrompts) ? parsed.examplePrompts : defaults.examplePrompts,
      configHistory: Array.isArray(parsed.configHistory) ? parsed.configHistory : [],
      promptsHistory: Array.isArray(parsed.promptsHistory) ? parsed.promptsHistory : [],
    };
  } catch {
    return { ...defaults, configHistory: [], promptsHistory: [] };
  }
}

/** Public shape (no history — kept out of the hot list/get paths to avoid bloating every dataset-list response with old text blobs). */
function parseEntry(raw, datasetId) {
  const { configHistory, promptsHistory, ...rest } = parseFull(raw, datasetId);
  return rest;
}

/** @returns {Object|null} resolved config (stored override merged over registry defaults), or null for an unknown dataset. */
async function getConfig(datasetId) {
  if (!registry.get(datasetId)) return null;
  return parseEntry(await getRawValue(datasetId), datasetId);
}

function sectionKey(c, section) {
  return JSON.stringify(SECTION_FIELDS[section].map(f => c[f]));
}

/** @returns {Object|null} the updated config (no history fields), or null for an unknown dataset. */
async function setConfig(datasetId, patch) {
  if (!registry.get(datasetId)) return null;
  const current = parseFull(await getRawValue(datasetId), datasetId);
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    dataModelDescription: typeof patch.dataModelDescription === 'string' ? patch.dataModelDescription : current.dataModelDescription,
    brandLabel: typeof patch.brandLabel === 'string' ? patch.brandLabel : current.brandLabel,
    bootstrapPrompts: Array.isArray(patch.bootstrapPrompts) ? patch.bootstrapPrompts : current.bootstrapPrompts,
    examplePrompts: Array.isArray(patch.examplePrompts) ? patch.examplePrompts : current.examplePrompts,
  };

  const histories = {};
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    const historyField = `${section}History`;
    const touched = fields.some(f => f in patch);
    const changed = touched && sectionKey(current, section) !== sectionKey(next, section);
    histories[historyField] = changed
      ? [
          { savedAt: Date.now(), ...Object.fromEntries(fields.map(f => [f, current[f]])) },
          ...current[historyField],
        ].slice(0, HISTORY_LIMIT)
      : current[historyField];
  }

  const value = JSON.stringify({ ...next, ...histories });
  const drizzle = db.getDrizzle();
  await drizzle
    .insert(providerConfig)
    .values({ key: keyFor(datasetId), value })
    .onConflictDoUpdate({ target: providerConfig.key, set: { value, updatedAt: new Date() } });
  return next;
}

/** @returns {Array|null} version history for one section ('config' | 'prompts'), newest first — or null for an unknown dataset/section. */
async function getHistory(datasetId, section) {
  if (!registry.get(datasetId) || !SECTION_FIELDS[section]) return null;
  return parseFull(await getRawValue(datasetId), datasetId)[`${section}History`];
}

/** Re-applies a past snapshot (by its savedAt timestamp) for one section via setConfig() — the state right before restoring is itself snapshotted, so this is undoable too. @returns {Object|null} the updated config, or null if the dataset/section/version doesn't exist. */
async function restoreVersion(datasetId, section, savedAt) {
  const history = await getHistory(datasetId, section);
  if (!history) return null;
  const entry = history.find(h => h.savedAt === savedAt);
  if (!entry) return null;
  const patch = {};
  for (const f of SECTION_FIELDS[section]) patch[f] = entry[f];
  return setConfig(datasetId, patch);
}

/** Removes one version entry from a section's history (doesn't touch the live config). @returns {boolean|null} true if removed, false if not found, null for an unknown dataset/section. */
async function deleteVersion(datasetId, section, savedAt) {
  if (!registry.get(datasetId) || !SECTION_FIELDS[section]) return null;
  const current = parseFull(await getRawValue(datasetId), datasetId);
  const historyField = `${section}History`;
  const before = current[historyField].length;
  const filtered = current[historyField].filter(h => h.savedAt !== savedAt);
  if (filtered.length === before) return false;

  const value = JSON.stringify({ ...current, [historyField]: filtered });
  const drizzle = db.getDrizzle();
  await drizzle
    .insert(providerConfig)
    .values({ key: keyFor(datasetId), value })
    .onConflictDoUpdate({ target: providerConfig.key, set: { value, updatedAt: new Date() } });
  return true;
}

/** All dataset configs in one query — used by the admin datasets list and by insights.routes.js to filter enabled datasets. */
async function getAllConfigs() {
  const drizzle = db.getDrizzle();
  const rows = await drizzle.select().from(providerConfig);
  const byKey = new Map(rows.map(r => [r.key, r.value]));
  return registry.all().map(entry => ({
    id: entry.id,
    ...parseEntry(byKey.get(keyFor(entry.id)), entry.id),
  }));
}

module.exports = { getConfig, setConfig, getAllConfigs, getHistory, restoreVersion, deleteVersion };
