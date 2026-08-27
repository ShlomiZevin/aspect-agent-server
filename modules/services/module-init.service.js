/**
 * Aspect Modules — the init-run orchestrator.
 *
 * Runs a module's setup pipeline for one dataset:
 *
 *   audit  ──▶  ┌─ propose binding ─▶ render + build (scratch) ─▶ verify ─┐
 *   (once)      └──────────── failed? feed probes back, next round ───────┘
 *                                    (max 5 rounds)
 *
 * Success persists the converged binding and sets status='ready'. Exhausting
 * the rounds sets status='failed' and keeps the FULL per-round report — which
 * probe failed, with which numbers, every round — because that report is the
 * only thing that tells a reviewer whether the module is wrong or the client's
 * data is.
 *
 * WHY ROUNDS CAN WORK HERE (plan section 03): the model chooses column
 * mappings and quirk flags from an enumerable set — it never writes SQL that
 * ships. A failed join-rate probe names exactly which mapping to reconsider,
 * so the feedback is actionable rather than "try again".
 *
 * ── Two things this deliberately does NOT do ──
 *
 * 1. It never builds into the live schema. DDL is rendered into a scratch
 *    schema, which is dropped afterwards regardless of outcome. The real
 *    build happens inside the nightly reload (E1), into the shadow schema,
 *    before the atomic swap — the same place every other MV is built.
 *
 * 2. It does not send notifications itself. It calls an injected `onEvent`
 *    callback (default: no-op) at the two points that matter. E2 wires the
 *    outbox provider into that seam, so notification delivery can be built
 *    and tested without touching this file's control flow.
 *
 * Started fire-and-forget on purpose: the admin tab polls `module_runs`
 * rather than holding a request open for a multi-minute pipeline (the
 * insights-jobs pattern). Unlike the reload-scheduler race fixed on
 * 2026-08-27, there is no cross-entity serialization to defeat here — the
 * concurrency guard is a per-(dataset, module) running-row check below.
 */

const db = require('../../services/db.pg');
const { moduleRuns } = require('../../db/schema');
const { eq, and, desc } = require('drizzle-orm');
const moduleRegistry = require('../registry');
const moduleService = require('./module.service');
const datasetRegistry = require('../../insights/datasets/registry');

const MAX_ROUNDS = 5;

/**
 * Stage keys, in pipeline order. `audit` runs once; the other three repeat
 * per round. Stored in module_runs.progress_stage as "<round>:<stage>"
 * ("0:audit" for the pre-round audit), which is enough for the UI to render
 * both a label and a monotonic percentage without a schema change.
 */
const STAGES = ['audit', 'propose_binding', 'render_build', 'verify'];
const ROUND_STAGES = ['propose_binding', 'render_build', 'verify'];
const TOTAL_STEPS = 1 + ROUND_STAGES.length * MAX_ROUNDS;   // audit + 3 per round

const STAGE_LABELS = {
  audit: 'Audit',
  propose_binding: 'Propose binding',
  render_build: 'Render + build',
  verify: 'Verify',
  completed: 'Completed',
  failed: 'Failed',
};

/**
 * Monotonic by construction: `round` only ever increases, and within a round
 * the stage offset only ever increases, so stepIndex can never go backwards.
 * That is the property the progress bar depends on — the insights-jobs lesson
 * was a bar animated against a guessed duration that froze at 96%; this one
 * reflects real pipeline position instead.
 */
function stepIndex(round, stage) {
  if (stage === 'audit') return 0;
  if (stage === 'completed' || stage === 'failed') return TOTAL_STEPS;
  const offset = ROUND_STAGES.indexOf(stage);
  if (offset < 0) return 0;
  return 1 + (Math.max(1, round) - 1) * ROUND_STAGES.length + offset;
}

function parseProgressStage(raw) {
  if (!raw) return { round: 0, stage: 'audit' };
  const [roundPart, stagePart] = String(raw).split(':');
  return { round: Number(roundPart) || 0, stage: stagePart || 'audit' };
}

/** @returns {{round, stage, label, percent}} — what the admin tab renders. */
function describeProgress(run) {
  const { round, stage } = parseProgressStage(run?.progressStage);
  const terminal = run?.status === 'succeeded' || run?.status === 'failed';
  const effectiveStage = terminal ? (run.status === 'succeeded' ? 'completed' : 'failed') : stage;
  const percent = terminal ? 100 : Math.round((stepIndex(round, stage) / TOTAL_STEPS) * 100);
  return {
    round,
    stage: effectiveStage,
    label: round > 0 && !terminal
      ? `Round ${round} · ${STAGE_LABELS[stage] || stage}`
      : (STAGE_LABELS[effectiveStage] || effectiveStage),
    percent,
  };
}

// ── run records ──────────────────────────────────────────────────────────

async function createRun(datasetId, moduleId, kind = 'init') {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.insert(moduleRuns).values({
    datasetId, moduleId, kind, status: 'running', progressStage: '0:audit',
  }).returning();
  return row;
}

async function setStage(runId, round, stage) {
  const drizzle = db.getDrizzle();
  await drizzle.update(moduleRuns)
    .set({ progressStage: `${round}:${stage}` })
    .where(eq(moduleRuns.id, runId));
}

async function finishRun(runId, status, { rounds, report }) {
  const drizzle = db.getDrizzle();
  await drizzle.update(moduleRuns).set({
    status,
    rounds: rounds || null,
    report: report || null,
    finishedAt: new Date(),
    progressStage: status === 'succeeded' ? 'done:completed' : 'done:failed',
  }).where(eq(moduleRuns.id, runId));
}

/** @returns {Object|null} the most recent run for (dataset, module). */
async function getLatestRun(datasetId, moduleId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(moduleRuns)
    .where(and(eq(moduleRuns.datasetId, datasetId), eq(moduleRuns.moduleId, moduleId)))
    .orderBy(desc(moduleRuns.startedAt))
    .limit(1);
  return row || null;
}

async function getRun(runId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(moduleRuns).where(eq(moduleRuns.id, runId)).limit(1);
  return row || null;
}

async function hasRunningRun(datasetId, moduleId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(moduleRuns)
    .where(and(
      eq(moduleRuns.datasetId, datasetId),
      eq(moduleRuns.moduleId, moduleId),
      eq(moduleRuns.status, 'running'),
    )).limit(1);
  return Boolean(row);
}

// ── the pipeline ─────────────────────────────────────────────────────────

/**
 * Build the rendered DDL into a throwaway schema and LEAVE IT STANDING.
 *
 * The caller drops it after verify() has run — see the round loop. An earlier
 * version dropped it in this function's own `finally`, which meant the views
 * were already gone by the time the probes queried them: every probe would
 * have been checking an empty schema and passing or failing for the wrong
 * reason. It did not surface in the stub's tests because the stub renders no
 * DDL at all, which is exactly the kind of gap a test double leaves behind.
 *
 * Empty DDL means there is nothing to build (the stub, and any module whose
 * infrastructure is purely logical), so no schema is created at all — which
 * is what lets the whole lifecycle be exercised offline.
 */
async function buildInScratch(pool, scratchSchema, statements, emit) {
  if (!statements || statements.length === 0) {
    emit(`no DDL to build (0 statements) — skipping scratch schema`);
    return { built: 0, scratchSchema: null };
  }
  if (!pool) throw new Error('module renders DDL but the dataset has no pool');

  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${scratchSchema} CASCADE`);
    await client.query(`CREATE SCHEMA ${scratchSchema}`);
    // Long index/MV builds are legitimate here, but a lock held by someone
    // else is not something to wait on forever — the zer4u crash loop of
    // 2026-08-25 was exactly that shape.
    await client.query('SET statement_timeout = 0');
    await client.query("SET lock_timeout = '2min'");
    for (const stmt of statements) {
      await client.query(stmt);
    }
    emit(`built ${statements.length} statement(s) in ${scratchSchema}`);
    return { built: statements.length, scratchSchema };
  } finally {
    client.release();
  }
}

/**
 * Drop a scratch schema. Always called after verify, in a `finally`, so a
 * failed round cannot leave one behind — on a shared data DB an abandoned
 * scratch schema is duplicated storage nobody will think to look for.
 */
async function dropScratch(pool, scratchSchema, emit) {
  if (!pool || !scratchSchema) return;
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${scratchSchema} CASCADE`);
    emit(`dropped scratch schema ${scratchSchema}`);
  } catch (e) {
    // Never fail a run over cleanup — but say so, because the leftover is
    // real and someone has to remove it.
    emit(`WARNING: could not drop scratch schema ${scratchSchema}: ${e.message}`);
  }
}

function scratchSchemaName(schemaName, moduleId) {
  // Module ids can start with an underscore (`_stub`) and contain characters
  // that are not safe unquoted; normalise to [a-z0-9_].
  const safe = String(moduleId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+/, '');
  return `${schemaName}_mod_${safe || 'module'}_scratch`;
}

/**
 * Run the pipeline to completion. Exported separately from startInit so it
 * can be awaited in tests — startInit deliberately does not await it.
 */
async function runInitPipeline(datasetId, moduleId, runId, { updatedBy, onEvent } = {}) {
  const descriptor = moduleRegistry.get(moduleId);
  const datasetEntry = datasetRegistry.get(datasetId);
  const emitEvent = onEvent || (() => {});

  const log = [];
  const emit = (msg) => {
    log.push(msg);
    console.log(`[modules] ${datasetId}/${moduleId} run#${runId}: ${msg}`);
  };

  const state = await moduleService.getForDataset(datasetId, moduleId);
  const settings = state?.settings || {};
  const rounds = [];

  try {
    await moduleService.setStatus(datasetId, moduleId, 'initializing', updatedBy);

    // ── audit (once, read-only, no LLM) ──
    await setStage(runId, 0, 'audit');
    const startedAudit = Date.now();
    const ctxBase = {
      datasetId,
      moduleId,
      schemaName: datasetEntry?.schemaName || datasetId,
      pool: datasetEntry?.getPool ? datasetEntry.getPool() : null,
      settings,
    };
    const audit = await descriptor.hooks.audit(ctxBase);
    emit(`audit complete (${Date.now() - startedAudit}ms)`);

    let previousFailures = [];

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      // ── propose binding ──
      //
      // A rejected proposal is a ROUND failure, not a fatal one. Structural
      // validation catches a malformed binding in ~1s, before anything is
      // built, and the errors name exactly which fields are wrong — which is
      // the most actionable feedback the loop can possibly carry. Treating it
      // as fatal (the first version did) threw away the retry the rounds
      // exist for, and the very first real init died on round 1 with a
      // perfectly recoverable "demand.qtyCol is required".
      await setStage(runId, round, 'propose_binding');
      let binding;
      try {
        binding = await descriptor.hooks.proposeBinding({
          ...ctxBase, audit, round, previousFailures,
        });
        emit(`round ${round}: binding proposed`);
      } catch (proposeErr) {
        const failures = (proposeErr.bindingErrors || [proposeErr.message])
          .map(e => ({ probe: 'binding_shape', detail: e }));
        rounds.push({
          round, passed: false, probes: failures.map(f => ({ ...f, passed: false })),
          binding: proposeErr.binding ?? null,
          failedProbes: ['binding_shape'],
        });
        emit(`round ${round}: proposal rejected — ${failures.map(f => f.detail).join('; ')}`);
        previousFailures = failures;
        continue;
      }

      // ── render + build in a scratch schema, then verify AGAINST it ──
      //
      // The scratch schema must outlive the build call and be dropped only
      // after the probes have queried it. It is dropped in this round's
      // `finally` so a failed or throwing round cannot leave one behind.
      await setStage(runId, round, 'render_build');
      const scratch = scratchSchemaName(ctxBase.schemaName, moduleId);
      // Target and source are DIFFERENT here: the views are created in the
      // empty scratch schema but read the live data. On the nightly path they
      // are the same schema, because the shadow holds a full fresh copy.
      // Passing them separately is what lets one stored binding serve both.
      const statements = descriptor.hooks.renderInfra(
        binding, { target: scratch, source: ctxBase.schemaName }) || [];
      let build;
      let verification;
      try {
        build = await buildInScratch(ctxBase.pool, scratch, statements, emit);

        await setStage(runId, round, 'verify');
        verification = await descriptor.hooks.verify({
          ...ctxBase, audit, binding, round, build,
          // Probes must query the schema the views were actually built into,
          // not the live one.
          verifySchema: build.scratchSchema || ctxBase.schemaName,
        });
      } finally {
        await dropScratch(ctxBase.pool, build?.scratchSchema, emit);
      }
      const probes = verification?.probes || [];
      const failed = probes.filter(p => !p.passed);
      const passed = Boolean(verification?.passed) && failed.length === 0;

      rounds.push({
        round,
        passed,
        probes,
        // Store the binding per round, not just the final one: when a run
        // fails, "what did it try each time" is the whole diagnostic value.
        binding,
        failedProbes: failed.map(p => p.probe),
      });
      emit(`round ${round}: ${passed ? 'all probes passed' : `failed [${failed.map(p => p.probe).join(', ')}]`}`);

      if (passed) {
        await moduleService.setBinding(datasetId, moduleId, binding, settings.initModel || null, updatedBy);
        await moduleService.setStatus(datasetId, moduleId, 'ready', updatedBy);
        const report = {
          outcome: 'ready',
          roundsUsed: round,
          probesPassed: probes.length,
          audit,
          log,
        };
        await finishRun(runId, 'succeeded', { rounds, report });
        emitEvent({
          datasetId, moduleId, runId, event: 'init_completed',
          payload: { roundsUsed: round, probes: `${probes.length}/${probes.length}` },
        });
        return { status: 'ready', runId, rounds, report };
      }

      // Feed the exact failures forward — this is what makes the next round
      // a revision rather than a re-roll.
      previousFailures = failed;
    }

    // ── rounds exhausted ──
    await moduleService.setStatus(datasetId, moduleId, 'failed', updatedBy);
    const report = {
      outcome: 'failed',
      roundsUsed: MAX_ROUNDS,
      reason: `verification did not converge in ${MAX_ROUNDS} rounds`,
      failedProbesByRound: rounds.map(r => ({ round: r.round, failed: r.failedProbes })),
      audit,
      log,
    };
    await finishRun(runId, 'failed', { rounds, report });
    emitEvent({
      datasetId, moduleId, runId, event: 'init_failed',
      payload: { roundsUsed: MAX_ROUNDS, failedProbesByRound: report.failedProbesByRound },
    });
    return { status: 'failed', runId, rounds, report };

  } catch (err) {
    // A thrown hook (bad SQL, dead pool, LLM outage) must still leave a
    // readable run behind — a run stuck at 'running' forever is worse than a
    // failed one, because nothing can be retried while it looks busy.
    emit(`ERROR: ${err.message}`);
    await moduleService.setStatus(datasetId, moduleId, 'failed', updatedBy).catch(() => {});
    const report = { outcome: 'failed', reason: err.message, stack: err.stack, log };
    await finishRun(runId, 'failed', { rounds, report }).catch(() => {});
    emitEvent({
      datasetId, moduleId, runId, event: 'init_failed',
      payload: { reason: err.message },
    });
    return { status: 'failed', runId, rounds, report, error: err.message };
  }
}

/**
 * Start an init run. Returns as soon as the run row exists; the pipeline
 * continues in the background and the admin tab polls it.
 *
 * @returns {{runId}|{error, code}}
 */
async function startInit(datasetId, moduleId, { updatedBy, onEvent, await: awaitRun } = {}) {
  if (!moduleService.isKnownDataset(datasetId)) {
    return { error: `Unknown dataset: ${datasetId}`, code: 404 };
  }
  if (!moduleRegistry.get(moduleId)) {
    return { error: `Unknown module: ${moduleId}`, code: 404 };
  }
  if (await hasRunningRun(datasetId, moduleId)) {
    return { error: 'An init run is already in progress for this module', code: 409 };
  }

  const run = await createRun(datasetId, moduleId, 'init');
  const promise = runInitPipeline(datasetId, moduleId, run.id, { updatedBy, onEvent });

  if (awaitRun) {
    const result = await promise;
    return { runId: run.id, result };
  }
  // Fire-and-forget by design (see the file header). The pipeline catches its
  // own errors; this catch only exists so an unexpected throw cannot become
  // an unhandled rejection that takes the process down.
  promise.catch(err => console.error(`[modules] init pipeline crashed: ${err.message}`));
  return { runId: run.id };
}

module.exports = {
  MAX_ROUNDS,
  STAGES,
  startInit,
  runInitPipeline,
  getRun,
  getLatestRun,
  hasRunningRun,
  describeProgress,
  // exported for offline tests
  stepIndex,
  parseProgressStage,
  scratchSchemaName,
  TOTAL_STEPS,
};
