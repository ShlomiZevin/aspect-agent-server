/**
 * HQ — spend guard.
 *
 * A circuit breaker, not an accountant. The per-call limits elsewhere (input
 * clamping, maxTokens, topK) bound a *single* call; nothing bounded the number
 * of calls, and fan-out is where a runaway bill actually comes from — one paste
 * of a 400-row Notion database summarised at ~$0.13 a page is ~$50 in a single
 * click, with no prompt.
 *
 * So: before every HQ LLM call, check what HQ has spent today and refuse past a
 * ceiling. Costs come from `llm_usage`, which every call already writes, so the
 * guard needs no bookkeeping of its own.
 */

const db = require('../../services/db.pg');

// USD per million tokens. Only the models HQ actually uses.
const RATES = {
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-opus-4-8':   { in: 5.00, out: 25.00 },
  'gpt-4o-mini':       { in: 0.15, out: 0.60 },
  'gpt-4o':            { in: 2.50, out: 10.00 },
};
const FALLBACK_RATE = { in: 3.00, out: 15.00 }; // assume Sonnet-tier if unknown

const DAILY_LIMIT_USD = Number(process.env.HQ_DAILY_USD_LIMIT || 5);

function priceOf(model, inputTokens, outputTokens) {
  const rate = RATES[model] || FALLBACK_RATE;
  return (inputTokens / 1e6) * rate.in + (outputTokens / 1e6) * rate.out;
}

/** What HQ has spent since midnight, in USD. */
async function spentToday() {
  const { rows } = await db.query(
    `SELECT model, SUM(input_tokens)::int AS inp, SUM(output_tokens)::int AS outp
       FROM llm_usage
      WHERE agent_name = 'hq'
        AND created_at >= date_trunc('day', NOW())
      GROUP BY model`
  );
  return rows.reduce((sum, r) => sum + priceOf(r.model, r.inp || 0, r.outp || 0), 0);
}

/**
 * Throw if HQ is over its daily ceiling. Call before any LLM work.
 *
 * Deliberately checks *before* rather than reserving a budget: a single call
 * can overshoot the line, but it can't run away, and it keeps the guard to one
 * cheap indexed query instead of a reservation protocol.
 */
async function assertWithinBudget(what = 'this') {
  if (!Number.isFinite(DAILY_LIMIT_USD) || DAILY_LIMIT_USD <= 0) return; // disabled

  const spent = await spentToday();
  if (spent >= DAILY_LIMIT_USD) {
    throw new Error(
      `HQ has spent $${spent.toFixed(2)} today, at or over the $${DAILY_LIMIT_USD.toFixed(2)} daily cap — ` +
      `refusing to run ${what}. Raise HQ_DAILY_USD_LIMIT on the server if this is expected.`
    );
  }
}

/** For the UI / status endpoint. */
async function budgetStatus() {
  const spent = await spentToday();
  return {
    spentTodayUsd: Number(spent.toFixed(4)),
    dailyLimitUsd: DAILY_LIMIT_USD,
    remainingUsd: Number(Math.max(0, DAILY_LIMIT_USD - spent).toFixed(4)),
    blocked: spent >= DAILY_LIMIT_USD,
  };
}

module.exports = { assertWithinBudget, budgetStatus, spentToday, priceOf, DAILY_LIMIT_USD };
