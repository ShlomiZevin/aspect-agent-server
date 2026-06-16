/**
 * Real pass/fail battery for the Zer4U agent.
 *
 * "OK" here means the SQL pipeline did NOT error — not merely "a reply came back".
 * After each question we read the slow-query log and treat any NEW row carrying an
 * error_message (column errors, GROUP BY, timeouts, etc.) as a FAIL for that question.
 *
 * Usage:
 *   API_BASE=https://aspect-agent-server-...run.app node scripts/test-zer4u-battery.js
 */

require('dotenv').config();
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const AGENT = 'Zer4U';

const QUESTIONS = [
  'How many stores do we have?',
  'What are my total sales this month?',
  'Which products are selling the most?',
  'Show me performance by store',
  'What is the current inventory status?',
  'Who are my top customers?',
  'Compare this month to the same month last year',
  'Show me products with inventory problems',
  'How are we doing against our targets?',
  'Show me slow-moving inventory',
  'performance against targets',
  'store performance overview',
  'cost reduction strategies and profitability improvement opportunities for Zer4U',
  'sales growth percentage this month versus same month last year',
  'cities with the most customers',
  'payment totals grouped by payment type',
  'suppliers with the most products in our catalog',
  'top selling bundle in catalog bouquets',
  'total discount amount given this year',
  'number of unique customers who made a purchase this year',
  'number of items below their minimum inventory level',
  'show inventory quantities for three stores',
  'top 5 stores by revenue in 2026',
  'monthly revenue trend for the last 6 months',
  'מה סך המכירות החודש?',
  'אילו מוצרים נמכרים הכי הרבה?',
  'מי הלקוחות המובילים שלי?',
  'מה מצב המלאי הנוכחי?',
  'השווה את החודש הזה לאותו חודש בשנה שעברה',
  'הראה לי מלאי שנע לאט',
];

async function ask(question) {
  const conversationId = crypto.randomUUID();
  const t0 = Date.now();
  let assistantText = '', sql = null, streamError = null;
  try {
    const res = await fetch(`${API_BASE}/api/finance-assistant/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message: question, conversationId, agentName: AGENT }),
    });
    if (!res.ok) return { ms: Date.now() - t0, streamError: `HTTP ${res.status}`, sql, assistantText };
    let buffer = '';
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
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        if (typeof evt.chunk === 'string') assistantText += evt.chunk;
        else if (evt.type === 'function_result' && evt.result?.sql) sql = evt.result.sql;
        else if (evt.type === 'error') streamError = evt.message || 'stream error';
      }
    }
  } catch (e) {
    streamError = e.message;
  }
  return { ms: Date.now() - t0, streamError, sql, assistantText };
}

async function fetchLog() {
  const res = await fetch(`${API_BASE}/api/admin/slow-queries?agent=zer4u&limit=120`);
  const d = await res.json();
  return d.slowQueries || d || [];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`Battery: ${QUESTIONS.length} questions -> ${API_BASE}\n`);
  // Seed: everything already in the log is "old".
  let seen = new Set((await fetchLog()).map(r => r.id));

  const results = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    const r = await ask(q);
    await sleep(1300); // let the slow-query log flush
    const log = await fetchLog();
    const fresh = log.filter(row => !seen.has(row.id));
    fresh.forEach(row => seen.add(row.id));
    const sqlErrors = fresh.filter(row => row.error_message);

    let verdict = 'PASS', reason = '';
    if (r.streamError) { verdict = 'FAIL'; reason = 'stream: ' + r.streamError; }
    else if (sqlErrors.length) { verdict = 'FAIL'; reason = sqlErrors.map(e => e.error_message).join(' | ').slice(0, 110); }
    else if (!r.assistantText || !r.assistantText.trim()) { verdict = 'FAIL'; reason = 'empty reply'; }

    results.push({ q, verdict, reason, ms: r.ms });
    console.log(`${String(i + 1).padStart(2)}. [${verdict}] ${String(r.ms).padStart(6)}ms  ${q.slice(0, 56)}${reason ? '  :: ' + reason : ''}`);
  }

  const fails = results.filter(r => r.verdict === 'FAIL');
  console.log(`\n════════ ${results.length - fails.length}/${results.length} PASS ════════`);
  if (fails.length) {
    console.log('FAILURES:');
    for (const f of fails) console.log(`  - ${f.q}\n      ${f.reason}`);
  }
  process.exit(fails.length ? 1 : 0);
})();
