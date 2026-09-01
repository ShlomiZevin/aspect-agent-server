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
const taskboard = require('./taskboard/module');
const googleAuth = require('./google-auth/module');
const { PLANNED_APPS } = require('./_planned/apps');

// The stub exists to test the framework, not to serve anyone. Keeping it out
// of production means the client-facing admin panel never shows a module
// nobody can use, and no operator can enable it against real data by mistake.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const DESCRIPTORS = [
  ...(IS_PRODUCTION ? [] : [stub]),
  replenishment,
  taskboard,
  googleAuth,
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

/**
 * Two kinds of module, and only one of them binds to customer data.
 *
 *   'data' — the original kind. Audits the client's schema, has an LLM propose
 *            a binding, renders DDL, verifies it. Smart Replenishment.
 *   'app'  — a self-contained tool that happens to be switchable per client. It
 *            owns its own storage and has nothing to introspect, so the whole
 *            audit -> binding -> DDL -> verify pipeline is meaningless for it.
 *
 * An app module therefore declares no hooks and never runs an init: enabling it
 * IS the whole installation. Requiring seven empty functions of it would be
 * ceremony that teaches the next reader the wrong thing about what a module is.
 */
const KINDS = ['data', 'app'];

/**
 * What a module attaches to.
 *
 *   'dataset' — one of the schemas in insights/datasets/registry.js. The
 *               original and still the default, so every existing descriptor
 *               keeps its exact meaning.
 *   'client'  — any client slug, whether or not it has a dataset. Needed
 *               because Aspect and LYBI are clients with no customer schema,
 *               and a per-client tool must still be switchable for them.
 */
const SCOPES = ['dataset', 'client'];

/**
 * Which shelf a module sits on in the client's UI.
 *
 * 'apps' is the Apps page — the icon grid of business apps running on the
 * client's own data. A module with no group is platform furniture (the task
 * board, a sign-in method): real, switchable, and not something the client
 * browses as an app.
 *
 * The shell shows the Apps tab when at least one 'apps' module is live for the
 * dataset, so the group is what makes a nav item appear, not a hardcoded route.
 */
const GROUPS = ['apps'];

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

  const kind = descriptor.kind || 'data';
  if (!KINDS.includes(kind)) {
    throw new Error(`${where}: kind must be one of: ${KINDS.join(', ')}`);
  }
  const scope = descriptor.scope || 'dataset';
  if (!SCOPES.includes(scope)) {
    throw new Error(`${where}: scope must be one of: ${SCOPES.join(', ')}`);
  }
  if (descriptor.group !== undefined && !GROUPS.includes(descriptor.group)) {
    throw new Error(`${where}: group must be one of: ${GROUPS.join(', ')}`);
  }
  // A grouped module is drawn as an icon, and an icon the client cannot draw is
  // a blank square with a label — worse than a boot failure nobody can miss.
  if (descriptor.group === 'apps' && !descriptor.icon) {
    throw new Error(`${where}: a module in the 'apps' group must name an icon`);
  }

  // Only a data module has data to bind. An app module declaring these would be
  // declaring something it cannot honour.
  if (kind === 'data') {
    for (const hook of REQUIRED_HOOKS) {
      if (typeof descriptor.hooks?.[hook] !== 'function') {
        throw new Error(`${where}: missing hook '${hook}'`);
      }
    }
  } else if (descriptor.hooks) {
    throw new Error(`${where}: an app module must not declare data hooks`);
  }

  return descriptor;
}

/**
 * Does the host have anything to RUN on this module?
 *
 * The single definition, for the same reason `getLiveModules` is the single
 * definition of "live": every host path that reaches into `descriptor.hooks`
 * must agree on who has them, and the answer must not be re-derived at each
 * call site. It was re-derived at two, and both got it wrong — the nightly
 * build threw "no stored binding" on an app module and marked a perfectly
 * healthy Task Board `degraded` on every reload, and the tool attach warned
 * "chatTools threw" on every chat turn for every client that had it enabled.
 *
 * Note this asks about HOOKS, not about kind. A caller wants to know whether
 * there is a function to call, and reading `kind === 'data'` at the call site
 * is how both of those bugs were written.
 */
function runsHooks(descriptor) {
  return Boolean(descriptor && descriptor.hooks);
}

/** Every registered module on one shelf, in registration order. */
function inGroup(group) {
  return Object.values(REGISTRY).filter(d => d.group === group);
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

module.exports = { get, all, validate, runsHooks, inGroup, GROUPS, PLANNED_APPS };
