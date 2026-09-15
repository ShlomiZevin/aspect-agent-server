/**
 * The build, as a server-side job — because M4's global "BUILDING SCREEN
 * 24%" pill survives navigation, which a page-held stream cannot.
 *
 * Job rows live in `custom_module_builds` and the client polls them (the
 * module_runs / insights-jobs pattern): progress is a stored stage string,
 * the percentage is computed and monotonic by construction, and one running
 * build per screen is enforced by a partial unique index, not by
 * check-then-insert.
 *
 * Pipeline (stage names are what the UI renders — they are the truth, in
 * execution order):
 *
 *   reading_plan       validate the stored plan against the brief (fast)
 *   composing_screen   Opus writes the spec; schema-validated with retries
 *   querying_data      compile + execute every result set and KPI
 *   validating_totals  probes; a failure feeds back into ONE more compose
 *
 * A build that fails leaves the previous spec untouched — the screen the
 * user had stays exactly as it was (v1's rule, kept).
 */

const db = require('../../services/db.pg');
const { customModuleBuilds } = require('../../db/schema');
const { eq, and, desc } = require('drizzle-orm');

const specService = require('./spec.service');
const dataService = require('./data.service');
const probesService = require('./probes.service');
const screensStore = require('./screens.store');

const STAGES = ['reading_plan', 'composing_screen', 'querying_data', 'validating_totals'];
const MAX_PROBE_ROUNDS = 2;

/** "<round>:<stage>" — same encoding module_runs uses. */
function describeProgress(run) {
  if (!run) return null;
  const [roundPart, stage] = String(run.progressStage || '1:reading_plan').split(':');
  const round = Number(roundPart) || 1;
  const terminal = run.status !== 'running';
  const idx = Math.max(0, STAGES.indexOf(stage));
  const totalSteps = STAGES.length * MAX_PROBE_ROUNDS;
  const step = (round - 1) * STAGES.length + idx;
  return {
    buildId: run.id,
    screenId: run.screenId,
    status: run.status,
    stage: terminal ? (run.status === 'succeeded' ? 'done' : 'failed') : stage,
    round,
    percent: terminal ? 100 : Math.min(96, Math.round(((step + 0.5) / totalSteps) * 100)),
    report: terminal ? run.report : null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

async function setStage(buildId, round, stage) {
  const drizzle = db.getDrizzle();
  await drizzle.update(customModuleBuilds)
    .set({ progressStage: `${round}:${stage}` })
    .where(eq(customModuleBuilds.id, buildId));
}

async function finish(buildId, status, report) {
  const drizzle = db.getDrizzle();
  await drizzle.update(customModuleBuilds)
    .set({ status, report: report || null, finishedAt: new Date() })
    .where(eq(customModuleBuilds.id, buildId));
}

async function latestBuild(datasetId, screenId) {
  const drizzle = db.getDrizzle();
  const [row] = await drizzle.select().from(customModuleBuilds)
    .where(and(
      eq(customModuleBuilds.datasetId, datasetId),
      eq(customModuleBuilds.screenId, screenId),
    ))
    .orderBy(desc(customModuleBuilds.startedAt))
    .limit(1);
  return row || null;
}

/** Any build currently running for this dataset — what the nav pill polls. */
async function runningBuilds(datasetId) {
  const drizzle = db.getDrizzle();
  return drizzle.select().from(customModuleBuilds)
    .where(and(
      eq(customModuleBuilds.datasetId, datasetId),
      eq(customModuleBuilds.status, 'running'),
    ));
}

async function runPipeline(buildId, { datasetId, screen, brief, settings, pool, schemaName }) {
  const log = [];
  const emit = (msg) => {
    log.push(msg);
    console.log(`[otto] build#${buildId} ${datasetId}/${screen.id}: ${msg}`);
  };

  try {
    let probeFeedback = null;
    let lastProbes = [];

    for (let round = 1; round <= MAX_PROBE_ROUNDS; round++) {
      await setStage(buildId, round, 'reading_plan');
      // The plan was validated when it was stored, but the brief may have
      // re-initialized since — cheap to re-check, expensive to build wrong.
      const { validatePlan } = require('./spec.contract');
      const planErrors = validatePlan(screen.plan, brief);
      if (planErrors.length) {
        throw Object.assign(new Error('the stored plan no longer matches the brief'), { detail: planErrors });
      }

      await setStage(buildId, round, 'composing_screen');
      const started = Date.now();
      const spec = await specService.buildSpec({
        plan: screen.plan,
        brief,
        settings,
        previousSpec: screen.screenSpec || null,
        probeFeedback,
      });
      emit(`round ${round}: spec composed (${Date.now() - started}ms, ${spec.blocks.length} blocks, ${spec.resultSets.length} result sets)`);

      await setStage(buildId, round, 'querying_data');
      const payload = await dataService.executeSpec(spec, brief, { pool, schemaName, datasetId });
      emit(`round ${round}: queried ${Object.keys(payload.resultSets).length} result set(s)`);

      await setStage(buildId, round, 'validating_totals');
      const verification = probesService.verifyBuild(spec, payload);
      lastProbes = verification.probes;
      const failed = verification.probes.filter(p => !p.passed);
      emit(`round ${round}: ${verification.passed ? 'all probes passed' : `failed [${failed.map(p => p.probe).join(', ')}]`}`);

      if (verification.passed) {
        const stored = await screensStore.storeSpec(datasetId, screen.id, spec);
        if (!stored) throw new Error('the screen was published or deleted while the build ran — spec not stored');
        dataService.invalidate(datasetId, screen.id);
        await finish(buildId, 'succeeded', {
          outcome: 'ready',
          roundsUsed: round,
          probes: verification.probes,
          blocks: spec.blocks.map(b => b.kind),
          log,
        });
        return;
      }
      probeFeedback = failed;
    }

    await finish(buildId, 'failed', {
      outcome: 'failed',
      reason: `verification did not converge in ${MAX_PROBE_ROUNDS} rounds`,
      probes: lastProbes,
      log,
    });
  } catch (err) {
    // A thrown stage must still leave a readable run — a build stuck at
    // 'running' forever blocks every retry behind the unique index.
    emit(`ERROR: ${err.message}`);
    await finish(buildId, 'failed', {
      outcome: 'failed',
      reason: err.message,
      detail: err.detail || err.specErrors || null,
      log,
    }).catch(() => {});
  }
}

/**
 * Start a build. Returns as soon as the row exists; the pipeline continues
 * in the background and the page polls.
 * @returns {{buildId}|{error, code}}
 */
async function startBuild(ctx) {
  const drizzle = db.getDrizzle();
  let run;
  try {
    [run] = await drizzle.insert(customModuleBuilds).values({
      datasetId: ctx.datasetId,
      screenId: ctx.screen.id,
      status: 'running',
      progressStage: '1:reading_plan',
    }).returning();
  } catch (err) {
    if (err?.cause?.code === '23505' || err?.code === '23505') {
      return { error: 'A build is already running for this screen', code: 409 };
    }
    throw err;
  }

  const promise = runPipeline(run.id, ctx);
  if (ctx.await) {
    return promise.then(() => ({ buildId: run.id }));
  }
  promise.catch(err => console.error(`[otto] build pipeline crashed: ${err.message}`));
  return { buildId: run.id };
}

module.exports = { startBuild, latestBuild, runningBuilds, describeProgress, STAGES, MAX_PROBE_ROUNDS };
