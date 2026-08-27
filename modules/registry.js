/**
 * Static registry of every Aspect Module the platform knows how to run.
 *
 * Same shape and spirit as insights/datasets/registry.js: an explicit,
 * statically-required list — not a directory scan. A module only exists if
 * someone wrote it down here, which keeps "what can run against a client's
 * data" auditable.
 *
 * Registering a module is NOT the same as it doing anything. A registered
 * module is inert until a (dataset, module) row in `client_modules` is both
 * `enabled` and `status = 'ready'`. That is the multi-client safety guarantee
 * (plan guardrail #8): a dataset with no module rows behaves byte-identically
 * to a platform where this framework does not exist.
 *
 * Adding a module later: create modules/<id>/module.js exporting a
 * descriptor, require it here, add it to REGISTRY. Nothing in the admin UI,
 * the router, or the init orchestrator needs to change — they all read the
 * descriptor.
 */

const stub = require('./_stub/module');
const replenishment = require('./replenishment/module');

// The stub exists to test the framework, not to serve anyone. Keeping it out
// of production means the client-facing admin panel never shows a module
// nobody can use, and no operator can enable it against real data by mistake.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const DESCRIPTORS = [
  ...(IS_PRODUCTION ? [] : [stub]),
  replenishment,
];

/**
 * Fail at boot, not at first use.
 *
 * A descriptor with a missing hook would otherwise surface as a TypeError
 * halfway through an init run — after the audit has been written and the
 * status set to 'initializing' — leaving a half-updated row behind. Checking
 * the shape at require time turns that into an immediate, obvious crash on
 * a developer's machine.
 */
const REQUIRED_HOOKS = [
  'audit', 'proposeBinding', 'renderInfra', 'verify',
  'nightlyBuild', 'chatTools', 'manifestFragment',
];

function validate(descriptor) {
  const where = `module descriptor '${descriptor?.id || '(no id)'}'`;
  if (!descriptor?.id) throw new Error(`${where}: missing id`);
  if (!descriptor.name?.en || !descriptor.name?.he) {
    // Both locales, always — a missing Hebrew label renders as a raw key to
    // every Hebrew-speaking admin, which is most of them here.
    throw new Error(`${where}: name must carry both 'en' and 'he'`);
  }
  if (!Array.isArray(descriptor.settingsSchema)) {
    throw new Error(`${where}: settingsSchema must be an array`);
  }
  for (const field of descriptor.settingsSchema) {
    if (!field.key) throw new Error(`${where}: a settingsSchema field has no key`);
    if (!field.label?.en || !field.label?.he) {
      throw new Error(`${where}: settings field '${field.key}' must have both 'en' and 'he' labels`);
    }
  }
  if (!Array.isArray(descriptor.notificationEvents)) {
    throw new Error(`${where}: notificationEvents must be an array`);
  }
  for (const hook of REQUIRED_HOOKS) {
    if (typeof descriptor.hooks?.[hook] !== 'function') {
      throw new Error(`${where}: missing hook '${hook}'`);
    }
  }
  return descriptor;
}

const REGISTRY = {};
for (const descriptor of DESCRIPTORS) {
  validate(descriptor);
  REGISTRY[descriptor.id] = descriptor;
}

/** @returns {Object|null} the descriptor for a module id, or null if unknown. */
function get(moduleId) {
  return REGISTRY[moduleId] || null;
}

/** @returns {Object[]} every registered descriptor. */
function all() {
  return Object.values(REGISTRY);
}

module.exports = { get, all, validate };
