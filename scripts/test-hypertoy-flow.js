/**
 * Emulate a user chatting with the Hyper Toy agent.
 * POSTs to /api/finance-assistant/stream like the React UI does,
 * parses the SSE stream, and prints thinking steps + final assistant message.
 *
 * Usage:
 *   node scripts/test-hypertoy-flow.js           — list canned questions
 *   node scripts/test-hypertoy-flow.js N         — run canned question #N
 *   node scripts/test-hypertoy-flow.js "your question here"
 *   API_BASE=http://localhost:3000 node ...      — override server URL
 */

require('dotenv').config();
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const AGENT_NAME = 'HyperToy';

const QUESTIONS = [
  'כמה לקוחות יש לנו?',
  'How many customers do we have?',
  'מה ההכנסות והרווח השנה?',
  'What is total revenue and profit this year?',
  'טופ 10 מוצרים נמכרים השנה לפי כמות',
  'Top 10 best-selling products this year by quantity with revenue and profit',
  'אילו סניפים מובילים במכירות?',
  'Top 10 stores by revenue',
  'מה שולי הרווח הכוללים?',
  'השווה יעדי מכירות מול בפועל לפי חודש',
  'מה הפילוח של אמצעי תשלום?',
  'באילו ערים יש הכי הרבה לקוחות?',
  'טופ 10 קופאים לפי סך מכירות',
  'מוצרים מובילים לפי ערך מלאי במחסן 500',
  'מה הפערים הגדולים בעלות בין היפר טוי לבין הסטוק ופיראט?',
  'אילו זכיינים מובילים במכירות?',
  'מה סך יעדי המכירות?',
];

async function askUser(question) {
  const conversationId = crypto.randomUUID();
  console.log('\n>>> USER: ' + question);
  console.log('    convId=' + conversationId);
  const t0 = Date.now();

  const res = await fetch(`${API_BASE}/api/finance-assistant/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      message: question,
      conversationId,
      agentName: AGENT_NAME,
    }),
  });

  if (!res.ok) {
    console.log('HTTP ' + res.status + ': ' + (await res.text()).substring(0, 300));
    return;
  }

  let buffer = '';
  let assistantText = '';
  const thinkingSteps = [];
  let crewInfo = null;
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
      // Server emits typed events for thinking/meta and untyped {chunk:"..."} for assistant text
      if (typeof evt.chunk === 'string') {
        assistantText += evt.chunk;
      } else if (evt.type === 'thinking_step') {
        thinkingSteps.push(evt.step?.description || JSON.stringify(evt.step).substring(0, 80));
      } else if (evt.type === 'function_result') {
        if (evt.result?.sql) sql = evt.result.sql;
      } else if (evt.type === 'crew_info') {
        crewInfo = evt.crew?.displayName || evt.crew?.name;
      } else if (evt.type === 'error') {
        error = evt.message || JSON.stringify(evt);
      }
    }
  }

  const ms = Date.now() - t0;
  console.log('--- thinking steps (' + thinkingSteps.length + ') ---');
  thinkingSteps.forEach(s => console.log('  • ' + s));
  if (crewInfo) console.log('crew: ' + crewInfo);
  if (sql) console.log('SQL: ' + sql.replace(/\s+/g, ' ').substring(0, 300));
  if (error) console.log('ERROR: ' + error);
  console.log('--- assistant reply (' + ms + 'ms) ---');
  console.log((assistantText || '(empty)').substring(0, 1200));
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.log('Canned questions:');
    QUESTIONS.forEach((q, i) => console.log('  ' + (i + 1) + '. ' + q));
    console.log('\nRun: node scripts/test-hypertoy-flow.js N  (or  "your question")');
    process.exit(0);
  }
  const n = parseInt(arg, 10);
  const question = (!isNaN(n) && n >= 1 && n <= QUESTIONS.length) ? QUESTIONS[n - 1] : arg;
  await askUser(question);
  process.exit(0);
})();
