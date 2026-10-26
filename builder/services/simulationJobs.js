/**
 * Simulation jobs (task #897, phase 1).
 *
 * A job = ONE simulated conversation that runs on the server by itself.
 * An outside assistant releases it through `/builder/mcp` with all the
 * details inside (agent, version, scenario, the model that plays the
 * user); it gets an id back at once, the job keeps running in the
 * background, and Admin → Simulations shows the jobs with their status
 * and their conversation.
 *
 * Deliberately the minimum: one conversation per job, no cancel, no
 * grading, no saved scenarios. A batch later is simply several jobs.
 *
 * ── How it runs ────────────────────────────────────────────────────
 *
 * In this process, after the request that released it has answered. The
 * service is deployed always-on (`--no-cpu-throttling`, see deploy.sh),
 * so background work is ordinary work here. Each turn goes through the
 * same building blocks an assistant uses itself (mcpConversations.js):
 * the user's line comes from the script or from `userReply`, and
 * `sendMessage` runs it as a real turn. The conversation is created up
 * front, so its id is known the moment the job is released.
 *
 * ── A separate simulation service, later ───────────────────────────
 *
 * Same code, another deployment, so test runs don't load the server
 * customers talk to. Both share the database, so reading jobs works from
 * either; only RELEASING a job must reach the service that will run it.
 * Set `SIMULATION_SERVICE_URL` on the main server and `releaseJob`
 * forwards there instead of running locally. Nothing else changes.
 *
 * ── Interrupted jobs ───────────────────────────────────────────────
 *
 * A deploy replaces the process and cuts a running job. Every turn bumps
 * the row's `updatedAt`, so a job still "running" with no heartbeat for
 * STALE_MS is reported — and saved — as `interrupted` the next time
 * anyone reads it. Decided at read time rather than at startup so that
 * one instance starting can never mark another instance's live job.
 *
 * Storage: the existing `test_runs` table, `type = 'simulation'`
 * (`input` = the setup, `output` = progress and result). No schema change.
 *
 * ── Timed turns and the public address (load tests, task #902) ─────
 *
 * Every turn's time is kept (`output.timings`: how long, when, and — for a
 * failed turn — the kind of error, in the error center's words). A job
 * released with `via: 'public'` sends its turns through the server's public
 * address instead of straight to its own process, like a real user, so
 * routing between instances is part of what is measured. The address is
 * the one the release came in on (`publicBase`) — production when released
 * from production, a local server when released locally. One such
 * conversation alone is the baseline a load test compares against.
 */

const db = require('../../services/db.pg');
const { eq, and, desc, asc, isNull } = require('drizzle-orm');
const { testRuns } = require('../../db/schema');
const mcpConversations = require('./mcpConversations');
const errorCenter = require('./errorCenter');
const models = require('../../services/models.service');
const simulationLimits = require('./simulationLimits');

const TYPE = 'simulation';
const DEFAULT_MAX_TURNS = 12;
const MAX_TURNS_CAP = 30;
const MAX_LINES = 40;
/** A turn takes seconds, rarely a minute or two; ten quiet minutes = gone. */
const STALE_MS = 10 * 60 * 1000;
/** A public-address turn that takes longer than this counts as a timeout. */
const PUBLIC_TURN_TIMEOUT_MS = 3 * 60 * 1000;

function drizzle() {
  return db.getDrizzle();
}

function refuse(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Median and slowest-5% of the turns that answered; null when none did. */
function timingSummary(timings) {
  const ms = (timings || []).filter(t => t.ok).map(t => t.ms).sort((a, b) => a - b);
  if (ms.length === 0) return null;
  const at = q => ms[Math.min(ms.length - 1, Math.ceil(q * ms.length) - 1)];
  return {
    turns: ms.length,
    medianMs: ms.length % 2 ? ms[(ms.length - 1) / 2] : Math.round((ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2),
    p95Ms: at(0.95),
    maxMs: ms[ms.length - 1],
  };
}

/** The error center's kind for a failed turn (rate limit, timeout, our code…). */
function turnErrorKind(err) {
  if (err && err.turnFailure) return errorCenter.classify(new Error(err.turnFailure));
  // The address itself refused the turn (Cloud Run 429 = no free instance,
  // 5xx = it failed): our server, not the model.
  if (err && (err.upstreamStatus === 429 || err.upstreamStatus >= 500)) return 'server_unavailable';
  return errorCenter.classify({
    message: err && err.message, status: err && err.upstreamStatus, code: err && err.code, name: err && err.name,
  });
}

/** What the door and the Admin screen see. */
function shape(row) {
  const input = row.input || {};
  const output = row.output || {};
  return {
    id: row.id,
    agent: row.agentName,
    status: row.status,
    label: input.label || null,
    by: input.by || null,
    version: input.version || 'active',
    kind: Array.isArray(input.lines) ? 'script' : 'persona',
    persona: input.persona || null,
    goal: input.goal || null,
    lines: Array.isArray(input.lines) ? input.lines : null,
    userModel: Array.isArray(input.lines) ? null : (output.userModel || input.model || models.EVERYDAY_MODEL),
    maxTurns: input.maxTurns || null,
    startCrew: input.startCrew || null,
    fields: input.fields || null,
    conversationId: input.conversationId || null,
    loadTestId: row.parentRunId || null,
    turns: output.turns || 0,
    via: input.via === 'public' ? 'public' : 'direct',
    timings: output.timings || [],
    timing: timingSummary(output.timings),
    stopped: output.stopped || null,
    endedInCrew: output.endedInCrew || null,
    error: row.error || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: output.finishedAt || null,
  };
}

async function save(id, patch) {
  const [row] = await drizzle().update(testRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(testRuns.id, id))
    .returning();
  return row;
}

/** A "running" job nobody has touched for STALE_MS was cut off. */
async function settleIfStale(row) {
  if (row.status !== 'running' && row.status !== 'pending') return row;
  if (Date.now() - new Date(row.updatedAt).getTime() < STALE_MS) return row;
  return save(row.id, {
    status: 'interrupted',
    error: 'The server restarted while this simulation was running. The conversation up to that point is kept.',
    output: { ...(row.output || {}), stopped: 'the server restarted', finishedAt: new Date().toISOString() },
  });
}

// ─── Release ───────────────────────────────────────────────────────

/** Validate the setup and return it normalised. Throws a refusal. */
function readSetup(b) {
  const hasLines = Array.isArray(b.lines) && b.lines.length > 0;
  const persona = String(b.persona || '').trim();
  if (!hasLines && !persona) {
    throw refuse(400, 'A simulation needs a scenario: either "persona" (who the user is — the platform writes their lines) or "lines" (a list of the user\'s messages, sent in order).');
  }
  if (hasLines && persona) {
    throw refuse(400, 'Send either "persona" or "lines", not both — a scripted user and a played user are different kinds of test.');
  }
  const setup = {};
  if (hasLines) {
    const lines = b.lines.map(l => String(l ?? '').trim()).filter(Boolean);
    if (lines.length === 0) throw refuse(400, '"lines" has no text in it.');
    if (lines.length > MAX_LINES) throw refuse(400, `"lines" is limited to ${MAX_LINES} messages per simulation.`);
    setup.lines = lines;
  } else {
    setup.persona = persona;
    if (b.goal) setup.goal = String(b.goal).trim();
    // The cap is the team's setting (Admin → Simulations → Limits, #926).
    const cap = simulationLimits.limitsNow().maxTurnsPerSimulation || MAX_TURNS_CAP;
    setup.maxTurns = Math.max(1, Math.min(Number(b.maxTurns) || Math.min(DEFAULT_MAX_TURNS, cap), cap));
    if (b.model) {
      const modelId = String(b.model).trim();
      if (!models.getModel(modelId)) {
        const ids = models.MODELS.map(m => m.id).join(', ');
        throw refuse(400, `Unknown model "${modelId}". Leave "model" out to use ${models.EVERYDAY_MODEL}, or pick one of: ${ids}.`);
      }
      setup.model = modelId;
    }
  }
  return setup;
}

/**
 * Release one simulation. Resolves as soon as the job exists; the
 * conversation runs after that, on its own.
 *
 * @param {object} a
 * @param {string} a.slug   the agent
 * @param {string} a.by     roster name of the person whose assistant asks
 * @param {object} a.body   { version?, label?, persona?, goal?, lines?,
 *                            maxTurns?, model?, startCrew?, fields?, via? }
 * @param {string} [a.publicBase] the address the release came in on —
 *                            where `via: 'public'` turns are sent
 * @param {number} [a.parentRunId] the load test this job belongs to
 *                            (builder/services/loadTests.js)
 * @param {boolean} [a.hold]  create the job but do not start it — the
 *                            caller starts it with startJob(), so a load
 *                            test can start all of its conversations at once
 */
async function releaseJob({ slug, by, body, publicBase, parentRunId, hold }) {
  const b = { ...(body || {}) };
  if (b.via != null && b.via !== 'public' && b.via !== 'direct') {
    throw refuse(400, '"via" is "direct" (the default — straight to the server running the job) or "public" (through the public address, like a real user).');
  }
  // Decided where the release came in; a forwarded release keeps it.
  if (b.via === 'public' && !b.publicBase) b.publicBase = publicBase;
  if (b.via === 'public' && !/^https?:\/\/[^/\s]+$/.test(String(b.publicBase || ''))) {
    throw refuse(400, "Could not tell this server's public address, so the simulation cannot go through it. Release it again, or use \"via\": \"direct\".");
  }
  const remote = String(process.env.SIMULATION_SERVICE_URL || '').replace(/\/+$/, '');
  if (remote && !b._forwarded) {
    // The dedicated simulation service runs it; this server only passes it on.
    const res = await fetch(`${remote}/api/simulations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, by, body: { ...b, _forwarded: true } }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw refuse(res.status, out.error || `the simulation service refused (${res.status})`);
    return out;
  }

  const setup = readSetup(b);
  const label = String(b.label || '').trim().slice(0, 80)
    || (setup.persona ? setup.persona.slice(0, 60) : `script, ${setup.lines.length} line${setup.lines.length === 1 ? '' : 's'}`);

  // The conversation first — refuses an unknown agent, version or crew
  // with a sentence, and gives the job its conversation id from the start.
  const base = b.via === 'public' ? b.publicBase : undefined;
  const conv = await mcpConversations.startConversation({
    slug, by, version: b.version, label, startCrew: b.startCrew, fields: b.fields, base,
  });

  const [row] = await drizzle().insert(testRuns).values({
    type: TYPE,
    ...(parentRunId ? { parentRunId } : {}),
    agentName: slug,
    status: 'pending',
    input: {
      ...setup,
      label,
      by,
      version: conv.version,
      conversationId: conv.conversationId,
      ...(conv.crew ? { startCrew: conv.crew.name } : {}),
      ...(b.fields ? { fields: b.fields } : {}),
      ...(base ? { via: 'public', publicBase: base } : {}),
    },
    output: { turns: 0, timings: [] },
  }).returning();

  if (!hold) startJob(row.id);
  return shape(row);
}

/** Set by loadTests.js: (loadTestId) → null to go on, or why to stop. */
let turnGate = null;
function setTurnGate(fn) {
  turnGate = fn;
}

/** Run a released job after the current request has answered. Never let it take the process down. */
function startJob(id) {
  setImmediate(() => {
    runJob(id).catch(err => console.error(`[simulations] job ${id} crashed:`, err));
  });
}

// ─── Run ───────────────────────────────────────────────────────────

async function runJob(id) {
  const [row] = await drizzle().select().from(testRuns).where(eq(testRuns.id, id)).limit(1);
  if (!row || row.type !== TYPE || row.status !== 'pending') return;
  const input = row.input || {};
  const conversationId = input.conversationId;
  let output = { ...(row.output || {}), turns: 0, timings: [] };
  await save(id, { status: 'running', output });
  const base = input.via === 'public' ? input.publicBase : undefined;

  // One timed turn. A failed turn is timed too, with its kind, and then
  // ends the job as before (the catch below).
  const say = async text => {
    const at = new Date().toISOString();
    const t0 = Date.now();
    let reply;
    try {
      reply = await mcpConversations.sendMessage({
        conversationId, text, base, ...(base ? { timeoutMs: PUBLIC_TURN_TIMEOUT_MS } : {}),
      });
    } catch (err) {
      output = { ...output, timings: [...output.timings, { turn: output.turns + 1, at, ms: Date.now() - t0, ok: false, kind: turnErrorKind(err) }] };
      throw err;
    }
    const addonFailures = (reply.addons || []).filter(a => a.status === 'error').length;
    const timing = { turn: output.turns + 1, at, ms: Date.now() - t0, ok: true, ...(addonFailures ? { addonFailures } : {}) };
    output = { ...output, turns: output.turns + 1, timings: [...output.timings, timing] };
    await save(id, { output }); // also the heartbeat
  };

  // A load test's job asks before every turn whether it may go on (the
  // $20 cap, task #902). Null = go on; a sentence = stop, saying why.
  const gate = async () => {
    if (!turnGate || !row.parentRunId) return null;
    try { return await turnGate(row.parentRunId); } catch { return null; }
  };

  try {
    let stopped;
    if (Array.isArray(input.lines)) {
      for (const line of input.lines) {
        stopped = await gate();
        if (stopped) break;
        await say(line);
      }
      if (!stopped) stopped = 'script finished';
    } else {
      const maxTurns = input.maxTurns || DEFAULT_MAX_TURNS;
      for (let i = 0; i < maxTurns && !stopped; i++) {
        stopped = await gate();
        if (stopped) break;
        const next = await mcpConversations.userReply({
          persona: input.persona, goal: input.goal, conversationId, model: input.model,
        });
        output = { ...output, userModel: next.model };
        if (next.text) await say(next.text);
        if (next.done) stopped = 'the user was done';
        else if (!next.text) stopped = 'the user had nothing more to say';
      }
      if (!stopped) stopped = `turn limit (${maxTurns})`;
    }

    let endedInCrew = null;
    try {
      const state = await mcpConversations.readState({ conversationId, base });
      endedInCrew = state.crew ? state.crew.name : null;
    } catch { /* the result stands without it */ }

    await save(id, {
      status: 'completed',
      output: { ...output, stopped, endedInCrew, finishedAt: new Date().toISOString() },
    });
  } catch (err) {
    // Error center (#903). A failed agent turn was already recorded by the
    // turn itself; this keeps what failed AROUND it — the simulated user's
    // model, the address refusing the turn, a timeout.
    if (!err.turnFailure && !errorCenter.wasRecorded(err)) {
      errorCenter.record(err, {
        area: 'simulation',
        kind: turnErrorKind(err),
        code: err.upstreamStatus ? `http_${err.upstreamStatus}` : 'job_failed',
        agentSlug: row.agentName,
        conversationId,
        source: 'simulation',
        detail: { simulationId: id, ...(row.parentRunId ? { loadTestId: row.parentRunId } : {}) },
      });
    }
    await save(id, {
      status: 'failed',
      error: err.message,
      output: { ...output, stopped: 'an error (see below)', finishedAt: new Date().toISOString() },
    }).catch(() => {});
  }
}

// ─── Read ──────────────────────────────────────────────────────────

async function getJob(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw refuse(400, 'The simulation id is a number.');
  const [row] = await drizzle().select().from(testRuns)
    .where(and(eq(testRuns.id, n), eq(testRuns.type, TYPE))).limit(1);
  if (!row) throw refuse(404, `No simulation ${id}.`);
  return shape(await settleIfStale(row));
}

/** The jobs of one load test, in release order — settled like any job. */
async function listChildJobs(parentRunId) {
  const rows = await drizzle().select().from(testRuns)
    .where(and(eq(testRuns.type, TYPE), eq(testRuns.parentRunId, parentRunId)))
    .orderBy(asc(testRuns.id));
  const settled = [];
  for (const r of rows) settled.push(shape(await settleIfStale(r)));
  return settled;
}

/** The agent's own simulations — a load test's conversations show under the load test. */
async function listJobs({ slug, limit }) {
  const rows = await drizzle().select().from(testRuns)
    .where(and(eq(testRuns.type, TYPE), eq(testRuns.agentName, slug), isNull(testRuns.parentRunId)))
    .orderBy(desc(testRuns.createdAt))
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const settled = [];
  for (const r of rows) settled.push(shape(await settleIfStale(r)));
  return settled;
}

module.exports = {
  releaseJob, startJob, getJob, listJobs, listChildJobs, timingSummary, setTurnGate, STALE_MS,
  _internal: { timingSummary, turnErrorKind },
};
