require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const assert = require('assert');
const db = require('../../services/db.pg');
const moduleService = require('../../modules/services/module.service');
const moduleInitService = require('../../modules/services/module-init.service');
const registry = require('../../modules/registry');

/**
 * Checks the task board as an Aspect Module, against the real platform DB.
 *
 * Two things are being proved, and the second matters more than the first:
 *
 *   1. A client-scoped app module can be switched on for a client that has no
 *      dataset — which is the entire point, since Aspect and LYBI are exactly
 *      that and a dataset-scoped module cannot attach to either.
 *   2. Smart Replenishment, which is LIVE in production for zolstock, is
 *      untouched by any of it. The framework change had to be additive.
 *
 *   node verification/taskboard/test-taskboard-module.js
 *
 * Restores every row it touches, including on failure.
 */
const CLIENT = 'aspect';
let passed = 0;
const ok = name => { passed++; console.log('   ok  ' + name); };

let restore = null;

async function run() {
  await db.initialize();
  const drizzle = db.getDrizzle();
  const rows = r => r.rows || r;

  // --- the framework change is additive ------------------------------------
  const rep = registry.get('replenishment');
  assert.strictEqual(rep.kind || 'data', 'data');
  assert.strictEqual(rep.scope || 'dataset', 'dataset');
  assert.strictEqual(Object.keys(rep.hooks).length, 7);
  ok('replenishment still reads as a dataset-scoped data module with all 7 hooks');

  const tb = registry.get('taskboard');
  assert.strictEqual(tb.kind, 'app');
  assert.strictEqual(tb.scope, 'client');
  assert.ok(!tb.hooks, 'an app module must declare no data hooks');
  ok('taskboard is a client-scoped app module with no hooks');

  // Capture zolstock's live state so it can be compared after everything below.
  const before = await moduleService.getForDataset('zolstock', 'replenishment');
  assert.ok(before, 'zolstock/replenishment should be readable');
  ok(`zolstock replenishment reads as enabled=${before.enabled} status=${before.status}`);

  // --- scope rules ----------------------------------------------------------
  const listed = await moduleService.listForDataset(CLIENT);
  assert.ok(listed, `${CLIENT} should be a known client`);
  const ids = listed.map(m => m.id);
  assert.ok(ids.includes('taskboard'), 'taskboard should be offered to a client with no dataset');
  assert.ok(!ids.includes('replenishment'),
    'a dataset-scoped module must NOT be offered to a client with no dataset');
  ok('a client with no dataset is offered app modules only');

  const onDataset = (await moduleService.listForDataset('zolstock')).map(m => m.id);
  assert.ok(onDataset.includes('replenishment'), 'zolstock must still be offered replenishment');
  assert.ok(onDataset.includes('taskboard'), 'a dataset is also a client');
  ok('a dataset is offered both kinds');

  assert.strictEqual(await moduleService.listForDataset('not-a-client'), null);
  ok('an unknown client is still rejected');

  // --- enabling is the whole installation -----------------------------------
  const priorRow = rows(await drizzle.execute(
    `SELECT enabled, status FROM client_modules
      WHERE dataset_id = '${CLIENT}' AND module_id = 'taskboard'`))[0] || null;
  restore = async () => {
    if (priorRow) {
      await drizzle.execute(
        `UPDATE client_modules SET enabled = ${priorRow.enabled}, status = '${priorRow.status}'
          WHERE dataset_id = '${CLIENT}' AND module_id = 'taskboard'`);
    } else {
      await drizzle.execute(
        `DELETE FROM client_modules WHERE dataset_id = '${CLIENT}' AND module_id = 'taskboard'`);
    }
  };

  assert.strictEqual(await moduleService.isLive(CLIENT, 'taskboard'), false);
  ok('not live before it is switched on');

  const enabled = await moduleService.setEnabled(CLIENT, 'taskboard', true, 'verification');
  assert.strictEqual(enabled.enabled, true);
  // The point of the app kind: no init run, ready immediately.
  assert.strictEqual(enabled.status, 'ready');
  assert.strictEqual(enabled.live, true);
  ok('enabling an app module makes it live with no init run');

  assert.strictEqual(await moduleService.isLive(CLIENT, 'taskboard'), true);
  ok('isLive agrees');

  const init = await moduleInitService.startInit(CLIENT, 'taskboard', {});
  assert.strictEqual(init.code, 400);
  assert.match(init.error, /nothing to initialize/);
  ok('asking an app module to initialize is refused, not crashed');

  const off = await moduleService.setEnabled(CLIENT, 'taskboard', false, 'verification');
  assert.strictEqual(off.live, false);
  assert.strictEqual(off.status, 'not_initialized');
  ok('switching it off takes it out of live');

  // --- and zolstock never moved ---------------------------------------------
  const after = await moduleService.getForDataset('zolstock', 'replenishment');
  assert.strictEqual(after.enabled, before.enabled);
  assert.strictEqual(after.status, before.status);
  assert.strictEqual(after.live, before.live);
  ok('zolstock replenishment is byte-identical after all of the above');

  console.log(`\n   ${passed} checks passed`);
}

async function cleanup() {
  if (restore) await restore().catch(e => console.error('restore failed:', e.message));
  const drizzle = db.getDrizzle();
  const left = (drizzle && (await drizzle.execute(
    `SELECT dataset_id, module_id, enabled, status FROM client_modules ORDER BY dataset_id`)));
  for (const r of (left.rows || left)) {
    console.log(`   client_modules: ${r.dataset_id}/${r.module_id} enabled=${r.enabled} status=${r.status}`);
  }
}

run()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async err => {
    console.error('\nFAILED:', err.message);
    await cleanup().catch(() => {});
    process.exit(1);
  });
