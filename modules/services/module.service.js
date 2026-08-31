/**
 * Aspect Modules — state, settings resolution, and the live-module gate.
 *
 * This service is the ONLY place that decides whether a module is live.
 * Everything downstream (the client situation page's nav item, the crew tool
 * registration, the manifest fragment, the nightly build hook) asks
 * getLiveModules()/isLive() rather than reading `enabled` or `status` itself,
 * so the rule lives in one function instead of being re-derived — subtly
 * differently — in five places.
 *
 * THE GUARANTEE (plan guardrail #8): a dataset with no `client_modules` row
 * produces zero behavioural hooks. getLiveModules() returns [] and every
 * caller short-circuits, so such a dataset behaves byte-identically to a
 * platform where this framework was never installed. scripts/
 * test-modules-unit.js asserts this directly, because it is the reason the
 * framework can ship to a multi-client platform at all.
 *
 * Dataset identity is borrowed from insights/datasets/registry.js — that is
 * already the canonical list of datasets the platform serves (schema name +
 * pool), and a second list would drift from it. Modules are registered
 * separately, in ./registry.js.
 */

const db = require('../../services/db.pg');
const { clientModules, providerConfig, agents } = require('../../db/schema');
const { eq, and } = require('drizzle-orm');
const moduleRegistry = require('../registry');
const datasetRegistry = require('../../insights/datasets/registry');

/** Settings source levels, most specific first. Surfaced to the UI so a user
 *  can always tell a value they set from one that was assumed for them. */
const SOURCE = {
  MODULE: 'module',       // client_modules.settings — what an admin typed for THIS dataset+module
  PLATFORM: 'platform',   // provider_config module defaults — same module, every dataset
  CODE: 'code',           // the descriptor's own settingsSchema default
};
// NOTE ON NAMING: the plan (section 08, A2) calls the middle tier "dataset
// default". It is stored per MODULE and applies across datasets, so calling
// it "dataset" here would actively mislead — it is named `platform` instead.
// The chain and the source tagging are exactly as specified.

function platformDefaultsKey(moduleId) {
  return `module_defaults_${moduleId}`;
}

/** @returns {boolean} is this a dataset the platform actually serves? */
function isKnownDataset(datasetId) {
  return Boolean(datasetRegistry.get(datasetId));
}

/**
 * Is this a client the platform serves, dataset or not?
 *
 * A dataset-scoped module can only attach to a real dataset, which is what
 * isKnownDataset already answers. A client-scoped module attaches to any client
 * slug — Aspect and LYBI are clients with no customer schema, and a per-client
 * tool has to be switchable for them too.
 *
 * Async because agents live in the database, which is why it is used only on the
 * admin paths. getLiveModules() stays synchronous on the dataset fast path; see
 * the note there.
 */
async function isKnownClient(clientId) {
  if (!clientId) return false;
  if (isKnownDataset(clientId)) return true;

  const drizzle = db.getDrizzle();
  const [row] = await drizzle
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.urlSlug, String(clientId).toLowerCase()))
    .limit(1);
  return Boolean(row);
}

/** Whether `descriptor` may attach to `clientId` at all. */
async function canAttach(clientId, descriptor) {
  return (descriptor.scope || 'dataset') === 'client'
    ? isKnownClient(clientId)
    : isKnownDataset(clientId);
}

// ── state ────────────────────────────────────────────────────────────────

/** @returns {Object|null} the stored row for (dataset, module), or null. */
async function getState(datasetId, moduleId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle
    .select().from(clientModules)
    .where(and(eq(clientModules.datasetId, datasetId), eq(clientModules.moduleId, moduleId)))
    .limit(1);
  return row || null;
}

/** Every stored row for a dataset, keyed by module id. One query, not N. */
async function getStates(datasetId) {
  const drizzle = db.getDrizzle();
  const rows = await drizzle
    .select().from(clientModules)
    .where(eq(clientModules.datasetId, datasetId));
  return Object.fromEntries(rows.map(r => [r.moduleId, r]));
}

/**
 * Upsert helper. Every write goes through here so `updated_at`/`updated_by`
 * can never be forgotten, and so the ON CONFLICT target is written once.
 */
async function upsert(datasetId, moduleId, patch, updatedBy) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle
    .insert(clientModules)
    .values({ datasetId, moduleId, ...patch, updatedBy: updatedBy || null })
    .onConflictDoUpdate({
      target: [clientModules.datasetId, clientModules.moduleId],
      set: { ...patch, updatedBy: updatedBy || null, updatedAt: new Date() },
    })
    .returning();
  return row;
}

// ── settings resolution ──────────────────────────────────────────────────

async function getPlatformDefaults(moduleId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle
    .select().from(providerConfig)
    .where(eq(providerConfig.key, platformDefaultsKey(moduleId)))
    .limit(1);
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt blob must not take the module down — fall through to code
    // defaults, which are always present and always valid.
    console.warn(`[modules] ignoring unparseable platform defaults for '${moduleId}'`);
    return {};
  }
}

/**
 * Resolve a module's settings through module override -> platform default ->
 * code constant, tagging every value with the level it came from.
 *
 * The tags are not decoration: the client page has to say "90 days — you set
 * this" versus "90 days — default, set it", and a buyer who cannot tell those
 * apart cannot judge the recommendation built on top of them.
 *
 * @returns {{values: Object, sources: Object, missingRequired: string[]}}
 */
function resolveSettings(descriptor, storedSettings, platformDefaults) {
  const values = {};
  const sources = {};
  const missingRequired = [];

  for (const field of descriptor.settingsSchema) {
    const { key } = field;
    if (storedSettings && storedSettings[key] !== undefined && storedSettings[key] !== null) {
      values[key] = storedSettings[key];
      sources[key] = SOURCE.MODULE;
    } else if (platformDefaults && platformDefaults[key] !== undefined && platformDefaults[key] !== null) {
      values[key] = platformDefaults[key];
      sources[key] = SOURCE.PLATFORM;
    } else if (field.default !== undefined) {
      values[key] = field.default;
      sources[key] = SOURCE.CODE;
    } else {
      values[key] = null;
      sources[key] = null;
    }
    // "Required" means required to RUN, not required to save a draft — the
    // admin can save a partial form and come back. Init is what refuses.
    if (field.required && (values[key] === null || values[key] === '')) {
      missingRequired.push(key);
    }
  }

  return { values, sources, missingRequired };
}

// ── public shape ─────────────────────────────────────────────────────────

/** Descriptor + stored state + resolved settings, as the admin tab renders it. */
async function describe(datasetId, descriptor, state) {
  const platformDefaults = await getPlatformDefaults(descriptor.id);
  const settings = resolveSettings(descriptor, state?.settings, platformDefaults);
  const status = state?.status || 'not_initialized';
  const enabled = state?.enabled ?? false;

  return {
    id: descriptor.id,
    name: descriptor.name,
    version: descriptor.version,
    settingsSchema: descriptor.settingsSchema,
    notificationEvents: descriptor.notificationEvents,

    enabled,
    status,
    // The single computed answer every surface asks for, so no caller has to
    // remember that BOTH conditions matter.
    live: enabled && status === 'ready',

    settings: settings.values,
    settingsSources: settings.sources,
    missingRequired: settings.missingRequired,

    binding: state?.binding || null,
    initModel: state?.initModel || null,
    updatedBy: state?.updatedBy || null,
    updatedAt: state?.updatedAt || null,
  };
}

/** @returns {Object[]|null} every registered module for a dataset, or null if the dataset is unknown. */
async function listForDataset(datasetId) {
  if (!await isKnownClient(datasetId)) return null;
  const states = await getStates(datasetId);
  // Only the modules that can actually attach here. A dataset-scoped module
  // listed against a client with no schema would offer a switch that cannot
  // legally be turned on.
  const attachable = [];
  for (const d of moduleRegistry.all()) {
    if (await canAttach(datasetId, d)) attachable.push(d);
  }
  return Promise.all(attachable.map(d => describe(datasetId, d, states[d.id])));
}

/** @returns {Object|null} one module for a dataset, or null if either is unknown. */
async function getForDataset(datasetId, moduleId) {
  const descriptor = moduleRegistry.get(moduleId);
  if (!descriptor) return null;
  if (!await canAttach(datasetId, descriptor)) return null;
  return describe(datasetId, descriptor, await getState(datasetId, moduleId));
}

// ── the live gate ────────────────────────────────────────────────────────

/**
 * THE byte-identical guarantee, in one function.
 *
 * Returns the descriptors that are actually live for this dataset — enabled
 * AND ready AND still registered. A dataset with no rows returns [], and so
 * does one whose only module is switched off or still initializing.
 *
 * The `moduleRegistry.get()` filter matters: a row can outlive its module
 * (someone removes the descriptor while a client_modules row still says
 * ready). Serving from a descriptor that no longer exists would throw deep
 * inside a chat turn; dropping it here degrades to "the module simply isn't
 * there", which is the same as never having installed it.
 */
async function getLiveModules(datasetId) {
  // No isKnownClient() here on purpose: it costs a query, and this runs on the
  // chat and reload hot paths. It is not needed for correctness either — a
  // client_modules row only exists if an admin created it through a path that
  // DID validate, so an unknown id simply matches nothing below.
  if (!datasetId) return [];
  const drizzle = db.getDrizzle();
  const rows = await drizzle
    .select().from(clientModules)
    .where(and(
      eq(clientModules.datasetId, datasetId),
      eq(clientModules.enabled, true),
      eq(clientModules.status, 'ready'),
    ));

  return rows
    .map(row => ({ row, descriptor: moduleRegistry.get(row.moduleId) }))
    .filter(x => x.descriptor);
}

/** @returns {boolean} is this specific module live for this dataset? */
async function isLive(datasetId, moduleId) {
  const live = await getLiveModules(datasetId);
  return live.some(x => x.descriptor.id === moduleId);
}

/**
 * Light status projection for the client — what the situation page's nav item
 * polls. Deliberately NOT the full describe() shape: this is called on a
 * customer-facing route and must leak no settings, binding, or model id.
 */
async function getPublicStatus(datasetId) {
  if (!await isKnownClient(datasetId)) return null;
  const live = await getLiveModules(datasetId);
  return { datasetId, modules: live.map(x => ({ id: x.descriptor.id, name: x.descriptor.name })) };
}

// ── mutations ────────────────────────────────────────────────────────────

async function setEnabled(datasetId, moduleId, enabled, updatedBy) {
  const descriptor = moduleRegistry.get(moduleId);
  if (!descriptor) return null;
  if (!await canAttach(datasetId, descriptor)) return null;

  const patch = { enabled: Boolean(enabled) };

  // An app module has nothing to introspect, render or verify, so there is no
  // init run that could ever move it to 'ready'. Enabling IS the installation.
  // Without this it would sit enabled-but-not-ready forever and getLiveModules()
  // — which requires both — would never return it.
  if ((descriptor.kind || 'data') === 'app') {
    patch.status = patch.enabled ? 'ready' : 'not_initialized';
  }

  await upsert(datasetId, moduleId, patch, updatedBy);
  return getForDataset(datasetId, moduleId);
}

/**
 * Save the admin's settings form.
 *
 * Unknown keys are dropped rather than stored: settings are read back by the
 * engine and the init prompt, and silently carrying a typo'd key ('leadTime'
 * instead of 'defaultLeadTimeDays') would look saved in the UI while doing
 * nothing at all.
 */
async function saveSettings(datasetId, moduleId, incoming, updatedBy) {
  const descriptor = moduleRegistry.get(moduleId);
  if (!descriptor) return null;
  if (!await canAttach(datasetId, descriptor)) return null;

  const allowed = new Set(descriptor.settingsSchema.map(f => f.key));
  const cleaned = {};
  const rejected = [];
  for (const [k, v] of Object.entries(incoming || {})) {
    if (allowed.has(k)) cleaned[k] = v;
    else rejected.push(k);
  }
  if (rejected.length) {
    console.warn(`[modules] ${datasetId}/${moduleId}: ignoring unknown settings keys: ${rejected.join(', ')}`);
  }

  const existing = await getState(datasetId, moduleId);
  const merged = { ...(existing?.settings || {}), ...cleaned };
  await upsert(datasetId, moduleId, { settings: merged }, updatedBy);
  return getForDataset(datasetId, moduleId);
}

/** Status transitions — owned by the init orchestrator and the nightly hook. */
async function setStatus(datasetId, moduleId, status, updatedBy) {
  return upsert(datasetId, moduleId, { status }, updatedBy);
}

/** Persist a converged, verified binding (and the model that produced it). */
async function setBinding(datasetId, moduleId, binding, initModel, updatedBy) {
  return upsert(datasetId, moduleId, { binding, initModel: initModel || null }, updatedBy);
}

module.exports = {
  SOURCE,
  isKnownDataset,
  getState,
  getStates,
  listForDataset,
  getForDataset,
  getLiveModules,
  isLive,
  getPublicStatus,
  setEnabled,
  saveSettings,
  setStatus,
  setBinding,
  // exported for offline unit tests — no route calls these directly
  resolveSettings,
};
