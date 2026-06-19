/**
 * Emulate a user chatting with the Zer4U agent.
 * POSTs to /api/finance-assistant/stream like the React UI does,
 * parses the SSE stream, and prints thinking steps + final assistant message.
 *
 * Questions mirror the client's Quick Questions (EN + HE) plus a few core probes,
 * so this exercises exactly what a real user / tester would click on.
 *
 * Usage:
 *   node scripts/test-zer4u-flow.js              — list canned questions
 *   node scripts/test-zer4u-flow.js N            — run canned question #N
 *   node scripts/test-zer4u-flow.js all          — run the whole battery, print a summary
 *   node scripts/test-zer4u-flow.js "your question here"
 *   API_BASE=https://aspect-agent-server-1018338671074.europe-west1.run.app node ...   — target prod
 */

require('dotenv').config();
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const AGENT_NAME = 'Zer4U';

// Mirrors src/i18n/translations.ts quick.zer4u.* (English + Hebrew), plus core probes.
const QUESTIONS = [
  // core probes
  'How many stores do we have?',
  'כמה חנויות יש לנו?',
  // English quick questions
  'What are my total sales this month?',
  'Which products are selling the most?',
  'Show me performance by store',
  'What is the current inventory status?',
  'Who are my top customers?',
  'Compare this month to the same month last year',
  'Based on my data, how can I reduce costs and improve profitability?',
  'Show me products with inventory problems',
  'How are we doing against our targets?',
  'Show me slow-moving inventory',
  // Hebrew quick questions
  'מה סך המכירות החודש?',
  'אילו מוצרים נמכרים הכי הרבה?',
  'הראה לי ביצועים לפי חנות',
  'מה מצב המלאי הנוכחי?',
  'מי הלקוחות המובילים שלי?',
  'השווה את החודש הזה לאותו חודש בשנה שעברה',
  'על סמך הנתונים שלי, איך אני יכול להפחית עלויות ולשפר רווחיות?',
  'הראה לי מוצרים עם בעיות מלאי',
  'איך אנחנו עומדים ביחס ליעדים?',
  'הראה לי מלאי שנע לאט',
];

async function askUser(question, { quiet = false } = {}) {
  const conversationId = crypto.randomUUID();
  if (!quiet) {
    console.log('\n>>> USER: ' + question);
    console.log('    convId=' + conversationId);
  }
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
    const body = (await res.text()).substring(0, 300);
    if (!quiet) console.log('HTTP ' + res.status + ': ' + body);
    return { question, ok: false, ms: Date.now() - t0, error: `HTTP ${res.status}: ${body}` };
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
  if (!quiet) {
    console.log('--- thinking steps (' + thinkingSteps.length + ') ---');
    thinkingSteps.forEach(s => console.log('  • ' + s));
    if (crewInfo) console.log('crew: ' + crewInfo);
    if (sql) console.log('SQL: ' + sql.replace(/\s+/g, ' ').substring(0, 300));
    if (error) console.log('ERROR: ' + error);
    console.log('--- assistant reply (' + ms + 'ms) ---');
    console.log((assistantText || '(empty)').substring(0, 1200));
  }

  return {
    question,
    ok: !error && !!assistantText,
    ms,
    sql,
    error,
    reply: assistantText,
  };
}

(async () => {
  const arg = process.argv[2];

  if (!arg) {
    console.log('Canned questions:');
    QUESTIONS.forEach((q, i) => console.log('  ' + (i + 1) + '. ' + q));
    console.log('\nRun: node scripts/test-zer4u-flow.js N   (or  "your question"  or  all)');
    process.exit(0);
  }

  if (arg.toLowerCase() === 'all') {
    console.log(`Running ${QUESTIONS.length} questions against ${API_BASE} (agent=${AGENT_NAME})\n`);
    const results = [];
    for (const q of QUESTIONS) {
      const r = await askUser(q);
      results.push(r);
    }
    console.log('\n\n══════════════ SUMMARY ══════════════');
    let okCount = 0;
    results.forEach((r, i) => {
      const status = r.ok ? 'OK ' : 'FAIL';
      if (r.ok) okCount++;
      const note = r.error ? ` — ${r.error.substring(0, 120)}` : '';
      console.log(`${String(i + 1).padStart(2)}. [${status}] ${r.ms}ms  ${r.question.substring(0, 50)}${note}`);
    });
    const times = results.map(r => r.ms).sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)];
    const max = times[times.length - 1];
    console.log(`\n${okCount}/${results.length} OK   p50=${p50}ms   max=${max}ms`);
    process.exit(okCount === results.length ? 0 : 1);
  }

  const n = parseInt(arg, 10);
  const question = (!isNaN(n) && n >= 1 && n <= QUESTIONS.length) ? QUESTIONS[n - 1] : arg;
  await askUser(question);
  process.exit(0);
})();
