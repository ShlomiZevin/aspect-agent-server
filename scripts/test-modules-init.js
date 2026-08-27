/**
 * Aspect Modules — init-orchestrator battery (A3).
 *
 * Needs the platform DB (module_runs / client_modules); needs no LLM, no
 * data-DB and no HTTP server, because the `_stub` module implements the whole
 * hook contract with fixed values and EMPTY DDL.
 *
 * Run: node scripts/test-modules-init.js
 *
 * The three things A3 has to prove:
 *   1. a clean run converges and lands in `ready`
 *   2. a run whose probes never pass exhausts all 5 rounds, lands in `failed`,
 *      and the stored report names the failing probe FOR EVERY ROUND — that
 *      report is the only thing telling a reviewer whether the module is
 *      wrong or the client's data is
 *   3. progress stages are monotonic — the bar must never go backwards
 *
 * Self-cleaning: everything runs under `_stub` on a real dataset id, and both
 * the client_modules row and every module_runs row are deleted at the end.
 */

require('dotenv').config();
const db = require('../services/db.pg');
const moduleService = require('../modules/services/module.service');
const initService = require('../modules/services/module-init.service');

const DS = 'zolstock';
const MOD = '_stub';

let pass = 0, fail = 0;
function ok(label, condition, detail) {
  if (condition) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

async function cleanup(drizzle) {
  await drizzle.execute(`DELETE FROM module_outbox  WHERE dataset_id='${DS}' AND module_id='${MOD}'`);
  await drizzle.execute(`DELETE FROM module_runs    WHERE dataset_id='${DS}' AND module_id='${MOD}'`);
  await drizzle.execute(`DELETE FROM client_modules WHERE dataset_id='${DS}' AND module_id='${MOD}'`);
}

async function run() {
  await db.initialize();
  const drizzle = db.getDrizzle();
  await cleanup(drizzle);

  // ── 0 · pure progress arithmetic, before touching anything ──
  console.log('\n0 · Progress is monotonic by construction');
  {
    const seq = [];
    seq.push(initService.stepIndex(0, 'audit'));
    for (let r = 1; r <= initService.MAX_ROUNDS; r++) {
      for (const s of ['propose_binding', 'render_build', 'verify']) {
        seq.push(initService.stepIndex(r, s));
      }
    }
    seq.push(initService.stepIndex(0, 'completed'));
    const nonDecreasing = seq.every((v, i) => i === 0 || v >= seq[i - 1]);
    const strictlyIncreasingUpToEnd = seq.slice(0, -1).every((v, i) => i === 0 || v > seq[i - 1]);
    ok('full stage sequence never decreases', nonDecreasing, seq.join(','));
    ok('…and strictly increases through every round', strictlyIncreasingUpToEnd, seq.join(','));
    ok('the last step equals TOTAL_STEPS', seq[seq.length - 1] === initService.TOTAL_STEPS,
      `${seq[seq.length - 1]} vs ${initService.TOTAL_STEPS}`);
  }
  {
    // The scratch schema name must be a safe identifier even for a module id
    // that starts with an underscore.
    const name = initService.scratchSchemaName('zolstock', '_stub');
    ok('scratch schema name is a safe identifier', /^[a-z][a-z0-9_]*$/.test(name), name);
  }

  // ── 1 · happy path ──
  console.log('\n1 · A clean run converges to ready');
  {
    await moduleService.saveSettings(DS, MOD, { failingProbes: 0 }, 'init-test');
    const started = await initService.startInit(DS, MOD, { updatedBy: 'init-test', await: true });
    ok('startInit returns a runId', Boolean(started.runId), JSON.stringify(started));
    ok('pipeline reports ready', started.result?.status === 'ready', started.result?.status);

    const state = await moduleService.getForDataset(DS, MOD);
    ok('client_modules.status is ready', state?.status === 'ready', state?.status);
    ok('a binding was persisted', Boolean(state?.binding), JSON.stringify(state?.binding));
    ok('module is still NOT live (never enabled)', state?.live === false,
      `enabled=${state?.enabled} live=${state?.live}`);

    const run = await initService.getRun(started.runId);
    ok('run row is succeeded', run?.status === 'succeeded', run?.status);
    ok('run finished_at is set', Boolean(run?.finishedAt));
    ok('it converged in one round', run?.report?.roundsUsed === 1, String(run?.report?.roundsUsed));
    ok('the audit is stored on the report', Boolean(run?.report?.audit));

    const prog = initService.describeProgress(run);
    ok('progress reports 100% when finished', prog.percent === 100, String(prog.percent));
    ok('progress stage reads "completed"', prog.stage === 'completed', prog.stage);
  }

  // ── 2 · forced failure exhausts the rounds ──
  console.log('\n2 · Probes that never pass exhaust 5 rounds and fail readably');
  {
    await moduleService.saveSettings(DS, MOD, { failingProbes: 99 }, 'init-test');
    const started = await initService.startInit(DS, MOD, { updatedBy: 'init-test', await: true });
    ok('pipeline reports failed', started.result?.status === 'failed', started.result?.status);

    const state = await moduleService.getForDataset(DS, MOD);
    ok('client_modules.status is failed', state?.status === 'failed', state?.status);

    const run = await initService.getRun(started.runId);
    ok('run row is failed', run?.status === 'failed', run?.status);
    ok(`all ${initService.MAX_ROUNDS} rounds were used`,
      run?.report?.roundsUsed === initService.MAX_ROUNDS, String(run?.report?.roundsUsed));
    ok('rounds array holds one entry per round',
      Array.isArray(run?.rounds) && run.rounds.length === initService.MAX_ROUNDS,
      String(run?.rounds?.length));

    const byRound = run?.report?.failedProbesByRound || [];
    ok('the report names the failing probe for EVERY round',
      byRound.length === initService.MAX_ROUNDS && byRound.every(r => r.failed.includes('join_rate')),
      JSON.stringify(byRound));

    const detailed = (run?.rounds || []).every(r =>
      r.probes.some(p => !p.passed && /61\.9%.*95%/.test(p.detail || '')));
    ok('each round records the probe detail with its numbers, not just a flag', detailed,
      JSON.stringify(run?.rounds?.[0]?.probes));

    ok('every round also stores the binding it tried',
      (run?.rounds || []).every(r => r.binding && typeof r.binding === 'object'));
    ok('failure feedback is carried into the next round',
      (run?.rounds || []).slice(1).every(r => (r.binding.revisedAfter || []).includes('join_rate')),
      JSON.stringify(run?.rounds?.[1]?.binding));

    const prog = initService.describeProgress(run);
    ok('progress reports 100% and stage "failed"', prog.percent === 100 && prog.stage === 'failed',
      `${prog.percent}% ${prog.stage}`);
  }

  // ── 3 · converging late ──
  console.log('\n3 · A run that fails twice then converges');
  {
    await moduleService.saveSettings(DS, MOD, { failingProbes: 2 }, 'init-test');
    const started = await initService.startInit(DS, MOD, { updatedBy: 'init-test', await: true });
    ok('pipeline reports ready', started.result?.status === 'ready', started.result?.status);
    const run = await initService.getRun(started.runId);
    ok('it used exactly 3 rounds', run?.report?.roundsUsed === 3, String(run?.report?.roundsUsed));
    ok('rounds 1-2 failed and round 3 passed',
      run?.rounds?.[0]?.passed === false && run?.rounds?.[1]?.passed === false && run?.rounds?.[2]?.passed === true,
      JSON.stringify((run?.rounds || []).map(r => r.passed)));
    ok('status recovered to ready after earlier failures',
      (await moduleService.getForDataset(DS, MOD))?.status === 'ready');
  }

  // ── 4 · concurrency guard ──
  console.log('\n4 · Concurrent init runs are refused');
  {
    await moduleService.saveSettings(DS, MOD, { failingProbes: 0, simulatedDelayMs: 300 }, 'init-test');
    const first = await initService.startInit(DS, MOD, { updatedBy: 'init-test' }); // not awaited
    const second = await initService.startInit(DS, MOD, { updatedBy: 'init-test' });
    ok('the second start is refused with 409', second.code === 409, JSON.stringify(second));

    // Let the first finish so it does not leak into later assertions.
    for (let i = 0; i < 60 && await initService.hasRunningRun(DS, MOD); i++) {
      await new Promise(r => setTimeout(r, 200));
    }
    const run = await initService.getRun(first.runId);
    ok('the first run completed normally', run?.status === 'succeeded', run?.status);
  }

  // ── 5 · progress observed mid-run ──
  console.log('\n5 · Progress advances monotonically during a real run');
  {
    await moduleService.saveSettings(DS, MOD, { failingProbes: 1, simulatedDelayMs: 250 }, 'init-test');
    const started = await initService.startInit(DS, MOD, { updatedBy: 'init-test' });

    const seen = [];
    for (let i = 0; i < 80; i++) {
      const run = await initService.getRun(started.runId);
      const p = initService.describeProgress(run);
      if (!seen.length || seen[seen.length - 1].percent !== p.percent) seen.push(p);
      if (run?.status !== 'running') break;
      await new Promise(r => setTimeout(r, 100));
    }

    ok('more than one distinct progress value was observed', seen.length > 1,
      seen.map(s => `${s.percent}%`).join(' -> '));
    ok('observed percentages never decrease',
      seen.every((s, i) => i === 0 || s.percent >= seen[i - 1].percent),
      seen.map(s => `${s.percent}%`).join(' -> '));
    ok('the run ends at 100%', seen[seen.length - 1].percent === 100,
      seen.map(s => `${s.percent}%`).join(' -> '));
    ok('labels name the round while running',
      seen.some(s => /^Round \d+ · /.test(s.label)), seen.map(s => s.label).join(' | '));
  }

  // ── 6 · events fired at the seam E2 will use ──
  console.log('\n6 · Lifecycle events are emitted for the notification provider');
  {
    const events = [];
    await moduleService.saveSettings(DS, MOD, { failingProbes: 0, simulatedDelayMs: 0 }, 'init-test');
    await initService.startInit(DS, MOD, { updatedBy: 'init-test', await: true, onEvent: e => events.push(e) });
    ok('init_completed is emitted on success',
      events.some(e => e.event === 'init_completed'), JSON.stringify(events.map(e => e.event)));

    events.length = 0;
    await moduleService.saveSettings(DS, MOD, { failingProbes: 99 }, 'init-test');
    await initService.startInit(DS, MOD, { updatedBy: 'init-test', await: true, onEvent: e => events.push(e) });
    ok('init_failed is emitted on exhaustion',
      events.some(e => e.event === 'init_failed'), JSON.stringify(events.map(e => e.event)));
    ok('the failure event carries the per-round probe detail',
      events[0]?.payload?.failedProbesByRound?.length === initService.MAX_ROUNDS,
      JSON.stringify(events[0]?.payload));
  }

  // ── 7 · unknowns ──
  console.log('\n7 · Unknown dataset / module');
  {
    const a = await initService.startInit('no_such_dataset', MOD, {});
    ok('unknown dataset returns 404', a.code === 404, JSON.stringify(a));
    const b = await initService.startInit(DS, 'no_such_module', {});
    ok('unknown module returns 404', b.code === 404, JSON.stringify(b));
  }

  // ── cleanup ──
  await cleanup(drizzle);
  const left = await drizzle.execute(`
    SELECT (SELECT count(*) FROM client_modules WHERE dataset_id='${DS}' AND module_id='${MOD}')
         + (SELECT count(*) FROM module_runs    WHERE dataset_id='${DS}' AND module_id='${MOD}') AS n`);
  const remaining = Number((left.rows || left)[0].n);
  console.log(`\ncleanup: ${remaining} test rows remaining (expected 0)`);
  ok('test state removed', remaining === 0);

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => { console.error('Battery failed:', err); process.exit(1); });
