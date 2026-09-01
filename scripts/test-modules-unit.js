/**
 * Aspect Modules — offline unit battery. No DB, no LLM, no network.
 *
 * Covers the two things that are pure logic and must never regress:
 *   1. descriptor validation (registry.validate) — a malformed module must
 *      fail at boot, not halfway through an init run
 *   2. settings resolution — module -> platform -> code, with the source tag
 *      that the client page's "you set this / default" badge depends on
 *
 * The byte-identical guarantee (a dataset with no rows produces zero
 * behavioural hooks) needs a real database to be worth anything, so it is
 * asserted in scripts/test-modules-api.js against a running server rather
 * than against a mock that could agree with a bug.
 *
 * Run: node scripts/test-modules-unit.js
 */

const registry = require('../modules/registry');
const { resolveSettings } = require('../modules/services/module.service');

let pass = 0, fail = 0;

function ok(label, condition, detail) {
  if (condition) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

function throws(label, fn, expectedFragment) {
  try {
    fn();
    console.log(`  FAIL ${label} — expected a throw, got none`);
    fail++;
  } catch (e) {
    const matched = !expectedFragment || e.message.includes(expectedFragment);
    if (matched) { console.log(`  OK   ${label}`); pass++; }
    else { console.log(`  FAIL ${label} — threw "${e.message}", expected to mention "${expectedFragment}"`); fail++; }
  }
}

// A minimal valid descriptor, cloned and broken per case below.
function validDescriptor(overrides = {}) {
  return {
    id: 'probe',
    name: { en: 'Probe', he: 'בדיקה' },
    version: 1,
    settingsSchema: [
      { key: 'a', type: 'number', required: true, default: 10, label: { en: 'A', he: 'א' } },
    ],
    notificationEvents: ['init_completed'],
    hooks: {
      audit() {}, proposeBinding() {}, renderInfra() {}, verify() {},
      nightlyBuild() {}, chatTools() {}, manifestFragment() {},
    },
    ...overrides,
  };
}

console.log('\n1 · Descriptor validation — malformed modules fail at boot');

ok('a well-formed descriptor validates', (() => {
  try { registry.validate(validDescriptor()); return true; } catch { return false; }
})());

throws('missing id is rejected',
  () => registry.validate(validDescriptor({ id: undefined })), 'missing id');

throws('name without a Hebrew label is rejected',
  () => registry.validate(validDescriptor({ name: { en: 'Probe' } })), "both 'en' and 'he'");

throws('a settings field without both locales is rejected',
  () => registry.validate(validDescriptor({
    settingsSchema: [{ key: 'a', label: { en: 'A' } }],
  })), "must have both 'en' and 'he' labels");

throws('a settings field with no key is rejected',
  () => registry.validate(validDescriptor({ settingsSchema: [{ label: { en: 'A', he: 'א' } }] })),
  'has no key');

throws('a missing hook is rejected',
  () => {
    const d = validDescriptor();
    delete d.hooks.verify;
    registry.validate(d);
  }, "missing hook 'verify'");

throws('notificationEvents must be an array',
  () => registry.validate(validDescriptor({ notificationEvents: 'init_completed' })),
  'notificationEvents must be an array');

console.log('\n2 · Registry contents');

const stub = registry.get('_stub');
ok('the dev stub is registered outside production', Boolean(stub),
  `NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);
ok('registry.get() returns null for an unknown module', registry.get('no_such_module') === null);
ok('every registered descriptor passes validation', registry.all().every(d => {
  try { registry.validate(d); return true; } catch { return false; }
}));
ok('the stub declares no chat tools', stub && stub.hooks.chatTools().length === 0);
ok('the stub contributes no manifest fragment', stub && stub.hooks.manifestFragment() === null);
ok('the stub renders empty DDL (so it touches no database)',
  stub && Array.isArray(stub.hooks.renderInfra()) && stub.hooks.renderInfra().length === 0);

console.log('\n3 · Settings resolution — module > platform > code, with source tags');

const descriptor = {
  settingsSchema: [
    { key: 'leadTime', required: true, default: 90, label: { en: 'L', he: 'ל' } },
    { key: 'horizon', required: false, default: 14, label: { en: 'H', he: 'ה' } },
    { key: 'emails', required: true, label: { en: 'E', he: 'א' } }, // no code default
  ],
};

{
  const r = resolveSettings(descriptor, { leadTime: 45 }, { leadTime: 60, horizon: 21 });
  ok('module value wins over platform and code', r.values.leadTime === 45, `got ${r.values.leadTime}`);
  ok('…and is tagged as coming from the module', r.sources.leadTime === 'module', r.sources.leadTime);
  ok('platform value wins where the module has none', r.values.horizon === 21, `got ${r.values.horizon}`);
  ok('…and is tagged as platform', r.sources.horizon === 'platform', r.sources.horizon);
}

{
  const r = resolveSettings(descriptor, {}, {});
  ok('code default applies when nothing is stored', r.values.leadTime === 90, `got ${r.values.leadTime}`);
  ok('…and is tagged as code', r.sources.leadTime === 'code', r.sources.leadTime);
}

{
  // A stored null must NOT count as "the admin set this" — it should fall
  // through, or clearing a field would pin it to null instead of restoring
  // the default.
  const r = resolveSettings(descriptor, { leadTime: null }, { leadTime: 60 });
  ok('a stored null falls through to the next level', r.values.leadTime === 60, `got ${r.values.leadTime}`);
  ok('…tagged as platform, not module', r.sources.leadTime === 'platform', r.sources.leadTime);
}

{
  const r = resolveSettings(descriptor, {}, {});
  ok('a required field with no value anywhere is reported missing',
    r.missingRequired.includes('emails'), JSON.stringify(r.missingRequired));
  ok('a required field that resolved is NOT reported missing',
    !r.missingRequired.includes('leadTime'), JSON.stringify(r.missingRequired));
  ok('an optional field is never reported missing',
    !r.missingRequired.includes('horizon'), JSON.stringify(r.missingRequired));
}

{
  // Keys the descriptor does not declare must not appear in resolved values —
  // the engine reads these, and a stray key is either a typo or stale.
  const r = resolveSettings(descriptor, { leadTime: 45, bogusKey: 'x' }, {});
  ok('undeclared keys are not resolved', r.values.bogusKey === undefined);
  ok('resolved keys match the schema exactly',
    Object.keys(r.values).sort().join(',') === 'emails,horizon,leadTime');
}

{
  const r = resolveSettings(descriptor, { leadTime: 0 }, { leadTime: 60 });
  ok('a stored 0 is a real value, not "unset"', r.values.leadTime === 0, `got ${r.values.leadTime}`);
  ok('…tagged as module', r.sources.leadTime === 'module', r.sources.leadTime);
}

{
  const r = resolveSettings(descriptor, { horizon: false }, {});
  ok('a stored false is a real value, not "unset"', r.values.horizon === false, `got ${r.values.horizon}`);
}

// ---------------------------------------------------------------------------
// An APP module is invisible to every host path.
//
// This is the guarantee that was missing, and it cost the same bug twice. The
// framework promises that a dataset with no module rows behaves byte for byte
// as it did before the framework existed. Introducing app modules -- ones with
// their own storage and no hooks -- quietly created a SECOND thing every host
// path has to be indifferent to, and nobody went back to check the hosts.
//
// Both consumers that reached into `descriptor.hooks` broke on it:
//
//   the nightly build   threw "module is ready but has no stored binding" and
//                       marked a healthy Task Board `degraded` on every reload
//   the tool attach     logged "chatTools threw" once per chat turn, forever
//
// Neither is caught by testing the module: both modules were correct. The
// defect is in the host, so the host is what these drive. `getLiveModules` is
// stubbed rather than mocked at the DB -- it is the single definition of
// "live" and every one of these paths goes through it, which is what makes one
// stub enough to reach all of them.
// ---------------------------------------------------------------------------
async function appModuleIsInvisible() {
  console.log('\n4 - An app module is invisible to every host path');

  const moduleService = require('../modules/services/module.service');
  const moduleBuild = require('../modules/services/module-build.service');
  const moduleTools = require('../modules/services/module-tools.service');
  const datasetManifest = require('../services/dataset-manifest');

  const appModules = registry.all().filter(d => (d.kind || 'data') === 'app');
  ok('there is at least one app module to check on', appModules.length > 0,
    'nothing below would be asserting anything otherwise');

  for (const d of appModules) {
    ok(d.id + ': declares no hooks', !d.hooks);
    ok(d.id + ': the registry agrees there is nothing to run', registry.runsHooks(d) === false);
  }

  // The other half of it: the guard must not have switched the real modules off
  // as well. A filter that skips everything passes every check above.
  const dataModules = registry.all().filter(d => (d.kind || 'data') === 'data');
  ok('data modules still run their hooks',
    dataModules.length > 0 && dataModules.every(d => registry.runsHooks(d) === true));

  // Live, enabled, ready -- and with the empty binding that made the build throw.
  const live = appModules.map(descriptor => ({
    descriptor,
    row: { module_id: descriptor.id, enabled: true, status: 'ready', binding: null, settings: {} },
  }));

  const realGetLive = moduleService.getLiveModules;
  const realWarn = console.warn;
  const realError = console.error;
  const noise = [];
  moduleService.getLiveModules = async () => live;
  console.warn = (...a) => noise.push(a.join(' '));
  console.error = (...a) => noise.push(a.join(' '));

  try {
    // --- the reload ---------------------------------------------------------
    // The pool throws if it is touched at all: an app module must not cause a
    // single query against the customer database, which is the entire point of
    // it owning its own.
    const hostilePool = {
      query: () => { throw new Error('the reload queried the customer DB for an app module'); },
    };

    const shadow = await moduleBuild.buildModulesInShadow('zolstock', 'zolstock_shadow', hostilePool, () => {});
    ok('reload: nothing is built', shadow.built.length === 0 && shadow.failed.length === 0,
      JSON.stringify(shadow));
    ok('reload: reported as skipped, not as a failure', shadow.skipped === true,
      JSON.stringify(shadow));

    const rebuilt = await moduleBuild.buildModulesInLive('zolstock', null, hostilePool, () => {});
    ok('rebuild-in-place: nothing is built and nothing fails',
      rebuilt.built.length === 0 && rebuilt.failed.length === 0, JSON.stringify(rebuilt));

    const views = await moduleBuild.expectedViews('zolstock');
    ok('reload: no views are expected of it', Array.isArray(views) && views.length === 0,
      JSON.stringify(views));

    // --- the chat turn ------------------------------------------------------
    const crew = { datasetSchema: 'zolstock', tools: [{ name: 'fetch_zolstock_data' }] };
    const before = JSON.stringify(crew.tools);
    const res = await moduleTools.attachTo(crew);
    ok('chat: no tool is attached', res.attached.length === 0, JSON.stringify(res));
    ok('chat: the crew keeps exactly the tools it owned', JSON.stringify(crew.tools) === before);

    // --- the crew prompt ----------------------------------------------------
    // Identity, not equality: the manifest handed to the crew must be the very
    // object the dataset declared. A merged copy that happens to look the same
    // is still a module editing a prompt it contributes nothing to, and that is
    // how empty `facts` and `vocabulary` keys appeared once already.
    const base = datasetManifest.get('zolstock');
    if (base) {
      const merged = await datasetManifest.getWithModules('zolstock');
      ok('prompt: the dataset manifest is handed over untouched', merged === base);
    } else {
      ok('prompt: skipped -- zolstock declares no manifest to compare against', true);
    }

    // --- and none of it complained ------------------------------------------
    // The degraded status was at least visible. This half was not: a host that
    // "handles" an app module by logging a failure every turn is still wrong,
    // and only silence proves it is being skipped rather than caught.
    ok('none of it logs a failure', noise.length === 0, noise.join(' | '));
  } finally {
    moduleService.getLiveModules = realGetLive;
    console.warn = realWarn;
    console.error = realError;
  }
}

appModuleIsInvisible()
  .catch(err => { console.log('  FAIL the app-module battery threw -- ' + err.message); fail++; })
  .then(() => {
    console.log('\n---------------------\n' + pass + '/' + (pass + fail) + ' checks passed');
    process.exit(fail === 0 ? 0 : 1);
  });
