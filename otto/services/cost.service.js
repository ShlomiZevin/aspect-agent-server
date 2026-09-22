/**
 * What one Otto screen has cost to make — every chat turn, plan, build and
 * revision, summed from llm_usage.
 *
 * Each of those calls logs `conversation_id = otto:<screenId>` (usageKey
 * below), so the total needs no bookkeeping of its own. Calls made before this
 * existed (2026-09-22) carry no key and are not counted; the dataset-wide
 * knowledge pass at init is not a screen's cost and is never keyed.
 *
 * List price: llm_usage does not record prompt-cache hits, so the real bill
 * can be a little lower than this says.
 */

const db = require('../../services/db.pg');
const modelsService = require('../../services/models.service');

function usageKey(screenId) {
  return `otto:${screenId}`;
}

async function costFor(screenId) {
  const { rows } = await db.query(
    `SELECT model, COUNT(*)::int AS calls,
            SUM(input_tokens)::bigint AS inp, SUM(output_tokens)::bigint AS outp
       FROM llm_usage
      WHERE conversation_id = $1
      GROUP BY model`,
    [usageKey(screenId)]
  );
  let calls = 0, inputTokens = 0, outputTokens = 0, costUsd = 0, costKnown = true;
  for (const r of rows) {
    calls += r.calls;
    inputTokens += Number(r.inp) || 0;
    outputTokens += Number(r.outp) || 0;
    const c = modelsService.costOf(r.model, Number(r.inp) || 0, Number(r.outp) || 0);
    if (c === null) costKnown = false;
    else costUsd += c;
  }
  return {
    calls,
    inputTokens,
    outputTokens,
    costUsd: costKnown ? Math.round(costUsd * 1000) / 1000 : null,
  };
}

module.exports = { usageKey, costFor };
