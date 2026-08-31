require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const assert = require('assert');
const db = require('../../services/db.pg');
const manifests = require('../../services/dataset-manifest');
const moduleService = require('../../modules/services/module.service');

/**
 * Proves the manifestFragment hook is actually consumed, and that consuming it
 * cannot change a dataset with no module enabled.
 *
 * The review (S1) found the hook written, registered and unit-tested but wired
 * to nothing: plan decision D7 — "a module contributes to the manifest when
 * live" — was a no-op. A test that only calls the hook would have stayed green
 * through all of that, so this one asserts the merge from the OUTSIDE, through
 * the same function the crew calls.
 *
 *   node verification/modules-replenishment/test-manifest-fragment.js
 *
 * Restores the module's enabled state, including on failure.
 */
const DATASET = 'zolstock';

let passed = 0;
const ok = name => { passed++; console.log('   ok  ' + name); };
let restore = null;

async function run() {
  await db.initialize();

  const before = await moduleService.getForDataset(DATASET, 'replenishment');
  restore = () => moduleService.setEnabled(DATASET, 'replenishment', Boolean(before?.enabled), 'verification');

  const base = manifests.get(DATASET);
  assert.ok(base, `${DATASET} should have a manifest`);

  // --- with the module off ------------------------------------------------------
  await moduleService.setEnabled(DATASET, 'replenishment', false, 'verification');

  const off = await manifests.getWithModules(DATASET);
  assert.deepStrictEqual(off, base);
  ok('with no module live, the merged manifest is byte-identical to the dataset one');

  const renderedOff = manifests.renderForCrew(off);
  assert.ok(!/order quantity/i.test(renderedOff));
  ok('and the crew block says nothing about replenishment');

  // --- with the module on -------------------------------------------------------
  await moduleService.setEnabled(DATASET, 'replenishment', true, 'verification');

  const on = await manifests.getWithModules(DATASET);
  assert.notDeepStrictEqual(on, base);
  ok('switching the module on changes the merged manifest');

  const fragment = require('../../modules/replenishment/module').hooks.manifestFragment();

  for (const key of Object.keys(fragment.measures || {})) {
    assert.ok(on.measures?.[key], `measure "${key}" should be merged in`);
    assert.deepStrictEqual(on.measures[key], fragment.measures[key]);
  }
  ok('every measure the fragment declares arrives intact');

  for (const key of Object.keys(fragment.dimensions || {})) {
    assert.ok(on.dimensions?.[key], `dimension "${key}" should be merged in`);
  }
  ok('every dimension the fragment declares arrives intact');

  // The point of the whole mechanism: a status the base vocabulary does not
  // have, describing a value a human supplied rather than one measured.
  const leadTime = on.dimensions?.['supplier lead time'];
  assert.strictEqual(leadTime?.status, 'configured');
  ok('the "configured" lead-time status reaches the manifest');

  // --- the dataset always wins ---------------------------------------------------
  const firstBaseMeasure = Object.keys(base.measures || {})[0];
  if (firstBaseMeasure) {
    assert.deepStrictEqual(
      on.measures[firstBaseMeasure], base.measures[firstBaseMeasure],
      'a module must not be able to redefine a measure the dataset asserts',
    );
    ok('a fragment cannot overwrite what the dataset itself declares');
  }

  // --- and it is not merely reachable, it is rendered -----------------------------
  const renderedOn = manifests.renderForCrew(on);
  assert.notStrictEqual(renderedOn, renderedOff);
  ok('the crew block differs once the module is live');

  // --- a broken fragment must not break the dataset --------------------------------
  const descriptor = require('../../modules/replenishment/module');
  const original = descriptor.hooks.manifestFragment;
  descriptor.hooks.manifestFragment = () => { throw new Error('deliberate'); };
  try {
    const survived = await manifests.getWithModules(DATASET);
    assert.deepStrictEqual(survived, base);
    ok('a fragment that throws degrades to the dataset manifest rather than failing the turn');
  } finally {
    descriptor.hooks.manifestFragment = original;
  }

  console.log(`\n   ${passed} checks passed`);
}

run()
  .then(async () => { if (restore) await restore(); process.exit(0); })
  .catch(async err => {
    console.error('\nFAILED:', err.message);
    if (restore) await restore().catch(() => {});
    process.exit(1);
  });
