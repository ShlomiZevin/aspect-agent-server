/**
 * Load tests (task #902) — several simulated conversations released
 * together against one agent, shown as one run.
 *
 * A run is a `test_runs` row of type `load_test`; each of its
 * conversations is an ordinary simulation job (simulationJobs.js) whose
 * `parent_run_id` points at the run. So every conversation opens like any
 * simulation, with its full trail, and every failed turn lands in the error
 * center through the same turn hook. No schema change.
 *
 * ── How a run goes ─────────────────────────────────────────────────
 *
 *   1. Baseline — with more than one conversation, ONE conversation runs
 *      alone first. Its turn times are what "under load" is compared to.
 *   2. Load — then all N conversations: created first, then started either
 *      in the same tick ("together") or spread evenly over a minute
 *      ("ramp").
 *
 * Every turn goes through the public address (`via: 'public'`), like a
 * real user. Fixed scripts by default — every conversation sends identical
 * lines, so a slower turn means a slower server, not a different
 * conversation; a persona (a model playing the user) can be chosen.
 *
 * The run is driven by an orchestrator in this process. Its heartbeat is
 * the run row's `updated_at`; a run whose orchestrator vanished (a deploy)
 * is reported — and saved — as interrupted the next time anyone reads it.
 *
 * ── Cost ───────────────────────────────────────────────────────────
 *
 * Before it starts: conversations × turns × the agent's usual cost per
 * turn (from LLM usage over its recent conversations), plus the simulated
 * user's model for a persona run, plus the baseline conversation. A run
 * whose estimate is over COST_CAP_USD is refused. While it runs, every
 * conversation asks before each turn (simulationJobs.setTurnGate) and the
 * run stops once its real spend reaches the cap.
 *
 * Prices come from services/models.service.js. A model with no known
 * price is counted at the TOP known rate, so the estimate and the cap can
 * only err high — never let a run spend more than it says. The estimate
 * says when that happened.
 */

const db = require('../../services/db.pg');
const { eq, and, desc } = require('drizzle-orm');
const { testRuns } = require('../../db/schema');
const simulationJobs = require('./simulationJobs');
const models = require('../../services/models.service');

const TYPE = 'load_test';
const MAX_CONVERSATIONS = 20;
const MAX_TURNS = 10;
const DEFAULT_TURNS = 5;
const COST_CAP_USD = 20;
const RAMP_MS = 60 * 1000;
/** A run whose orchestrator has been quiet this long is gone (cf. simulation STALE_MS). */
const STALE_MS = simulationJobs.STALE_MS;
/** No usage history yet: assume this per agent turn. Deliberately generous. */
const FALLBACK_TURN_USD = 0.05;
/** The simulated user's call, per turn, for a persona run (tokens, at its model's price). */
const USER_TURN_TOKENS = { in: 2000, out: 150 };
const DEFAULT_SCRIPT = [
  'Hi',
  'What can you help me with?',
  'Tell me a bit more about the first thing you mentioned',
  'How much does it cost?',
  'Thanks, that is all',
];

function drizzle() {
  return db.getDrizzle();
}

function refuse(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const isLive = j => j.status === 'pending' || j.status === 'running';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Prices ────────────────────────────────────────────────────────

/** The highest known list rate — what an unpriced model is counted at. */
function topPrice() {
  let top = { in: 0, out: 0 };
  for (const m of models.MODELS) {
    if (m.price && m.price.in + m.price.out > top.in + top.out) top = m.price;
  }
  return top.in || top.out ? top : { in: 5, out: 25 };
}

function priceOf(modelId) {
  const m = models.getModel(modelId);
  return m && m.price ? { ...m.price, known: true } : { ...topPrice(), known: false };
}

/** USD for usage rows [{ model, inputTokens, outputTokens }], + which models had no price. */
function costOfUsage(rows) {
  let usd = 0;
  const unpriced = new Set();
  for (const r of rows) {
    const p = priceOf(r.model);
    if (!p.known) unpriced.add(r.model);
    usd += ((Number(r.inputTokens) || 0) / 1e6) * p.in + ((Number(r.outputTokens) || 0) / 1e6) * p.out;
  }
  return { usd, unpriced: [...unpriced] };
}

// ─── Estimate ──────────────────────────────────────────────────────

/** The agent's usual cost per user turn, from its recent conversations. */
async function usualTurnCost(slug) {
  const { rows: usage } = await db.query(
    `WITH conv AS (
       SELECT c.id FROM conversations c JOIN agents a ON a.id = c.agent_id
        WHERE a.url_slug = $1 AND c.updated_at > now() - interval '30 days'
        ORDER BY c.updated_at DESC LIMIT 100
     )
     SELECT u.model, SUM(u.input_tokens)::bigint AS "inputTokens", SUM(u.output_tokens)::bigint AS "outputTokens",
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id IN (SELECT id FROM conv) AND m.role = 'user') AS turns
       FROM llm_usage u
      WHERE u.conversation_id IN (SELECT id::text FROM conv)
      GROUP BY u.model`,
    [slug],
  );
  const turns = usage.length ? usage[0].turns : 0;
  const history = turns ? { ...costOfUsage(usage), turns } : null;

  // A load test's scripted turns can be heavier than the agent's everyday
  // average (the 5-at-once run cost 1.6× its estimate). So the agent's own
  // last load test, when there is one, counts too — the higher one wins.
  const last = await lastRunTurnCost(slug);
  const histPerTurn = history ? history.usd / history.turns : null;
  if (last && (histPerTurn == null || last.perTurnUsd > histPerTurn)) {
    return { perTurnUsd: last.perTurnUsd, fromTurns: last.turns, unpriced: last.unpriced, fallback: false, fromRun: last.runId };
  }
  if (!history) return { perTurnUsd: FALLBACK_TURN_USD, fromTurns: 0, unpriced: [], fallback: true };
  return { perTurnUsd: histPerTurn, fromTurns: history.turns, unpriced: history.unpriced, fallback: false };
}

/** Real cost per agent turn of the agent's latest finished load test, or null. */
async function lastRunTurnCost(slug) {
  const [row] = await drizzle().select().from(testRuns)
    .where(and(eq(testRuns.type, TYPE), eq(testRuns.agentName, slug), eq(testRuns.status, 'completed')))
    .orderBy(desc(testRuns.createdAt)).limit(1);
  if (!row) return null;
  const jobs = await simulationJobs.listChildJobs(row.id);
  const turns = jobs.reduce((n, j) => n + (j.turns || 0), 0);
  if (!turns) return null;
  // Agent turns only — the simulated user's share is estimated separately.
  const { usd, unpriced } = await spentUsd({ input: {} }, jobs);
  return { perTurnUsd: usd / turns, turns, unpriced, runId: row.id };
}

/** Validate a setup and return it normalised. Throws a refusal. */
function readSetup(b) {
  const conversations = Number(b.conversations ?? 10);
  if (!Number.isInteger(conversations) || conversations < 1 || conversations > MAX_CONVERSATIONS) {
    throw refuse(400, `"conversations" is how many run at once: 1 to ${MAX_CONVERSATIONS}.`);
  }
  const persona = String(b.persona || '').trim();
  const kind = persona ? 'persona' : 'script';
  let lines = null;
  let turns;
  if (kind === 'script') {
    lines = Array.isArray(b.lines) && b.lines.length
      ? b.lines.map(l => String(l ?? '').trim()).filter(Boolean)
      : DEFAULT_SCRIPT;
    if (lines.length === 0) throw refuse(400, '"lines" has no text in it.');
    if (lines.length > MAX_TURNS) throw refuse(400, `A load test is limited to ${MAX_TURNS} turns per conversation.`);
    turns = lines.length;
  } else {
    turns = Number(b.turns ?? DEFAULT_TURNS);
    if (!Number.isInteger(turns) || turns < 1 || turns > MAX_TURNS) throw refuse(400, `"turns" is 1 to ${MAX_TURNS}.`);
  }
  const start = b.start === 'ramp' ? 'ramp' : 'together';
  const version = b.version === 'published' ? 'published' : 'active';
  let userModel = null;
  if (kind === 'persona') {
    userModel = b.model ? String(b.model).trim() : models.EVERYDAY_MODEL;
    if (!models.getModel(userModel)) throw refuse(400, `Unknown model "${userModel}".`);
  }
  return {
    conversations, kind, lines, persona: persona || null, goal: b.goal ? String(b.goal).trim() : null,
    turns, start, version, userModel,
    baseline: conversations > 1 && b.baseline !== false,
    label: String(b.label || '').trim().slice(0, 80) || null,
  };
}

/**
 * What a run would cost, before anything starts.
 * @returns {{ usd, capUsd, overCap, perTurnUsd, agentTurns, conversations, turns, baseline, basis, unpriced }}
 */
async function estimate({ slug, body }) {
  const setup = readSetup(body || {});
  const usual = await usualTurnCost(slug);
  const convs = setup.conversations + (setup.baseline ? 1 : 0);
  const agentTurns = convs * setup.turns;
  let usd = agentTurns * usual.perTurnUsd;
  const unpriced = new Set(usual.unpriced);
  if (setup.kind === 'persona') {
    const p = priceOf(setup.userModel);
    if (!p.known) unpriced.add(setup.userModel);
    usd += agentTurns * ((USER_TURN_TOKENS.in / 1e6) * p.in + (USER_TURN_TOKENS.out / 1e6) * p.out);
  }
  return {
    usd: Math.round(usd * 10000) / 10000,
    capUsd: COST_CAP_USD,
    overCap: usd > COST_CAP_USD,
    perTurnUsd: Math.round(usual.perTurnUsd * 100000) / 100000,
    agentTurns,
    conversations: setup.conversations,
    turns: setup.turns,
    baseline: setup.baseline,
    basis: usual.fallback
      ? `no usage history for this agent yet — assumed $${FALLBACK_TURN_USD} per turn`
      : usual.fromRun
        ? `the real cost per turn of its last load test (#${usual.fromRun})`
        : `the agent's average over its last ${usual.fromTurns} turns`,
    unpriced: [...unpriced],
  };
}

// ─── Spend while running ───────────────────────────────────────────

/** Real spend of a run so far: its conversations' LLM usage (+ the simulated user, estimated). */
async function spentUsd(row, jobs) {
  const ids = jobs.map(j => j.conversationId).filter(Boolean).map(String);
  let usd = 0;
  let unpriced = [];
  if (ids.length) {
    const { rows } = await db.query(
      `SELECT model, SUM(input_tokens)::bigint AS "inputTokens", SUM(output_tokens)::bigint AS "outputTokens"
         FROM llm_usage WHERE conversation_id = ANY($1::text[]) GROUP BY model`,
      [ids],
    );
    ({ usd, unpriced } = costOfUsage(rows));
  }
  const input = row.input || {};
  if (input.kind === 'persona') {
    // The simulated user's calls are not tied to the conversation in usage — counted from turns done.
    const p = priceOf(input.userModel);
    const turnsDone = jobs.reduce((n, j) => n + (j.turns || 0), 0);
    usd += turnsDone * ((USER_TURN_TOKENS.in / 1e6) * p.in + (USER_TURN_TOKENS.out / 1e6) * p.out);
  }
  return { usd, unpriced };
}

// The gate every conversation of a run asks before each turn. Cached a
// couple of seconds per run so twenty conversations don't each re-sum.
const gateCache = new Map();
async function costGate(runId) {
  const hit = gateCache.get(runId);
  if (hit && Date.now() - hit.at < 2000) return hit.why;
  const [row] = await drizzle().select().from(testRuns).where(eq(testRuns.id, runId)).limit(1);
  let why = null;
  if (row && (row.output || {}).stopRequested) {
    why = row.output.stopRequested;
  } else if (row) {
    const jobs = await simulationJobs.listChildJobs(runId);
    const { usd } = await spentUsd(row, jobs);
    const cap = (row.input || {}).capUsd || COST_CAP_USD;
    if (usd >= cap) why = `the cost cap ($${cap}) was reached`;
  }
  gateCache.set(runId, { at: Date.now(), why });
  return why;
}
simulationJobs.setTurnGate(costGate);

// ─── Shape ─────────────────────────────────────────────────────────

function summarise(jobs) {
  const timings = jobs.flatMap(j => j.timings || []);
  const errorsByKind = {};
  for (const t of timings) if (!t.ok) errorsByKind[t.kind || 'code'] = (errorsByKind[t.kind || 'code'] || 0) + 1;
  for (const j of jobs) {
    // A conversation that failed outside a turn (e.g. could not start) counts once.
    if (j.status === 'failed' && !(j.timings || []).some(t => !t.ok)) errorsByKind.other = (errorsByKind.other || 0) + 1;
  }
  return {
    timing: simulationJobs.timingSummary(timings),
    turnsDone: timings.length,
    errors: Object.values(errorsByKind).reduce((a, b) => a + b, 0),
    errorsByKind,
    addonFailures: timings.reduce((n, t) => n + (t.addonFailures || 0), 0),
  };
}

const ratio = (a, b) => (a && b ? Math.round((a / b) * 100) / 100 : null);

/** "10 at once: turns 1.8× slower, no errors". */
function verdictOf({ conversations, baseline, load }) {
  if (!load.timing) return load.errors ? `${conversations} at once: every turn failed` : null;
  const slower = baseline && baseline.timing ? ratio(load.timing.medianMs, baseline.timing.medianMs) : null;
  const speed = slower == null ? `median turn ${(load.timing.medianMs / 1000).toFixed(1)} s`
    : slower >= 1.15 ? `turns ${slower}× slower`
      : 'turns as fast as one alone';
  const errs = load.errors ? `${load.errors} error${load.errors === 1 ? '' : 's'}` : 'no errors';
  return `${conversations} at once: ${speed}, ${errs}`;
}

/** The run as the Admin screen and the MCP door see it, its conversations included. */
function shape(row, jobs, spend) {
  const input = row.input || {};
  const output = row.output || {};
  const counts = { waiting: 0, running: 0, finished: 0, failed: 0 };
  const baselineId = output.baselineJobId || null;
  const baselineJobs = jobs.filter(j => j.id === baselineId);
  const loadJobs = jobs.filter(j => j.id !== baselineId);
  for (const j of loadJobs) {
    if (j.status === 'pending') counts.waiting++;
    else if (j.status === 'running') counts.running++;
    else if (j.status === 'completed') counts.finished++;
    else counts.failed++; // failed | interrupted
  }
  // Conversations not created yet (baseline still going) are waiting too.
  counts.waiting += Math.max(0, (input.conversations || 0) - loadJobs.length);

  const baseline = baselineJobs.length ? summarise(baselineJobs) : null;
  const load = summarise(loadJobs);
  const loadStart = loadJobs.length ? Math.min(...loadJobs.map(j => new Date(j.createdAt).getTime())) : null;
  const loadEnd = loadJobs.length && loadJobs.every(j => !isLive(j))
    ? Math.max(...loadJobs.map(j => new Date(j.finishedAt || j.updatedAt).getTime())) : null;
  const loadMs = loadStart ? (loadEnd || Date.now()) - loadStart : null;

  return {
    id: row.id,
    agent: row.agentName,
    status: row.status,
    phase: output.phase || (row.status === 'running' ? 'baseline' : 'done'),
    label: input.label || null,
    by: input.by || null,
    version: input.version || 'active',
    via: 'public',
    start: input.start || 'together',
    kind: input.kind || 'script',
    lines: input.lines || null,
    persona: input.persona || null,
    goal: input.goal || null,
    userModel: input.userModel || null,
    turnsEach: input.turns || (input.lines || []).length,
    conversations: input.conversations || loadJobs.length,
    counts,
    baseline: baseline ? { jobId: baselineId, timing: baseline.timing, errors: baseline.errors } : null,
    timing: load.timing,
    slowdown: baseline && baseline.timing && load.timing ? {
      median: ratio(load.timing.medianMs, baseline.timing.medianMs),
      p95: ratio(load.timing.p95Ms, baseline.timing.p95Ms),
    } : null,
    turnsDone: load.turnsDone,
    turnsPlanned: (input.conversations || loadJobs.length) * (input.turns || (input.lines || []).length),
    turnsPerSecond: loadMs && load.turnsDone ? Math.round((load.turnsDone / (loadMs / 1000)) * 100) / 100 : null,
    errors: load.errors,
    errorsByKind: load.errorsByKind,
    addonFailures: load.addonFailures,
    verdict: row.status === 'running' ? null : verdictOf({ conversations: input.conversations, baseline, load }),
    vitals: vitalsOf(output.samples),
    samples: output.samples || [],
    estimate: input.estimate || null,
    costUsd: spend ? Math.round(spend.usd * 10000) / 10000 : null,
    capUsd: input.capUsd || COST_CAP_USD,
    unpriced: spend ? spend.unpriced : [],
    stopped: output.stopped || null,
    error: row.error || null,
    createdAt: row.createdAt,
    finishedAt: output.finishedAt || null,
    previous: null, // filled by listRuns / getRun
    jobs,
  };
}

/** Mark the run finished once its last conversation has ended — or interrupted if its driver vanished. */
async function settle(row, jobs) {
  if (row.status !== 'running') return row;
  const output = row.output || {};
  const done = output.phase === 'load' && jobs.length > 0 && !jobs.some(isLive)
    && jobs.length >= (row.input || {}).conversations + (output.baselineJobId ? 1 : 0);
  if (done) {
    const finishedAt = new Date(Math.max(...jobs.map(j => new Date(j.finishedAt || j.updatedAt).getTime()))).toISOString();
    return save(row.id, { status: 'completed', output: { ...output, phase: 'done', finishedAt } });
  }
  const quiet = Date.now() - new Date(row.updatedAt).getTime() > STALE_MS && !jobs.some(isLive);
  if (quiet) {
    return save(row.id, {
      status: 'interrupted',
      error: 'The server restarted while this load test was running. What ran up to that point is kept.',
      output: { ...output, phase: 'done', finishedAt: new Date().toISOString() },
    });
  }
  return row;
}

/**
 * A run that has ended never changes again: its whole result (with its
 * conversations' turn times and its cost) is frozen into the row once, and
 * every later read takes it from there — no child jobs, no usage sums.
 */
async function freeze(row, run) {
  const frozen = { ...run, previous: null };
  await drizzle().update(testRuns)
    .set({ output: { ...(row.output || {}), frozen } })
    .where(eq(testRuns.id, row.id));
  return frozen;
}

async function save(id, patch) {
  const [row] = await drizzle().update(testRuns).set({ ...patch, updatedAt: new Date() }).where(eq(testRuns.id, id)).returning();
  return row;
}

async function read(row) {
  const out = row.output || {};
  if (row.status !== 'running' && out.frozen) return { ...out.frozen, previous: null };
  const jobs = await simulationJobs.listChildJobs(row.id);
  const settled = await settle(row, jobs);
  const spend = await spentUsd(settled, jobs).catch(() => null);
  const run = shape(settled, jobs, spend);
  if (settled.status !== 'running') return freeze(settled, run);
  return run;
}

/** The run before this one with the same number of conversations — "compared with the one before". */
function attachPrevious(run, all) {
  const prev = all.find(r => r.id < run.id && r.conversations === run.conversations && r.status === 'completed' && r.timing);
  run.previous = prev ? {
    id: prev.id, createdAt: prev.createdAt, medianMs: prev.timing.medianMs, p95Ms: prev.timing.p95Ms,
    errors: prev.errors, verdict: prev.verdict,
  } : null;
  return run;
}

// ─── Release and drive ─────────────────────────────────────────────

function jobBody(setup, label) {
  return setup.kind === 'persona'
    ? { version: setup.version, persona: setup.persona, ...(setup.goal ? { goal: setup.goal } : {}), maxTurns: setup.turns, model: setup.userModel, via: 'public', label, _forwarded: true }
    : { version: setup.version, lines: setup.lines, via: 'public', label, _forwarded: true };
}

/** Wait until a job is no longer pending/running, beating the run's heartbeat. */
/**
 * Wait until these jobs are no longer pending/running. One query for all of
 * them every POLL_MS, and the run's heartbeat every BEAT_MS — a load test
 * must not load the database it is measuring (the first version polled
 * each job every 1.5 s and was ~half of all queries during a run).
 */
const POLL_MS = 3000;
const BEAT_MS = 10000;
async function waitForAll(runId, jobIds, beat) {
  let lastBeat = Date.now();
  for (;;) {
    const jobs = await simulationJobs.listChildJobs(runId);
    const mine = jobs.filter(j => jobIds.includes(j.id));
    if (mine.length && !mine.some(isLive)) return mine;
    if (Date.now() - lastBeat >= BEAT_MS) { await beat(); lastBeat = Date.now(); }
    await sleep(POLL_MS);
  }
}

// ─── This server's own vitals during a run ─────────────────────────
//
// Every SAMPLE_MS while a run is going: memory, CPU, event-loop delay and
// the database pool (connections in use / requests waiting for one). This
// is the instance that drives the run — locally the only one; in
// production turns may land on other instances too (Cloud Run decides),
// whose vitals are not here (task #902 step 7: Google Cloud monitoring).

const SAMPLE_MS = 2000;
const MAX_SAMPLES = 900;

function startSampler(runStart) {
  const samples = [];
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  let lagMax = 0;
  let expected = Date.now() + 100;
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lagMax = Math.max(lagMax, now - expected);
    expected = now + 100;
  }, 100);
  const timer = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpu);
    const pool = db.pool || {};
    samples.push({
      t: now - runStart,
      cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 100),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      loopLagMs: Math.max(0, lagMax),
      dbInUse: (pool.totalCount || 0) - (pool.idleCount || 0),
      dbWaiting: pool.waitingCount || 0,
    });
    if (samples.length > MAX_SAMPLES) samples.shift();
    lastCpu = process.cpuUsage();
    lastAt = now;
    lagMax = 0;
  }, SAMPLE_MS);
  timer.unref(); lagTimer.unref();
  return { samples, stop: () => { clearInterval(timer); clearInterval(lagTimer); } };
}

/** Peaks over the samples — what the result shows. */
function vitalsOf(samples) {
  if (!samples || !samples.length) return null;
  const max = k => Math.max(...samples.map(x => x[k] || 0));
  return {
    samples: samples.length,
    cpuPctMax: max('cpuPct'),
    rssMbMax: max('rssMb'),
    loopLagMsMax: max('loopLagMs'),
    dbInUseMax: max('dbInUse'),
    dbWaitingMax: max('dbWaiting'),
    dbPoolMax: (db.pool && db.pool.options && db.pool.options.max) || null,
  };
}

/** The orchestrator: baseline alone, then the N — all in this process. */
async function drive(runId, slug, by, setup, base) {
  let [row] = await drizzle().select().from(testRuns).where(eq(testRuns.id, runId)).limit(1);
  const label = row.input.label;
  const sampler = startSampler(new Date(row.createdAt).getTime());
  // The samples ride along on every heartbeat, so a reader sees them live.
  const beat = async (patch = {}) => {
    const [cur] = await drizzle().select().from(testRuns).where(eq(testRuns.id, runId)).limit(1);
    return save(runId, { ...patch, output: { ...(cur.output || {}), ...(patch.output || {}), samples: sampler.samples } });
  };
  try {
    if (setup.baseline) {
      const b = await simulationJobs.releaseJob({ slug, by, body: jobBody(setup, `${label} · baseline`), publicBase: base, parentRunId: runId, hold: true });
      row = await beat({ output: { phase: 'baseline', baselineJobId: b.id } });
      simulationJobs.startJob(b.id);
      await waitForAll(runId, [b.id], beat);
      const why = await costGate(runId);
      if (why) {
        await beat({ status: 'completed', output: { phase: 'done', stopped: `stopped before the load phase: ${why}`, finishedAt: new Date().toISOString() } });
        return;
      }
    }

    // Create every conversation first, then start them together or spread over a minute.
    const ids = [];
    try {
      for (let i = 1; i <= setup.conversations; i++) {
        const job = await simulationJobs.releaseJob({
          slug, by, body: jobBody(setup, `${label} · ${i}/${setup.conversations}`), publicBase: base, parentRunId: runId, hold: true,
        });
        ids.push(job.id);
      }
    } catch (err) {
      await save(runId, { error: `Only ${ids.length} of ${setup.conversations} conversations could be created: ${err.message}` });
      if (ids.length === 0) throw err;
    }
    [row] = await drizzle().select().from(testRuns).where(eq(testRuns.id, runId)).limit(1);
    row = await beat({ input: { ...row.input, conversations: ids.length }, output: { phase: 'load' } });

    if (setup.start === 'ramp' && ids.length > 1) {
      const gap = RAMP_MS / ids.length;
      for (let i = 0; i < ids.length; i++) {
        simulationJobs.startJob(ids[i]);
        if (i < ids.length - 1) await sleep(gap);
        if (i % 5 === 4) await beat();
      }
    } else {
      for (const id of ids) simulationJobs.startJob(id);
    }
    // Keep the heartbeat until the last conversation ends; settle() marks it completed.
    await waitForAll(runId, ids, beat);
    sampler.stop();
    await beat();
    await getRun(runId).catch(() => {});
  } catch (err) {
    console.error(`[load-tests] run ${runId} failed:`, err);
    await beat({ status: 'failed', error: err.message, output: { phase: 'done', finishedAt: new Date().toISOString() } }).catch(() => {});
  } finally {
    sampler.stop();
  }
}

/**
 * @param {object} a
 * @param {string} a.slug
 * @param {string} a.by           who releases it
 * @param {object} a.body         { conversations, version?, start?, lines? | persona+goal?+turns?+model?, label?, baseline? }
 * @param {string} a.publicBase   the address the release came in on
 */
async function releaseRun({ slug, by, body, publicBase }) {
  const b = body || {};
  const remote = String(process.env.SIMULATION_SERVICE_URL || '').replace(/\/+$/, '');
  if (remote && !b._forwarded) {
    // The dedicated simulation service runs it; turns still go to OUR address.
    const res = await fetch(`${remote}/api/load-tests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, by, body: { ...b, _forwarded: true, publicBase: b.publicBase || publicBase } }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw refuse(res.status, out.error || `the simulation service refused (${res.status})`);
    return out;
  }
  const base = b.publicBase || publicBase;
  if (!/^https?:\/\/[^/\s]+$/.test(String(base || ''))) {
    throw refuse(400, "Could not tell this server's public address, so the load test cannot go through it.");
  }

  const setup = readSetup(b);
  const est = await estimate({ slug, body: b });
  if (est.overCap) {
    throw refuse(400, `This load test would cost about $${est.usd.toFixed(2)} — over the $${COST_CAP_USD} cap. Use fewer conversations or turns.`);
  }
  const label = setup.label || `${setup.conversations} at once · ${setup.turns} turn${setup.turns === 1 ? '' : 's'}`;

  const [row] = await drizzle().insert(testRuns).values({
    type: TYPE,
    agentName: slug,
    status: 'running',
    input: {
      label, by, version: setup.version, kind: setup.kind, lines: setup.lines, persona: setup.persona, goal: setup.goal,
      userModel: setup.userModel, turns: setup.turns, conversations: setup.conversations, start: setup.start,
      via: 'public', publicBase: base, estimate: est, capUsd: COST_CAP_USD,
    },
    output: { phase: setup.baseline ? 'baseline' : 'load' },
  }).returning();

  setImmediate(() => {
    drive(row.id, slug, by, setup, base).catch(err => console.error(`[load-tests] run ${row.id} crashed:`, err));
  });
  return read(row);
}

/** Ask a running load test to stop: conversations finish their current turn and take no more. */
async function stopRun(id, by) {
  const n = Number(id);
  const [row] = await drizzle().select().from(testRuns).where(and(eq(testRuns.id, n), eq(testRuns.type, TYPE))).limit(1);
  if (!row) throw refuse(404, `No load test ${id}.`);
  if (row.status !== 'running') return read(row);
  const why = `stopped by ${String(by || 'someone').slice(0, 60)}`;
  const saved = await save(n, { output: { ...(row.output || {}), stopRequested: why, stopped: why } });
  gateCache.delete(n);
  return read(saved);
}

// ─── Read ──────────────────────────────────────────────────────────

async function getRun(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw refuse(400, 'The load test id is a number.');
  const [row] = await drizzle().select().from(testRuns)
    .where(and(eq(testRuns.id, n), eq(testRuns.type, TYPE))).limit(1);
  if (!row) throw refuse(404, `No load test ${id}.`);
  const run = await read(row);
  // Previous comparable run: finished runs are frozen, so this reads rows only.
  const older = await drizzle().select().from(testRuns)
    .where(and(eq(testRuns.type, TYPE), eq(testRuns.agentName, row.agentName), eq(testRuns.status, 'completed')))
    .orderBy(desc(testRuns.createdAt)).limit(30);
  const others = older.filter(r => r.id < n && r.output && r.output.frozen).map(r => r.output.frozen);
  return attachPrevious(run, others);
}

async function listRuns({ slug, limit, skip }) {
  const rows = await drizzle().select().from(testRuns)
    .where(and(eq(testRuns.type, TYPE), eq(testRuns.agentName, slug)))
    .orderBy(desc(testRuns.createdAt))
    .limit(Math.min(Math.max(Number(limit) || 30, 1), 100));
  const out = [];
  // The raw samples stay on the one-run read; the list carries only their peaks.
  for (const r of rows) if (r.id !== skip) out.push({ ...(await read(r)), samples: [] });
  if (skip == null) for (const run of out) attachPrevious(run, out);
  return out;
}

module.exports = {
  releaseRun, estimate, stopRun, getRun, listRuns,
  MAX_CONVERSATIONS, MAX_TURNS, COST_CAP_USD, DEFAULT_SCRIPT,
  _internal: { readSetup, verdictOf, costOfUsage, priceOf, summarise },
};
