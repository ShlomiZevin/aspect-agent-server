/**
 * Aspect Modules — live API battery. Needs a running server + DB.
 *
 * Run:  node scripts/test-modules-api.js            (defaults to localhost:3000)
 *       API_BASE=https://… node scripts/test-modules-api.js
 *
 * What it is really for: the byte-identical guarantee (plan guardrail #8) and
 * the two-switch rule. A mock could be made to agree with a bug in either, so
 * both are asserted against a real server writing to a real database.
 *
 * The single most important assertion here is #6: flipping `enabled` on a
 * module that has never been initialized must NOT make it live. If that ever
 * regresses, a client sees a nav item backed by views that were never built.
 *
 * Self-cleaning: everything is done under the `_stub` module and the row is
 * deleted at the end, so a run leaves no state behind in a shared DB.
 */

require('dotenv').config();
const db = require('../services/db.pg');
const moduleService = require('../modules/services/module.service');

const API = (process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.SUPER_ADMIN_KEY || '6724';
const DS = 'zolstock';      // a real registered dataset
const MOD = '_stub';        // the dev-only module

let pass = 0, fail = 0;
function ok(label, condition, detail) {
  if (condition) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

async function api(path, options = {}) {
  const res = await fetch(`${API}/api/modules${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body is fine */ }
  return { status: res.status, body };
}
const asAdmin = (path, options = {}) =>
  api(path, { ...options, headers: { 'x-super-admin-key': KEY, ...(options.headers || {}) } });

async function run() {
  await db.initialize();
  const drizzle = db.getDrizzle();

  // Start from a known-clean state in case a previous run died mid-way.
  await drizzle.execute(`DELETE FROM client_modules WHERE dataset_id='${DS}' AND module_id='${MOD}'`);

  console.log('\n1 · Public status — the byte-identical guarantee');
  {
    const r = await api(`/${DS}`);
    ok('known dataset with no module rows returns 200 + empty list',
      r.status === 200 && Array.isArray(r.body?.modules) && r.body.modules.length === 0,
      `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    const r = await api('/no_such_dataset');
    ok('unknown dataset returns 404', r.status === 404, `HTTP ${r.status}`);
  }

  console.log('\n2 · Admin gate');
  {
    const r = await api(`/admin/${DS}`);
    ok('admin route without the super-admin key returns 403', r.status === 403, `HTTP ${r.status}`);
  }
  {
    const r = await asAdmin(`/admin/${DS}`);
    const stub = r.body?.modules?.find(m => m.id === MOD);
    ok('admin route with the key lists registered modules', r.status === 200 && Boolean(stub),
      `HTTP ${r.status}`);
    ok('an uninitialized module reports status=not_initialized, enabled=false, live=false',
      stub && stub.status === 'not_initialized' && stub.enabled === false && stub.live === false,
      JSON.stringify({ status: stub?.status, enabled: stub?.enabled, live: stub?.live }));
    ok('settings resolve to code defaults with source tags',
      stub && stub.settings.failingProbes === 0 && stub.settingsSources.failingProbes === 'code',
      JSON.stringify({ v: stub?.settings, s: stub?.settingsSources }));
  }
  {
    const r = await asAdmin('/admin/no_such_dataset');
    ok('admin list for an unknown dataset returns 404', r.status === 404, `HTTP ${r.status}`);
  }
  {
    const r = await asAdmin(`/admin/${DS}/no_such_module`);
    ok('admin get for an unknown module returns 404', r.status === 404, `HTTP ${r.status}`);
  }

  console.log('\n3 · enabled alone does NOT make a module live');
  {
    const r = await asAdmin(`/admin/${DS}/${MOD}/enabled`, {
      method: 'PUT', body: JSON.stringify({ enabled: true, updatedBy: 'api-test' }),
    });
    ok('enable round-trips', r.status === 200 && r.body?.enabled === true,
      `HTTP ${r.status} ${JSON.stringify(r.body?.enabled)}`);
    ok('…but live stays false while status is not_initialized', r.body?.live === false,
      `live=${r.body?.live} status=${r.body?.status}`);
  }
  {
    const r = await api(`/${DS}`);
    ok('…and the public list is STILL empty (the assertion that matters)',
      r.body?.modules?.length === 0, JSON.stringify(r.body?.modules));
  }

  console.log('\n4 · ready + enabled = live');
  {
    // The init orchestrator owns this transition (A3); here it is simulated so
    // the gate itself can be tested independently of the pipeline.
    await moduleService.setStatus(DS, MOD, 'ready', 'api-test');
    const r = await api(`/${DS}`);
    ok('public list now contains the module',
      r.body?.modules?.length === 1 && r.body.modules[0].id === MOD,
      JSON.stringify(r.body?.modules));
    ok('public payload carries only id + bilingual name (no settings/binding leak)',
      r.body?.modules?.[0] && Object.keys(r.body.modules[0]).sort().join(',') === 'id,name',
      Object.keys(r.body?.modules?.[0] || {}).join(','));
    ok('isLive() agrees', await moduleService.isLive(DS, MOD));
  }

  console.log('\n5 · disabling removes it cleanly');
  {
    await asAdmin(`/admin/${DS}/${MOD}/enabled`, {
      method: 'PUT', body: JSON.stringify({ enabled: false }),
    });
    const r = await api(`/${DS}`);
    ok('public list is empty again', r.body?.modules?.length === 0, JSON.stringify(r.body?.modules));
    ok('…but the status is preserved (disable must not discard init work)',
      (await moduleService.getState(DS, MOD))?.status === 'ready');
  }

  console.log('\n6 · settings save');
  {
    const r = await asAdmin(`/admin/${DS}/${MOD}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ settings: { failingProbes: 2, bogusKey: 'nope' }, updatedBy: 'api-test' }),
    });
    ok('declared setting is saved and tagged as module-level',
      r.body?.settings?.failingProbes === 2 && r.body?.settingsSources?.failingProbes === 'module',
      JSON.stringify({ v: r.body?.settings, s: r.body?.settingsSources }));
    ok('undeclared key is dropped, not stored',
      r.body?.settings?.bogusKey === undefined, JSON.stringify(r.body?.settings));
    ok('untouched setting still resolves from code default',
      r.body?.settings?.simulatedDelayMs === 0 && r.body?.settingsSources?.simulatedDelayMs === 'code');
  }
  {
    const r = await asAdmin(`/admin/${DS}/${MOD}/enabled`, { method: 'PUT', body: JSON.stringify({}) });
    ok('a malformed enabled body returns 400', r.status === 400, `HTTP ${r.status}`);
  }
  {
    const r = await asAdmin(`/admin/${DS}/${MOD}/settings`, {
      method: 'PUT', body: JSON.stringify({ settings: 'not-an-object' }),
    });
    ok('a malformed settings body returns 400', r.status === 400, `HTTP ${r.status}`);
  }

  console.log('\n7 · other datasets are untouched throughout');
  {
    const r = await api('/hypertoy');
    ok('a sibling dataset still reports no modules',
      r.status === 200 && r.body?.modules?.length === 0, JSON.stringify(r.body));
  }

  // ── cleanup ──
  await drizzle.execute(`DELETE FROM client_modules WHERE dataset_id='${DS}' AND module_id='${MOD}'`);
  const left = await drizzle.execute(
    `SELECT count(*)::int n FROM client_modules WHERE dataset_id='${DS}' AND module_id='${MOD}'`);
  const remaining = (left.rows || left)[0].n;
  console.log(`\ncleanup: ${remaining} test rows remaining (expected 0)`);
  ok('test state removed', remaining === 0);

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => { console.error('Battery failed:', err); process.exit(1); });
