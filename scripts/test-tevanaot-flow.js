/**
 * Emulate a user chatting with the Teva Naot agent.
 * POSTs to /api/finance-assistant/stream like the React UI does,
 * parses the SSE stream, and prints thinking steps + SQL + final reply.
 *
 * Usage:
 *   node scripts/test-tevanaot-flow.js           — list canned questions
 *   node scripts/test-tevanaot-flow.js N          — run canned question #N
 *   node scripts/test-tevanaot-flow.js all        — run every canned question
 *   node scripts/test-tevanaot-flow.js "question" — run a free-text question
 *   API_BASE=http://localhost:3000 node ...        — override server URL
 *                                                    (defaults to PROD Cloud Run)
 */

require('dotenv').config();
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'https://aspect-agent-server-1018338671074.europe-west1.run.app';
const AGENT_NAME = 'Teva Naot';

const QUESTIONS = [
  // ── core revenue (MV-backed) ──
  'What is total sales revenue this year?',
  'מה סך ההכנסות ממכירות השנה?',
  'Total revenue this month so far',
  'How many units were sold this year in total?',
  'Monthly sales revenue trend this year',
  'מגמת הכנסות לפי חודש השנה',
  'Compare revenue between the first and second quarter this year',
  // ── top products / stores ──
  'Top 10 best-selling shoe models this year by quantity and revenue',
  'טופ 10 דגמים נמכרים השנה לפי כמות',
  'Top 10 stores by revenue this year',
  'אילו 10 החנויות המובילות במכירות השנה?',
  'Top selling colors this year',
  'Sales by gender this year',
  'Best-selling shoe types this season',
  // ── transactions / basket ──
  'Number of transactions and average basket this month',
  'מה הסל הממוצע החודש?',
  // ── inventory ──
  'Current inventory value and units by store',
  'מה ערך המלאי הנוכחי בכל החנויות?',
  'Which products have the most stock on hand?',
  // ── orders / suppliers ──
  'How many open customer orders are there?',
  'Top suppliers by number of products',
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
    console.log('\nRun: node scripts/test-tevanaot-flow.js N | all | "your question"');
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
