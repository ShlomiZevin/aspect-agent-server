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
 */

const db = require('../../services/db.pg');
const { eq, and, desc } = require('drizzle-orm');
const { testRuns } = require('../../db/schema');
const mcpConversations = require('./mcpConversations');
const models = require('../../services/models.service');

const TYPE = 'simulation';
const DEFAULT_MAX_TURNS = 12;
const MAX_TURNS_CAP = 30;
const MAX_LINES = 40;
/** A turn takes seconds, rarely a minute or two; ten quiet minutes = gone. */
const STALE_MS = 10 * 60 * 1000;

function drizzle() {
  return db.getDrizzle();
}

function refuse(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
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
    turns: output.turns || 0,
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
    setup.maxTurns = Math.max(1, Math.min(Number(b.maxTurns) || DEFAULT_MAX_TURNS, MAX_TURNS_CAP));
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
 *                            maxTurns?, model?, startCrew?, fields? }
 */
async function releaseJob({ slug, by, body }) {
  const b = body || {};
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
  const conv = await mcpConversations.startConversation({
    slug, by, version: b.version, label, startCrew: b.startCrew, fields: b.fields,
  });

  const [row] = await drizzle().insert(testRuns).values({
    type: TYPE,
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
    },
    output: { turns: 0 },
  }).returning();

  // Run it after this request has answered. Never let it take the process down.
  setImmediate(() => {
    runJob(row.id).catch(err => console.error(`[simulations] job ${row.id} crashed:`, err));
  });

  return shape(row);
}

// ─── Run ───────────────────────────────────────────────────────────

async function runJob(id) {
  const [row] = await drizzle().select().from(testRuns).where(eq(testRuns.id, id)).limit(1);
  if (!row || row.type !== TYPE || row.status !== 'pending') return;
  const input = row.input || {};
  const conversationId = input.conversationId;
  let output = { ...(row.output || {}), turns: 0 };
  await save(id, { status: 'running', output });

  const say = async text => {
    await mcpConversations.sendMessage({ conversationId, text });
    output = { ...output, turns: output.turns + 1 };
    await save(id, { output }); // also the heartbeat
  };

  try {
    let stopped;
    if (Array.isArray(input.lines)) {
      for (const line of input.lines) await say(line);
      stopped = 'script finished';
    } else {
      const maxTurns = input.maxTurns || DEFAULT_MAX_TURNS;
      for (let i = 0; i < maxTurns && !stopped; i++) {
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
      const state = await mcpConversations.readState({ conversationId });
      endedInCrew = state.crew ? state.crew.name : null;
    } catch { /* the result stands without it */ }

    await save(id, {
      status: 'completed',
      output: { ...output, stopped, endedInCrew, finishedAt: new Date().toISOString() },
    });
  } catch (err) {
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

async function listJobs({ slug, limit }) {
  const rows = await drizzle().select().from(testRuns)
    .where(and(eq(testRuns.type, TYPE), eq(testRuns.agentName, slug)))
    .orderBy(desc(testRuns.createdAt))
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const settled = [];
  for (const r of rows) settled.push(shape(await settleIfStale(r)));
  return settled;
}

module.exports = { releaseJob, getJob, listJobs, STALE_MS };
