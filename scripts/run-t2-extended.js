/**
 * Stage-2 T2 extended test — 15 requests (see plan Step 6): the T1 probes,
 * the impossible set run 2× each for determinism, the קצרין conversational
 * arc (context flows within one conversation), and two figure/annotation
 * checks whose numbers must match the baseline exactly (frozen data).
 *
 * Results → verification/representative-dataset/t2-extended-<label>.json
 * Usage: node scripts/run-t2-extended.js [label]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../services/db.pg');

const label = process.argv[2] || 'r1';
const OUT = path.join(__dirname, '..', 'verification', 'representative-dataset', `t2-extended-${label}.json`);

// [conversationKey, id, text] — same conversationKey = same conversation, in order.
const CASES = [
  // Impossible set — determinism: each twice, must refuse identically.
  ['imp-cust-1', 'I1a', 'How many customers do we have in total?'],
  ['imp-cust-2', 'I1b', 'How many customers do we have in total?'],
  ['imp-city-1', 'I2a', 'Which cities have the most customers?'],
  ['imp-city-2', 'I2b', 'Which cities have the most customers?'],
  ['imp-age-1',  'I3a', 'What is the age distribution of our customers?'],
  ['imp-age-2',  'I3b', 'What is the age distribution of our customers?'],
  ['imp-sell-1', 'I4a', 'טופ 10 מוכרנים לפי סך מכירות השנה'],
  ['imp-sell-2', 'I4b', 'טופ 10 מוכרנים לפי סך מכירות השנה'],
  ['imp-agent-1','I5a', 'אשמח לקבל נתוני מכירות סוכנים לחודש מאי'],
  ['imp-agent-2','I5b', 'אשמח לקבל נתוני מכירות סוכנים לחודש מאי'],
  // The קצרין arc — one conversation, context must carry.
  ['katzrin', 'K1', 'נתוני מכירות סניפים של אתמול 19.8.2026'],
  ['katzrin', 'K2', 'קצרין ב 17.8 מכר 74463 למה אתה מציג לי 20932.37?'],
  ['katzrin', 'K3', 'יש 2 סוגי מכירות , מכירות ממחסן ומכירות בחנות המכירות ממחסן מסומנות עם האות P. בוא תנסה למצוא את הערך שנקרא מכירות כולל מעמ'],
  // Figure checks — must equal the baseline numbers exactly (frozen data).
  ['money', 'M1', 'What is total revenue and profit this year?'],
  ['stores', 'M2', 'Top 10 stores by revenue this year'],
];

async function main() {
  await db.initialize();
  await require('../services/provider-config.service').initialize();
  const { runChatTurn } = require('../services/chat-turn.service');

  const results = [];
  for (const [convKey, id, text] of CASES) {
    const t0 = Date.now();
    const rec = { id, convKey, text: text.slice(0, 90), ranAt: new Date().toISOString() };
    try {
      const res = await runChatTurn({
        message: text,
        conversationId: `t2-${label}-${convKey}`,
        agentName: 'ZolStock',
        userId: `replay-t2-${label}`,
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
    console.log(`[${id}] ${rec.outcome} ${Math.round(rec.latencyMs / 1000)}s :: ${(rec.reply || rec.error || '').replace(/\n+/g, ' ').slice(0, 160)}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ label, ranAt: new Date().toISOString(), results }, null, 1));
  console.log(`→ ${OUT}`);
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
