/**
 * Simulation limits the team sets itself (task #926) — Admin → Simulations
 * → "Limits…". One set for the whole environment (all agents), stored in
 * `provider_config` under `mcp_sim_limits`, next to the daily counters
 * (`mcp_sim_usage:<UTC date>`, written by mcpConversations.countUse).
 *
 *   turnsPerDay            simulated conversation turns per day
 *   userRepliesPerDay      lines the platform writes as the simulated user
 *   maxTurnsPerSimulation  the most turns one persona simulation may run
 *   usdPerDay              estimated model spend of simulations per day;
 *                          null = no dollar cap
 *
 * Days are UTC days (reset at midnight UTC). Unset values fall back to the
 * env (MCP_SIM_DAILY_TURNS / MCP_SIM_DAILY_USER_REPLIES), then the defaults.
 *
 * Why a dollar cap (#925): on 2026-10-24 simulations spent ~$92 in a day
 * and the OpenAI account ran out of prepaid credit mid-run — every OpenAI
 * call failed, customers' included. The turn caps never came close.
 * "Today's spend" = list-price estimate (models.service costOf) of every
 * model call in a simulated conversation today, the simulated user's
 * included — the same numbers as the MCP's /usage.
 */

const db = require('../../services/db.pg');
const { eq, sql } = require('drizzle-orm');
const { providerConfig } = require('../../db/schema');
const models = require('../../services/models.service');

const KEY = 'mcp_sim_limits';
const DEFAULTS = {
  turnsPerDay: Number(process.env.MCP_SIM_DAILY_TURNS) || 2000,
  userRepliesPerDay: Number(process.env.MCP_SIM_DAILY_USER_REPLIES) || 2000,
  maxTurnsPerSimulation: 30,
  usdPerDay: null,
};
const BOUNDS = {
  turnsPerDay: [1, 100000],
  userRepliesPerDay: [1, 100000],
  maxTurnsPerSimulation: [1, 100],
  usdPerDay: [1, 10000],
};
const CACHE_MS = 15 * 1000;

function drizzle() {
  return db.getDrizzle();
}

let cache = { at: 0, value: { ...DEFAULTS }, meta: {} };

/** The limits in force (cached briefly — read on every simulated turn). */
async function getLimits() {
  if (Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const [row] = await drizzle().select().from(providerConfig).where(eq(providerConfig.key, KEY)).limit(1);
    let saved = {};
    try { saved = JSON.parse(row?.value || '{}') || {}; } catch { saved = {}; }
    const value = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (saved[k] !== undefined) value[k] = saved[k];
    cache = { at: Date.now(), value, meta: { updatedBy: saved.updatedBy || null, updatedAt: row?.updatedAt || null } };
  } catch {
    cache.at = Date.now(); // keep the last known limits; never block a turn on a read
  }
  return cache.value;
}

/** Synchronous view for code that cannot wait (simulationJobs.readSetup). */
function limitsNow() {
  if (Date.now() - cache.at >= CACHE_MS) getLimits().catch(() => {});
  return cache.value;
}

function refuse(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Change some limits. `usdPerDay: null` removes the dollar cap. */
async function setLimits(patch, by) {
  const current = await getLimits();
  const next = { ...current };
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    if (!(k in (patch || {}))) continue;
    const v = patch[k];
    if (k === 'usdPerDay' && (v === null || v === '')) { next.usdPerDay = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw refuse(400, `"${k}" must be a number from ${lo} to ${hi}${k === 'usdPerDay' ? ' (or null for no dollar cap)' : ''}.`);
    next[k] = k === 'usdPerDay' ? Math.round(n * 100) / 100 : Math.round(n);
  }
  const value = JSON.stringify({ ...next, updatedBy: by || null });
  await drizzle().insert(providerConfig).values({ key: KEY, value })
    .onConflictDoUpdate({ target: providerConfig.key, set: { value, updatedAt: new Date() } });
  cache.at = 0;
  return getLimits();
}

let spendCache = { at: 0, usd: 0 };

/** Estimated spend of today's (UTC) simulated conversations, cached briefly. */
async function todaySpend() {
  if (Date.now() - spendCache.at < CACHE_MS) return spendCache.usd;
  const res = await drizzle().execute(sql`
    select u.model, sum(u.input_tokens) as i, sum(u.output_tokens) as o
    from llm_usage u
    join conversations c on c.id::text = u.conversation_id
    where c.metadata->>'kind' = 'simulation'
      and u.created_at >= date_trunc('day', now() at time zone 'UTC')
    group by 1`);
  let usd = 0;
  for (const r of res.rows) usd += models.costOf(r.model, Number(r.i || 0), Number(r.o || 0)) || 0;
  spendCache = { at: Date.now(), usd };
  return usd;
}

/** Throws 429 when today's dollar cap is set and reached. */
async function checkBudget() {
  const { usdPerDay } = await getLimits();
  if (usdPerDay == null) return;
  const usd = await todaySpend();
  if (usd >= usdPerDay) {
    throw refuse(429, `Today's simulation budget ($${usdPerDay}) is used up — about $${usd.toFixed(2)} spent. It resets at midnight UTC; the limit is set in Admin → Simulations → Limits.`);
  }
}

/** Limits + today's use, for the Admin box and the MCP. */
async function summary() {
  const limits = await getLimits();
  const key = `mcp_sim_usage:${new Date().toISOString().slice(0, 10)}`;
  const [row] = await drizzle().select().from(providerConfig).where(eq(providerConfig.key, key)).limit(1);
  let used = {};
  try { used = JSON.parse(row?.value || '{}') || {}; } catch { used = {}; }
  return {
    limits,
    defaults: DEFAULTS,
    updatedBy: cache.meta.updatedBy,
    updatedAt: cache.meta.updatedAt,
    today: { turns: Number(used.turns) || 0, userReplies: Number(used.userReplies) || 0, usd: Math.round((await todaySpend()) * 100) / 100 },
    resetsAt: 'midnight UTC',
  };
}

module.exports = { getLimits, limitsNow, setLimits, checkBudget, todaySpend, summary, DEFAULTS, BOUNDS };
