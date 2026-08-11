/**
 * Real per-investigation stage tracking, replacing the client's guessed
 * progress bar.
 *
 * The client used to animate a bar against a hardcoded FAKE_DURATION_MS of
 * 8 seconds while a real investigation takes 30-100s (4+ LLM round trips plus
 * a live SQL query). So it raced to its 96% cap in under 8 seconds, sat frozen
 * there for the remaining 20-90s, then snapped to 100% — the exact behaviour
 * reported as "strange, quickly reaches 96%, freezes, then reaches the end".
 * Worse, the five named steps shown to the user were driven off that same fake
 * percentage, so "Double-check the findings" was displayed as complete before
 * the query had even run.
 *
 * POST /investigate is one long-lived request, so progress can't ride on its
 * own response. Instead the caller passes a client-generated jobId, the
 * pipeline reports each real stage transition here, and the client polls
 * GET /:datasetId/progress/:jobId. In-memory and per-instance on purpose:
 * this is ephemeral UI state, not something worth a DB write per stage. If a
 * poll misses (instance restart, or the client reconnecting after a reload),
 * the client falls back to its existing resume-by-diffing path.
 */

/**
 * The five stages the UI names, in order. `typicalMs` is measured from real
 * runs (58-100s end to end across six datasets); `weight` is that duration as
 * a share of the total, so the percentage and the ETA are derived from ONE
 * model rather than two that disagree.
 *
 * Deriving the ETA by extrapolating elapsed÷percent — the obvious approach —
 * is wrong here because progress is deliberately NOT linear in time: it is
 * anchored to stage boundaries and eased within each stage. At 54% (partway
 * into synthesize) that extrapolation reported "about 15s left" when verify
 * alone still had ~12s to run behind a synthesize step that had barely begun.
 */
const STAGES = [
  { key: 'plan',       typicalMs: 6000 },
  { key: 'query',      typicalMs: 30000 },
  { key: 'aggregate',  typicalMs: 1500 },
  { key: 'synthesize', typicalMs: 20000 },
  { key: 'verify',     typicalMs: 12000 },
];
const TOTAL_TYPICAL_MS = STAGES.reduce((a, s) => a + s.typicalMs, 0);
for (const s of STAGES) s.weight = s.typicalMs / TOTAL_TYPICAL_MS;

const STAGE_INDEX = new Map(STAGES.map((s, i) => [s.key, i]));
// Cumulative fraction completed once each stage FINISHES.
const CUMULATIVE = STAGES.reduce((acc, s) => { acc.push((acc[acc.length - 1] ?? 0) + s.weight); return acc; }, []);

const TTL_MS = 15 * 60 * 1000;
const jobs = new Map(); // jobId -> { stage, stageStartedAt, startedAt, done, failed, detail, updatedAt }

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of jobs) if (job.updatedAt < cutoff) jobs.delete(id);
}

function start(jobId) {
  if (!jobId) return;
  sweep();
  const now = Date.now();
  jobs.set(jobId, { stage: 'plan', stageStartedAt: now, startedAt: now, done: false, failed: false, detail: null, updatedAt: now });
}

/**
 * Marks the pipeline as having ENTERED `stage`. `detail` is a short
 * human-readable line the UI can show under the step (e.g. the actual data
 * question the plan settled on), so the progress panel reports what is really
 * happening rather than a generic script.
 */
function set(jobId, stage, detail = null) {
  if (!jobId) return;
  const job = jobs.get(jobId);
  if (!job || job.done) return;
  const now = Date.now();
  job.stage = stage;
  job.stageStartedAt = now;
  job.updatedAt = now;
  if (detail) job.detail = detail;
}

function finish(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.done = true;
  job.stage = 'done';
  job.updatedAt = Date.now();
}

function fail(jobId, message) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.done = true;
  job.failed = true;
  job.detail = message || 'Investigation failed';
  job.updatedAt = Date.now();
}

/**
 * Percentage is anchored to REAL stage boundaries, then eased within the
 * current stage by elapsed time so the bar keeps moving during a long step
 * instead of sitting still. The eased portion is asymptotic (never reaches the
 * next boundary), so progress is monotonic and can't overshoot a stage it
 * hasn't finished — the property the old fake timer lacked.
 */
function get(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.done) {
    return { stage: job.failed ? 'failed' : 'done', percent: job.failed ? 100 : 100, done: true, failed: job.failed, detail: job.detail, elapsedMs: job.updatedAt - job.startedAt };
  }

  const idx = STAGE_INDEX.get(job.stage) ?? 0;
  const floor = idx === 0 ? 0 : CUMULATIVE[idx - 1];
  const ceiling = CUMULATIVE[idx];
  const span = ceiling - floor;

  // Typical duration of this stage; the eased fraction approaches 1 as
  // elapsed grows, so a slow stage still creeps forward without ever
  // claiming completion.
  // Query is the widest-variance stage and got wider when its statement
  // timeout was raised from 15s to 75s (it is background work, not chat), so
  // its easing constant is set from observed runs rather than the old cap.
  const typicalMs = STAGES[idx].typicalMs;
  const elapsed = Date.now() - job.stageStartedAt;
  const eased = 1 - Math.exp(-elapsed / typicalMs);

  // ETA from the SAME stage model that drives the percentage: whatever is left
  // of the current stage, plus the full typical duration of every stage after
  // it. A stage already past its typical duration still reports a floor rather
  // than zero — it plainly is not finished, and counting down to "0s left"
  // while work continues is the dishonesty this replaces.
  const remainingThisStage = Math.max(typicalMs * 0.15, typicalMs - elapsed);
  const remainingLaterStages = STAGES.slice(idx + 1).reduce((a, s) => a + s.typicalMs, 0);

  return {
    stage: job.stage,
    percent: Math.min(99, Math.round(100 * (floor + span * eased))),
    done: false,
    failed: false,
    detail: job.detail,
    elapsedMs: Date.now() - job.startedAt,
    etaMs: Math.round(remainingThisStage + remainingLaterStages),
  };
}

module.exports = { start, set, finish, fail, get, STAGES };
