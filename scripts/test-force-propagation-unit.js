/**
 * Regression test for the cron-retry MV-rebuild-storm bug (2026-08-25/26 zer4u
 * crash loop): startIndexing() resolved its own `force` default correctly but
 * never wrote it back into the `options` object passed downstream, so
 * createViews()'s OWN default (force = true, correct for a manual CLI run)
 * silently won for the cron path too — every automatic retry rebuilt all 12
 * materialized views from scratch instead of skipping the ones already built.
 *
 * Offline, no DB: _assertNotBusy / _createRunInDB / _executeIndexing are
 * stubbed so this asserts only the options object that would reach
 * indexFn() → createViews(), not the real reload machinery.
 */
const DataReloadService = require('../services/data-reload.service.js');

async function run() {
  const svc = new DataReloadService({});
  svc.registerReloader('fake', {});

  svc._assertNotBusy = async () => {};
  svc._createRunInDB = async () => 999;

  let captured = null;
  svc._executeIndexing = async (runId, schemaName, options) => {
    captured = options;
  };

  const cases = [
    { label: 'cron (no options — the actual bug scenario)', args: ['fake', 'cron'], expectForce: false },
    { label: 'manual with force:true (admin re-index button)', args: ['fake', 'manual', { force: true }], expectForce: true },
    { label: 'manual with force:false explicit', args: ['fake', 'manual', { force: false }], expectForce: false },
  ];

  let allPass = true;
  for (const c of cases) {
    captured = null;
    await svc.startIndexing(...c.args);
    const got = captured?.force;
    const pass = got === c.expectForce;
    allPass = allPass && pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} — ${c.label}: options.force passed onward = ${got} (expected ${c.expectForce})`);
  }

  console.log(allPass ? '\nALL PASS (3/3)' : '\nSOME FAILED');
  process.exit(allPass ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
