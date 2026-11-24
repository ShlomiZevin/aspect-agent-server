// Usage: node scripts/test-realestate-demo.js <label> [idx,...]  (needs the Cloud SQL proxy)
// Replays the real-estate demo script through the REAL chat path (runChatTurn),
// in-process, and writes verification/realestate-demo/replay-<label>.json.
// The questions are the ones the demo will be driven with — Itzik's list
// (leads, conversion, regions, unit mix, segments, lead source, buyer profile,
// purchase purpose) plus the "wow" moments.
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config({ path: '.env' });
const { runChatTurn } = require('../services/chat-turn.service');
const fs = require('fs');

const label = process.argv[2] || 'run';
const QUESTIONS = [
  'כמה לידים נכנסו השנה וכמה מהם עברו לרכישה?',
  'מאיפה מגיעים הלידים הכי טובים? תשווה עלות לעסקה לפי מקור',
  'מי הרוכשים שלנו? גיל, מקצוע, עשירון ומטרת הרכישה',
  'כמה מהרוכשים קנו דירה ראשונה, כמה להשקעה וכמה עבור הילדים?',
  'איך מתחלקות המכירות לפי אזור, מספר חדרים וגודל דירה?',
  'איזו הטבה כדאי לתת לכל סגמנט של רוכשים?',
  'למי להתקשר היום?',
  'אילו דירות תקועות ולא נמכרות, ולמה?',
  'תראה לי את לוח הדירות של אופק כרמל',
  'מתי כל פרויקט יימכר עד הסוף בקצב הנוכחי?',
  'איזה איש מכירות נותן הכי הרבה הנחות וכמה זה עולה לנו?',
  'למה ההמרה בחיפה ירדה?',
  'Which marketing channel should get more budget next quarter?',
  'כמה עסקאות צמודות למדד תשומות הבנייה וכמה נסגרו ללא הצמדה?',
];

(async () => {
  await require('../services/db.pg').initialize();
  await require('../services/provider-config.service').initialize();
  const only = process.argv[3] ? process.argv[3].split(',').map(Number) : null;
  const out = [];
  for (const [i, message] of QUESTIONS.entries()) {
    if (only && !only.includes(i)) continue;
    const t = Date.now();
    let r, err = null;
    try {
      r = await runChatTurn({ agentName: 'Real Estate', message, conversationId: `test-realestate-${label}-${i}-${Date.now()}`, userId: 'test_realestate_demo' });
    } catch (e) { err = e.message; }
    const secs = (Date.now() - t) / 1000;
    const reply = r?.reply || '';
    const row = { idx: i, message, secs, err, tools: (r?.toolResults || []).map(x => x.name || x.toolName || x.tool || '?'), reply };
    out.push(row);
    console.log(`\n[${i}] ${secs.toFixed(1)}s tools=${row.tools.join(',')} ${err ? 'ERR ' + err : ''}\n>>> ${message}\n${reply}`);
  }
  fs.mkdirSync('verification/realestate-demo', { recursive: true });
  fs.writeFileSync(`verification/realestate-demo/replay-${label}.json`, JSON.stringify(out, null, 1));
  process.exit(0);
})();
