/**
 * Stage-2 T1 probe — the 5 most problematic requests, through the real chat
 * path, with written expectations (see tasks/pending/
 * zolstock-and-other-accuracy-improvements-stage-2.md, Step 6).
 *
 * P5 (payment types) runs 3× to prove refusal determinism.
 * Results → verification/representative-dataset/t1-probe-<n>.json
 *
 * Usage: node scripts/run-t1-probe.js [runLabel]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../services/db.pg');

const label = process.argv[2] || 'r1';
const OUT = path.join(__dirname, '..', 'verification', 'representative-dataset', `t1-probe-${label}.json`);

// Stage-3 probe set (tags s3*) — see stage-3 plan §2/T1 and runbook R3.
// P5a/P5b re-ask, verbatim, the two suggestion shapes P1's contract offers
// (last loaded day / last complete month) — the validated-suggestion
// guarantee, tested by execution. Update the dates if data-through moves.
const PROBES = [
  { id: 'P1', text: 'מה הרווח היום?' },
  { id: 'P2', text: 'נתוני מכירות סניפים של אתמול' },
  { id: 'P3', text: 'בדוח שלי המכירות של קצרין ב-17.8 כולל מעמ הן 74,463 — תבדוק מול הנתונים שלך' },
  { id: 'P4', text: 'Top 10 sellers by total sales this year' },
  { id: 'P5a', text: 'מה הרווח ב-23.8.2026?' },
  { id: 'P5b', text: 'מה הרווח ביולי 2026?' },
];

async function main() {
  await db.initialize();
  await require('../services/provider-config.service').initialize();
  const { runChatTurn } = require('../services/chat-turn.service');

  const results = [];
  for (const p of PROBES) {
    const t0 = Date.now();
    const rec = { ...p, ranAt: new Date().toISOString() };
    try {
      const res = await runChatTurn({
        message: p.text,
        conversationId: `t1-${label}-${p.id}`,
        agentName: 'ZolStock',
        userId: `replay-t1-${label}`,
      });
      rec.latencyMs = Date.now() - t0;
      rec.reply = res.reply || '';
      rec.outcome = rec.reply ? 'replied' : 'empty';
    } catch (e) {
      rec.latencyMs = Date.now() - t0;
      rec.outcome = 'error';
      rec.error = e.message;
    }
    results.push(rec);
    console.log(`\n[${p.id}] ${rec.outcome} ${Math.round(rec.latencyMs / 1000)}s`);
    console.log((rec.reply || rec.error || '').replace(/\n+/g, ' ').slice(0, 400));
  }

  fs.writeFileSync(OUT, JSON.stringify({ label, ranAt: new Date().toISOString(), results }, null, 1));
  console.log(`\n→ ${OUT}`);
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
