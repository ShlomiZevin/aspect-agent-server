/**
 * What the Suggested-reports generation has cost a dataset.
 *
 * Read straight from llm_usage — every LLM call already writes a row — scoped to
 * the generation's own calls: agent_name is the dataset, user_id is the fixed
 * `system` owner that bootstrap() investigates as, and process is one of the
 * insights_* steps. A user's own "Start analysis" runs under their session id,
 * so they are not counted here.
 *
 * user_id started being written on these calls with this module (2026-09-22);
 * earlier generations are in the table with a null user_id and cannot be told
 * apart from user runs, so `trackedSince` says where the numbers begin.
 */

const db = require('../../services/db.pg');
const modelsService = require('../../services/models.service');

// Matches BOOTSTRAP_USER_ID in insights/services/investigation.service.js.
const SYSTEM_USER = 'system';

function toWindow(rows) {
  let calls = 0, inputTokens = 0, outputTokens = 0, costUsd = 0, costKnown = true;
  for (const r of rows) {
    calls += Number(r.calls) || 0;
    inputTokens += Number(r.inp) || 0;
    outputTokens += Number(r.outp) || 0;
    const c = modelsService.costOf(r.model, Number(r.inp) || 0, Number(r.outp) || 0);
    if (c === null) costKnown = false;
    else costUsd += c;
  }
  return { calls, inputTokens, outputTokens, costUsd: costKnown ? Math.round(costUsd * 100) / 100 : null };
}

async function summarize(datasetId) {
  const { rows } = await db.query(
    `SELECT model,
            COUNT(*)::int                                   AS calls,
            SUM(input_tokens)::bigint                       AS inp,
            SUM(output_tokens)::bigint                      AS outp,
            MIN(created_at)                                 AS first_at,
            MAX(created_at)                                 AS last_at,
            (created_at >= NOW() - INTERVAL '24 hours')     AS in24h,
            (created_at >= NOW() - INTERVAL '7 days')       AS in7d,
            (created_at >= NOW() - INTERVAL '30 days')      AS in30d
       FROM llm_usage
      WHERE lower(agent_name) = lower($1)
        AND user_id = $2
        AND process LIKE 'insights\\_%'
      GROUP BY model, in24h, in7d, in30d`,
    [datasetId, SYSTEM_USER]
  );

  const pick = flag => rows.filter(r => r[flag]);
  const insightsRefresh = require('../../insights/services/insights-refresh.service');
  const firsts = rows.map(r => new Date(r.first_at).getTime());
  const lasts = rows.map(r => new Date(r.last_at).getTime());

  return {
    generating: insightsRefresh.isRunning(datasetId),
    lastRunAt: lasts.length ? new Date(Math.max(...lasts)).toISOString() : null,
    trackedSince: firsts.length ? new Date(Math.min(...firsts)).toISOString() : null,
    last24h: toWindow(pick('in24h')),
    last7d: toWindow(pick('in7d')),
    last30d: toWindow(pick('in30d')),
    total: toWindow(rows),
  };
}

module.exports = { summarize };
