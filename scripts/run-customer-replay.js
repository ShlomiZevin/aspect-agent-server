/**
 * Replay the frozen ZolStock customer corpus through the REAL chat path
 * (Stage 2, Step 0 baseline — and Step 6 post-run, same script, new tag).
 *
 * Every conversation in verification/representative-dataset/customer-corpus.json
 * is replayed turn-by-turn via services/chat-turn.service runChatTurn() — the
 * exact buffered equivalent of the production chat endpoint: same crew, same
 * dispatcher, same SQL engine, same persistence. A fresh conversation id per
 * unit keeps context flowing for follow-up turns exactly as the customer
 * experienced it.
 *
 * Replay traffic is attributed to userId `replay-<tag>` and conversation ids
 * `replay-<tag>-c<origConv>` — the corpus extractor filters to `anon_%`, so
 * replay runs can never pollute a future corpus.
 *
 * Progress is appended to <tag>.progress.jsonl after EVERY turn, so a killed
 * run resumes by skipping completed (conv, mid) pairs. The final assembled
 * JSON is written to the path given as the second argument.
 *
 * Captured per turn: reply text, crew member, latency, error, and the SQL
 * evidence trail (thinking_steps of the assistant message: every data-fetch
 * question + generated SQL + data_table row counts).
 *
 * Usage:
 *   node scripts/run-customer-replay.js <tag> <outFile> [--limit N] [--conv ID]
 * e.g.
 *   node scripts/run-customer-replay.js baseline-pre-stage2 \
 *        verification/representative-dataset/21-08-2026-quality-baseline.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../services/db.pg');

const DIR = path.join(__dirname, '..', 'verification', 'representative-dataset');
const CORPUS = path.join(DIR, 'customer-corpus.json');

const tag = process.argv[2];
const outFile = process.argv[3];
if (!tag || !outFile) {
  console.error('Usage: node scripts/run-customer-replay.js <tag> <outFile> [--limit N] [--conv ID]');
  process.exit(1);
}
const limitIx = process.argv.indexOf('--limit');
const LIMIT = limitIx > -1 ? parseInt(process.argv[limitIx + 1]) : Infinity;
const convIx = process.argv.indexOf('--conv');
const ONLY_CONV = convIx > -1 ? String(process.argv[convIx + 1]) : null;

const progressFile = path.join(DIR, `${tag}.progress.jsonl`);

/** Snapshot of the dataset the run executed against — comparisons between two
 *  runs are only valid when these match (frozen-data rule, plan §2.5). */
async function dataState(pool) {
  const { rows } = await pool.query(`
    SELECT record_type, count(*)::bigint AS rows, max(row_date) AS max_date
    FROM zolstock.facts GROUP BY record_type ORDER BY record_type`);
  return rows.map(r => ({ recordType: r.record_type, rows: String(r.rows), maxDate: r.max_date }));
}

/** SQL evidence trail for one assistant message, from thinking_steps. */
async function evidenceFor(dbSvc, assistantMessageId) {
  if (!assistantMessageId) return [];
  const { rows } = await dbSvc.query(
    `SELECT step_type, metadata FROM thinking_steps WHERE message_id = $1 ORDER BY step_order`,
    [assistantMessageId]);
  const out = [];
  for (const s of rows) {
    const m = s.metadata || {};
    const p = m.params || m;
    if (s.step_type === 'function_call' && p && (p.sql || p.question)) {
      out.push({ kind: 'fetch', question: p.question || null, sql: p.sql || null });
    } else if (s.step_type === 'data_table') {
      out.push({ kind: 'data_table', question: m.question || null, sql: m.sql || null, rowCount: m.rowCount ?? null });
    }
  }
  return out;
}

async function main() {
  // A transient pg pool error (proxy blip) must not kill a multi-hour run —
  // progress is per-turn JSONL and the loop itself try/catches each turn, but
  // an idle pool client's 'error' EVENT escapes those try/catches and crashes
  // the process (observed 2026-08-24 at turn 28/74: "Connection terminated
  // unexpectedly"). Log and continue; the in-flight turn records its own error.
  process.on('uncaughtException', (e) => console.error('⚠️ uncaught (continuing):', e.message));
  process.on('unhandledRejection', (e) => console.error('⚠️ unhandled rejection (continuing):', e?.message || e));

  await db.initialize();
  const providerConfigService = require('../services/provider-config.service');
  await providerConfigService.initialize();
  const { runChatTurn } = require('../services/chat-turn.service');
  const dataPool = require('../services/db.zer4u').getPool();
  const platDb = db; // platform DB service — evidenceFor uses db.query()

  const { meta: corpusMeta, conversations } = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));

  // Resume support
  const done = new Set();
  if (fs.existsSync(progressFile)) {
    for (const line of fs.readFileSync(progressFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); done.add(`${r.origConv}|${r.mid}`); } catch {}
    }
    console.log(`↻ Resuming: ${done.size} turns already recorded`);
  }

  const stateBefore = await dataState(dataPool);
  console.log(`▶ Replay '${tag}' — ${corpusMeta.totalTurns} turns · data through ${stateBefore.find(s => s.recordType === 'sales')?.maxDate}`);

  let ran = 0;
  for (const conv of conversations) {
    if (ONLY_CONV && String(conv.origConv) !== ONLY_CONV) continue;
    const replayConvId = `replay-${tag}-c${conv.origConv}`;
    for (const turn of conv.turns) {
      if (ran >= LIMIT) break;
      const key = `${conv.origConv}|${turn.mid}`;
      if (done.has(key)) continue;

      const rec = {
        origConv: conv.origConv, mid: turn.mid, mode: conv.mode,
        user: conv.user, originalTime: turn.t,
        reconstructed: turn.reconstructed || false,
        question: turn.text,
        ranAt: new Date().toISOString(),
      };
      const t0 = Date.now();
      try {
        const res = await runChatTurn({
          message: turn.text,
          conversationId: replayConvId,
          agentName: 'ZolStock',
          userId: `replay-${tag}`,
        });
        rec.latencyMs = Date.now() - t0;
        rec.reply = res.reply || '';
        rec.crewMember = res.crewMember || null;
        rec.assistantMessageId = res.assistantMessageId || null;
        rec.evidence = await evidenceFor(platDb, res.assistantMessageId);
        rec.outcome = rec.reply ? 'replied' : 'empty';
      } catch (e) {
        rec.latencyMs = Date.now() - t0;
        rec.outcome = 'error';
        rec.error = e.message;
      }
      fs.appendFileSync(progressFile, JSON.stringify(rec) + '\n');
      ran++;
      const label = String(turn.text).replace(/\s+/g, ' ').slice(0, 60);
      console.log(`  [${ran}] conv${conv.origConv} ${rec.outcome} ${rec.latencyMs}ms · ${label}`);
    }
  }

  const stateAfter = await dataState(dataPool);
  const drift = JSON.stringify(stateBefore) !== JSON.stringify(stateAfter);
  if (drift) console.warn('⚠️  DATA CHANGED DURING RUN — comparison against this run is suspect (plan §2.5)');

  // Assemble final JSON from the full progress log
  const results = fs.readFileSync(progressFile, 'utf8').split('\n')
    .filter(l => l.trim()).map(l => JSON.parse(l));
  const final = {
    meta: {
      tag,
      corpus: { builtAt: corpusMeta.builtAt, totalTurns: corpusMeta.totalTurns },
      startedAt: results[0]?.ranAt, finishedAt: new Date().toISOString(),
      turnsRecorded: results.length,
      dataState: stateBefore, dataDriftDuringRun: drift,
      replayUserId: `replay-${tag}`,
      path: 'services/chat-turn.service runChatTurn — full crew chat path',
    },
    results,
  };
  const abs = path.isAbsolute(outFile) ? outFile : path.join(__dirname, '..', outFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(final, null, 1));
  console.log(`✅ ${results.length}/${corpusMeta.totalTurns} turns → ${abs}`);
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
