/**
 * Emulate a user chatting with the Zol Stock agent.
 * POSTs to /api/finance-assistant/stream like the React UI does,
 * parses the SSE stream, and prints thinking steps + SQL + final reply.
 *
 * Usage:
 *   node scripts/test-zolstock-flow.js           — list canned questions
 *   node scripts/test-zolstock-flow.js N          — run canned question #N
 *   node scripts/test-zolstock-flow.js all        — run every canned question
 *   node scripts/test-zolstock-flow.js "question" — run a free-text question
 *   API_BASE=http://localhost:3000 node ...        — override server URL
 *                                                    (defaults to PROD Cloud Run)
 */

require('dotenv').config();
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'https://aspect-agent-server-1018338671074.europe-west1.run.app';
const AGENT_NAME = 'ZolStock';

const QUESTIONS = [
  // ── core revenue / profit (MV-backed) ──
  'What is total revenue and profit this year?',
  'מה ההכנסות והרווח השנה?',
  'What was total revenue and profit last month?',
  'מה היו ההכנסות בחודש שעבר?',
  'Total revenue this month so far',
  'What is the overall profit margin this year?',
  'מה שולי הרווח הכוללים השנה?',
  'Monthly revenue and profit trend this year',
  'מגמת הכנסות לפי חודש השנה',
  'Compare revenue between the first and second quarter this year',
  'What was the best month for revenue this year?',
  // ── top products / stores / sellers ──
  'Top 10 items this year by revenue and profit',
  'טופ 10 מוצרים השנה לפי כמות שנמכרה',
  'Top 10 items by profit margin this year (min 1000 units sold)',
  'Top 10 stores by revenue this year',
  'אילו 10 הסניפים המובילים ברווח השנה?',
  'Which store has the highest profit margin this year?',
  'Top 10 sellers by total sales this year',
  'טופ 10 מוכרנים לפי רווח השנה',
  'Worst 5 stores by revenue this year',
  // ── period / comparison ──
  'How many units were sold this year in total?',
  'מה ההכנסות והרווח ברבעון הראשון?',
  'Revenue by month for store number 2 this year',
  // ── harder / non-MV (stress: customers, inventory, agent, discounts) ──
  'How many unique customers bought from us this year?',
  'How many items are below their minimum stock level?',
  'Total wholesale (agent) sales to branches this year',
  'What is the total discount amount given this year?',
  'Average transaction value this year',
];

async function askUser(question) {
  const conversationId = crypto.randomUUID();
  console.log('\n============================================================');
  console.log('>>> USER: ' + question);
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(`${API_BASE}/api/finance-assistant/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message: question, conversationId, agentName: AGENT_NAME }),
    });
  } catch (e) {
    console.log('FETCH ERROR: ' + e.message);
    return;
  }

  if (!res.ok) {
    console.log('HTTP ' + res.status + ': ' + (await res.text()).substring(0, 300));
    return;
  }

  let buffer = '';
  let assistantText = '';
  const thinkingSteps = [];
  let sql = null;
  let error = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (typeof evt.chunk === 'string') {
        assistantText += evt.chunk;
      } else if (evt.type === 'thinking_step') {
        thinkingSteps.push(evt.step?.description || JSON.stringify(evt.step).substring(0, 80));
      } else if (evt.type === 'function_result') {
        if (evt.result?.sql) sql = evt.result.sql;
      } else if (evt.type === 'error') {
        error = evt.message || JSON.stringify(evt);
      }
    }
  }

  const ms = Date.now() - t0;
  if (sql) console.log('SQL: ' + sql.replace(/\s+/g, ' ').substring(0, 400));
  if (error) console.log('ERROR: ' + error);
  console.log('--- reply (' + ms + 'ms) ---');
  console.log((assistantText || '(empty)').substring(0, 1400));
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.log('Canned questions:');
    QUESTIONS.forEach((q, i) => console.log('  ' + (i + 1) + '. ' + q));
    console.log('\nRun: node scripts/test-zolstock-flow.js N | all | "your question"');
    process.exit(0);
  }
  if (arg === 'all') {
    for (const q of QUESTIONS) await askUser(q);
    process.exit(0);
  }
  const n = parseInt(arg, 10);
  const question = (!isNaN(n) && n >= 1 && n <= QUESTIONS.length) ? QUESTIONS[n - 1] : arg;
  await askUser(question);
  process.exit(0);
})();
