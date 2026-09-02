require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });

const fs = require('fs');
const path = require('path');
const db = require('../../services/db.pg');
const registry = require('../../insights/datasets/registry');

/**
 * Acceptance pass for superhist, before the client is shown anything.
 *
 * Every question is asked through the REAL chat path and every figure in the
 * answer is checked against a value this script computes itself with SQL. An
 * agent that produces a confident wrong number is worse than one that fails,
 * so "it replied" is not a pass here — the number has to match.
 *
 * Numbers are matched by their DIGITS, ignoring separators and currency, so
 * "8,421,009", "8421009" and "₪8.42M" all compare equal against the truth.
 * Rounded forms are accepted within the tolerance each check declares, because
 * a model reporting ₪8.42M for 8,421,009 is right, not wrong.
 *
 *   node verification/superhist-acceptance/run-acceptance.js
 */
const SCHEMA = 'superhist';
const AGENT = 'SuperHist';

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail) {
  if (cond) { console.log(`   ok   ${name}`); pass++; }
  else { console.log(`   FAIL ${name}${detail ? ` — ${detail}` : ''}`); fail++; }
  results.push({ name, passed: Boolean(cond), detail: detail || null });
}

/** All numbers in a reply, as plain integers, so formatting cannot hide a match. */
function numbersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\d[\d,.\s]*/g)) {
    const raw = m[0].replace(/[\s,]/g, '');
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
    // "8.42" in "₪8.42M" — also record the millions reading
    if (/^\d+\.\d+$/.test(raw)) out.push(Number(raw) * 1e6);
  }
  return out;
}

/** Does the reply state this value, within tolerance? */
function states(reply, truth, tolerance = 0.005) {
  return numbersIn(reply).some(n => Math.abs(n - truth) <= Math.abs(truth) * tolerance + 1);
}

async function main() {
  await db.initialize();
  await require('../../services/provider-config.service').initialize();
  const { runChatTurn } = require('../../services/chat-turn.service');
  const pool = registry.get(SCHEMA).getPool();
  const one = async (sql) => (await pool.query(sql)).rows[0];

  // ── ground truth, computed here and used to judge every answer ────────────
  console.log('\nGround truth from the database');
  const t = {};
  const a = await one(`SELECT count(*)::int orders, count(DISTINCT customer_id)::int members,
                              to_char(min(order_date),'YYYY-MM-DD') d0, to_char(max(order_date),'YYYY-MM-DD') d1,
                              round(sum(order_total))::bigint total
                         FROM ${SCHEMA}.orders`);
  Object.assign(t, a);
  const b = await one(`SELECT round(sum(line_total))::bigint revenue, round(sum(subsidy))::bigint subsidy,
                              sum(quantity)::bigint units, count(DISTINCT item_id)::int items
                         FROM ${SCHEMA}.order_lines WHERE line_kind = 'product'`);
  Object.assign(t, b);
  const c = await one(`SELECT count(*)::int repeat_members FROM (
                         SELECT customer_id FROM ${SCHEMA}.orders GROUP BY 1 HAVING count(*) > 1) x`);
  Object.assign(t, c);
  const topItem = await one(`SELECT item_name, round(revenue_inc_vat)::bigint rev, units::bigint u
                               FROM ${SCHEMA}.mv_sales_item ORDER BY revenue_inc_vat DESC LIMIT 1`);
  const topPay = await one(`SELECT payment_method, count(*)::int n FROM ${SCHEMA}.orders
                             GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
  const july = await one(`SELECT round(sum(order_total))::bigint v, count(*)::int n FROM ${SCHEMA}.orders
                           WHERE order_date >= '2026-07-01' AND order_date < '2026-08-01'`);

  for (const [k, v] of Object.entries(t)) console.log(`   ${k.padEnd(16)} ${v}`);
  console.log(`   ${'top item'.padEnd(16)} ${topItem.item_name} — ₪${Number(topItem.rev).toLocaleString()}`);
  console.log(`   ${'top payment'.padEnd(16)} ${topPay.payment_method} (${topPay.n})`);
  console.log(`   ${'july'.padEnd(16)} ₪${Number(july.v).toLocaleString()} over ${july.n} orders`);

  const ask = async (q) => {
    const r = await runChatTurn({
      message: q,
      conversationId: `sh-accept-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      agentName: AGENT,
      userId: 'sh-acceptance',
    });
    return r.reply || '';
  };

  // ── 1. the figures a client checks first ──────────────────────────────────
  console.log('\n1 · Headline figures, checked against the database');
  {
    const r = await ask('What is total order revenue and how many orders are there?');
    ok('states the order count', states(r, t.orders), `expected ${t.orders}`);
    ok('states a revenue that matches the ledger',
      states(r, Number(t.total), 0.01) || states(r, Number(t.revenue), 0.01),
      `expected ${t.total} (with shipping) or ${t.revenue} (product lines)`);
    results.push({ question: 'revenue+orders', reply: r });
  }
  {
    const r = await ask('כמה לקוחות שונים הזמינו, וכמה מהם הזמינו יותר מפעם אחת?');
    ok('Hebrew: states the member count', states(r, t.members), `expected ${t.members}`);
    ok('Hebrew: states the repeat count', states(r, t.repeat_members), `expected ${t.repeat_members}`);
    ok('Hebrew: answers in Hebrew', /[֐-׿]/.test(r));
    results.push({ question: 'members (he)', reply: r });
  }
  {
    const r = await ask('How much subsidy did the union fund in total?');
    ok('states the subsidy total', states(r, Number(t.subsidy), 0.01), `expected ${t.subsidy}`);
    ok('does not present subsidy as a discount off revenue',
      !/discount|off the price|deducted from revenue/i.test(r));
    results.push({ question: 'subsidy', reply: r });
  }
  {
    const r = await ask('What is the single best-selling product by revenue?');
    ok('names the top product', r.includes(topItem.item_name.slice(0, 12)), `expected ${topItem.item_name}`);
    ok('states its revenue', states(r, Number(topItem.rev), 0.01), `expected ${topItem.rev}`);
    results.push({ question: 'top product', reply: r });
  }
  {
    const r = await ask('Which payment method is used most, and on how many orders?');
    // The DB value is Hebrew ("כרטיס אשראי") and the question was English, so a
    // correct answer TRANSLATES it — the crew mirrors the language it was asked
    // in. Demanding the stored string back was this check being wrong about
    // what a right answer looks like, not the agent being wrong.
    ok('names the top payment method',
      r.includes(topPay.payment_method) || /credit\s*card/i.test(r),
      `expected ${topPay.payment_method} or its English rendering`);
    ok('states its order count', states(r, topPay.n), `expected ${topPay.n}`);
    results.push({ question: 'payment method', reply: r });
  }

  // ── 2. refusals — the questions this data cannot answer ───────────────────
  console.log('\n2 · Refusals, where the data has nothing to give');
  const refusals = [
    ['sales by category', 'What are our sales by product category?', /categor/i],
    ['gross margin', 'What is our gross margin this month?', /margin|cost/i],
    ['top stores', 'Which store sells the most?', /store|branch|online/i],
    ['category (he)', 'מה המכירות לפי קטגוריה?', /קטגור|category/i],
  ];
  for (const [name, q, topic] of refusals) {
    const r = await ask(q);
    // A refusal is judged by SUBSTANCE, not by a phrase list. "There are no
    // stores or branches to compare — the Social Supermarket operates
    // exclusively online" is a perfect refusal and matched none of the wordings
    // this check first demanded. What actually matters is that it declines and
    // says why, and that it does not hand over a fabricated breakdown instead.
    const declines = /cannot|can't|unable|not available|no .*(data|column|taxonomy|stores?|branch|cost)|there (is|are) no|does not (exist|contain)|not .*(recorded|included)|אין|לא ניתן|לא קיים|לא נכלל/i.test(r);
    // The tell-tale of a fabricated answer: a ranked table where there should
    // be an explanation.
    const inventedTable = /\|\s*-{2,}\s*\|/.test(r) && /\|.*\|.*\|/.test(r);
    ok(`refuses ${name}`, declines && topic.test(r) && !inventedTable, r.slice(0, 110));
    results.push({ question: name, reply: r, refused: declines });
  }

  // ── 3. the partial-month trap ─────────────────────────────────────────────
  console.log('\n3 · The partial month is disclosed, not reported as a collapse');
  {
    const r = await ask('Compare July and August revenue. Did sales collapse?');
    ok('states the July figure', states(r, Number(july.v), 0.02), `expected ${july.v}`);
    ok('says August is incomplete rather than reporting a crash',
      /partial|incomplete|only .*(11|eleven)|through 2026-08-11|11 August|לא מלא|חלקי/i.test(r),
      r.slice(0, 140));
    results.push({ question: 'partial month', reply: r });
  }

  // ── 4. the shipping rows must not leak into item answers ──────────────────
  console.log('\n4 · Shipping rows stay out of item answers');
  {
    const r = await ask('How many distinct products were sold, and how many units in total?');
    ok('states the true item count (1,481, not 3,202)',
      states(r, t.items) && !states(r, 3202, 0),
      `expected ${t.items}`);
    ok('states the unit total', states(r, Number(t.units), 0.01), `expected ${t.units}`);
    results.push({ question: 'distinct items', reply: r });
  }

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);

  fs.writeFileSync(
    path.join(__dirname, 'acceptance-results.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), schema: SCHEMA, truth: t, pass, fail, results }, null, 1)
  );
  console.log(`→ ${path.join(__dirname, 'acceptance-results.json')}`);

  // Leave nothing behind in the shared store.
  const ids = await db.query("SELECT id FROM conversations WHERE external_id LIKE 'sh-accept-%'");
  if (ids.rows.length) {
    const list = ids.rows.map(r => r.id);
    await db.query('DELETE FROM thinking_steps WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ANY($1::int[]))', [list]).catch(() => {});
    await db.query('DELETE FROM messages WHERE conversation_id = ANY($1::int[])', [list]);
    await db.query('DELETE FROM conversations WHERE id = ANY($1::int[])', [list]);
    console.log(`cleaned up ${list.length} acceptance conversations`);
  }

  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('acceptance run failed:', e.message); process.exit(1); });
