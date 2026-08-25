/**
 * llm_usage ↔ messages reconciliation (Stage 2, Step 5).
 *
 * For every conversation that BILLED LLM work in the window, verify the
 * message log actually holds its turns. A conversation with usage rows but
 * zero messages means a served turn is missing from the record — the exact
 * anomaly of 2026-08-20 (conversation 3187: 5 llm_usage rows, 0 messages;
 * traced by timestamp skew to a local dev session against the prod DB, but
 * the check is what surfaced it, so it runs on).
 *
 * Also flags the reverse skew signal: llm_usage timestamps are written by
 * whatever clock the writing process has (JS Date), while conversations use
 * SQL now() — a large offset between the two for the same conversation means
 * a non-UTC machine (i.e. not Cloud Run) produced the traffic.
 *
 * Read-only. Exit 0 with "OK" when clean; exit 2 when discrepancies found
 * (never 1 — reserved for real errors) so a cron wrapper can alert on it.
 *
 * Usage: node scripts/reconcile-usage-vs-messages.js [days]   (default 2)
 */

require('dotenv').config();
const db = require('../services/db.pg');

const days = parseInt(process.argv[2] || '2', 10);

async function main() {
  await db.initialize();

  const { rows } = await db.query(`
    WITH billed AS (
      SELECT conversation_id AS ext_id,
             count(*) AS llm_calls,
             min(created_at) AS first_call,
             max(created_at) AS last_call,
             max(agent_name) AS agent_name
      FROM llm_usage
      WHERE created_at > now() - ($1 || ' days')::interval
        AND conversation_id IS NOT NULL
      GROUP BY conversation_id
    )
    SELECT b.ext_id, b.agent_name, b.llm_calls,
           c.id AS conv_id,
           to_char(b.first_call, 'YYYY-MM-DD HH24:MI') AS first_call,
           c.created_at AS conv_created,
           COALESCE(m.n, 0) AS message_rows,
           CASE WHEN c.id IS NULL THEN 'NO_CONVERSATION_ROW'
                WHEN COALESCE(m.n, 0) = 0 THEN 'NO_MESSAGES'
                ELSE 'OK' END AS verdict,
           ROUND(EXTRACT(EPOCH FROM (c.created_at - b.first_call)) / 3600.0, 1) AS clock_skew_hours
    FROM billed b
    LEFT JOIN conversations c ON c.external_id = b.ext_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM messages WHERE conversation_id = c.id
        AND created_at > now() - (($1::int + 1) || ' days')::interval
    ) m ON true
    ORDER BY verdict DESC, b.first_call`, [String(days)]);

  const bad = rows.filter(r => r.verdict !== 'OK');
  const skewed = rows.filter(r => r.verdict === 'OK' && Math.abs(Number(r.clock_skew_hours || 0)) > 1);

  console.log(`Reconciliation window: last ${days} day(s) — ${rows.length} billed conversation(s)\n`);
  for (const r of bad) {
    console.log(`  ${r.verdict}  ${r.ext_id} (agent ${r.agent_name}) — ${r.llm_calls} llm call(s) at ${r.first_call}, ${r.message_rows} message row(s)`);
  }
  for (const r of skewed) {
    console.log(`  CLOCK_SKEW ${r.clock_skew_hours}h  ${r.ext_id} (agent ${r.agent_name}) — llm_usage clock differs from DB clock; traffic likely from a non-UTC (local dev) machine`);
  }
  if (!bad.length && !skewed.length) console.log('  OK — every billed conversation has message rows, clocks consistent');

  process.exit(bad.length ? 2 : 0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
