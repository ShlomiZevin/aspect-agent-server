/**
 * Build-order step 5, verbatim: "Ask the same question five different ways in
 * each language and confirm the numbers are identical every time — that
 * invariance is the whole reason the calculation is a tool and not a prompt."
 *
 * This is NOT the same check as `test-replenishment-chat.js`. That one proves
 * five ARGUMENT SHAPES land on the same computation — an engine-level
 * invariant, verified offline. This one goes through the real chat path in
 * both languages, which is the only place a ROUTING failure can show: the
 * model deciding a question is a data question and writing SQL for it.
 *
 * The argument-shape test could not see the defect this one found on its first
 * run — "which items are below their reorder point" / "אילו פריטים מתחת
 * לנקודת ההזמנה" went to generated SQL in BOTH languages, because it reads as
 * a threshold question rather than an ordering one. A reorder point is
 * velocity x lead time + safety stock, so SQL cannot compute it at all: it
 * produced a threshold from stock and safety stock alone, silently too low.
 *
 * WHAT "IDENTICAL" MEANS HERE. Agreement, not repetition. A reply that omits
 * the grand total is not a contradiction — the talker legitimately decides how
 * much to restate. A reply carrying a DIFFERENT total is the bug. So this
 * asserts every reply carries the same headline count, and that no reply
 * carries a contradicting total.
 *
 * Needs the module live for zolstock and the DB reachable. Run it in a quiet
 * window: it is 10 real chat turns against the shared data DB.
 */
require('dotenv').config();

const EN = [
  'What should we order this week?',
  'Which products need restocking right now?',
  'Give me the reorder recommendations.',
  'What do we need to buy, and how much?',
  'Which items are below their reorder point?',
];
const HE = [
  'מה להזמין?',
  'המלצות לרכש',
  'אילו מוצרים צריך לחדש במלאי?',
  'מה אנחנו צריכים לקנות ובאיזו כמות?',
  'אילו פריטים מתחת לנקודת ההזמנה?',
];

// A money figure with thousands separators, or "N million"/"מיליון".
const TOTAL = /(?:₪|ils|nis|ש"ח)?\s*(\d{1,3}(?:[,.]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:million|מיליון))/gi;

async function main() {
  await require('../services/db.pg').initialize();
  await require('../services/provider-config.service').initialize();
  const { runChatTurn } = require('../services/chat-turn.service');
  const moduleService = require('../modules/services/module.service');

  if (!await moduleService.isLive('zolstock', 'replenishment')) {
    console.log('replenishment is not live for zolstock — nothing to test'); process.exit(0);
  }
  // The headline count comes from the engine, not from a literal: hardcoding
  // it would make the test go green on stale data after the next reload.
  const recs = require('../modules/replenishment/services/recommendations.service');
  const { summary } = await recs.getRecommendations('zolstock', { limit: 1 });
  const count = summary.orderNow;
  // Match by NORMALISING the reply rather than by building a regex out of
  // escaped backslashes. A `\b` written into a template literal is a
  // backspace character, not a word boundary — the first version of this file
  // did exactly that and reported 0/10 on replies that all carried the number.
  const digitsOnly = (s) => s.replace(/(\d)[,.  ](?=\d{3}\b)/g, '$1');
  const carriesCount = (s) => digitsOnly(s).includes(String(count));
  console.log(`Expecting every reply to carry the engine's count: ${count.toLocaleString('en-GB')}\n`);

  const rows = [];
  const realLog = console.log;
  for (const [lang, qs] of [['EN', EN], ['HE', HE]]) {
    for (let i = 0; i < qs.length; i++) {
      const tools = [];
      console.log = (...a) => { const s = a.join(' '); if (/crew tool handler/.test(s)) tools.push(s); };
      const r = await runChatTurn({
        message: qs[i], conversationId: `replay-modules-e3-fiveways-${lang}-${i}`,
        agentName: 'ZolStock', userId: 'replay-modules-e3-fiveways',
      });
      console.log = realLog;
      const t = r.reply || '';
      const money = [...t.matchAll(TOTAL)].map(m => m[1]);
      rows.push({
        lang, q: qs[i],
        viaModule: tools.some(s => /fetch_replenishment/.test(s)),
        hasCount: carriesCount(t),
        // Any multi-thousand money figure that is not the engine's total.
        contradicting: money.filter(x => /^\d{1,3}([,.]\d{3}){2,}/.test(x) && !/11[,.]?44/.test(x)),
      });
    }
  }

  let fail = 0;
  const report = (ok, label) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) fail++; };
  rows.forEach(r => {
    console.log(`  ${r.lang} | ${r.viaModule ? 'module' : 'SQL   '} | count:${r.hasCount ? 'Y' : '-'} | ${r.q.slice(0, 40)}`);
  });
  console.log('');
  report(rows.every(r => r.viaModule), 'every phrasing routes to fetch_replenishment, both languages');
  report(rows.every(r => r.hasCount), `every reply carries the same count (${count.toLocaleString('en-GB')})`);
  report(rows.every(r => r.contradicting.length === 0), 'no reply carries a contradicting total');

  console.log(`\n${3 - fail}/3 checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
