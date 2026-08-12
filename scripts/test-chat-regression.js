/**
 * Data Chat regression + accuracy harness.
 *
 * Insights and Data Chat share one NL->SQL engine, and this session changed
 * that shared engine: SQL generation pinned to temperature 0, a generic
 * join-fan-out rule added, the zer4u rules rewritten wholesale, tevanaot's
 * phantom mv_parts_dim replaced with an inline CTE, and a live-catalog rule
 * corrector injected. Insights was re-verified after each change; CHAT WAS NOT.
 *
 * This replicates the crew's call EXACTLY (see agents/<x>/crew/*.crew.js):
 * queryByQuestion(question, schema, { agentName, llmAgentName }) — note chat
 * passes NO dataThroughDate and NO timeout override, so it runs on the 15s
 * default with no recency anchor. Testing through the insights path would not
 * exercise what chat actually does.
 *
 * Usage: node scripts/test-chat-regression.js [datasetId]
 */
require('dotenv').config();
const fs = require('fs');
const registry = require('../insights/datasets/registry');
const { DataQueryService } = require('../services/data-query.service');

const only = process.argv[2];

/** 2 SIMPLE (one fact / plain list) + 2 COMPLEX (comparison, trend, or two measures) per dataset. */
const QUESTIONS = {
  hypertoy: [
    ['simple',  'What is the total revenue this year?'],
    ['simple',  'What are the top 10 products by quantity sold?'],
    ['complex', 'What is the profit margin percentage by product family?'],
    ['complex', 'Which stores are below their sales target this year, and by how much?'],
  ],
  zer4u: [
    ['simple',  'What is the total revenue by store?'],
    ['simple',  'What are the top 10 items by quantity sold?'],
    ['complex', 'What is the monthly revenue trend?'],
    ['complex', 'Which product categories generate the most revenue?'],
  ],
  newdeli: [
    ['simple',  'How many completed orders are there in total?'],
    ['simple',  'What is the average order value?'],
    ['complex', 'What is the monthly order volume by branch?'],
    ['complex', 'Which order items appear most frequently?'],
  ],
  thestock: [
    ['simple',  'What is the total revenue?'],
    ['simple',  'What are the top 10 stores by revenue?'],
    ['complex', 'What is the monthly revenue trend?'],
    ['complex', 'Which products sell the most units?'],
  ],
  zolstock: [
    ['simple',  'What is the total revenue?'],
    ['simple',  'What are the top 10 items by quantity sold?'],
    ['complex', 'What is the revenue by store?'],
    ['complex', 'Which sellers generate the highest sales?'],
  ],
  tevanaot: [
    ['simple',  'What is the total revenue?'],
    ['simple',  'What are the top 10 shoe models by quantity sold?'],
    ['complex', 'What is the revenue by store?'],
    ['complex', 'How much inventory value is on hand by store?'],
  ],
};

/**
 * Hebrew and mixed Hebrew/English questions. These agents are bilingual by
 * design (see each crew's guidance: "responds in the language the user writes
 * in") and Hebrew is the primary language in practice, so the English pass
 * alone proves little. Mixed-language input is realistic too — users reach for
 * the English term for a metric ("revenue", "top 10") inside a Hebrew sentence.
 */
const HEBREW_QUESTIONS = {
  hypertoy: [
    ['he',    'מה סך ההכנסות לפי סניף?'],
    ['mixed', 'תראה לי top 10 מוצרים לפי revenue'],
  ],
  zer4u: [
    ['he',    'מה סך ההכנסות לפי חנות?'],
    ['mixed', 'מה ה-revenue trend לפי חודש?'],
  ],
  newdeli: [
    ['he',    'כמה הזמנות שהושלמו יש בכל סניף?'],
    ['mixed', 'מה ה-average order value?'],
  ],
  thestock: [
    ['he',    'מה סך ההכנסות?'],
    ['mixed', 'תן לי top 10 חנויות לפי revenue'],
  ],
  zolstock: [
    ['he',    'מה סך ההכנסות לפי חנות?'],
    ['mixed', 'מהם ה-top 10 items לפי כמות?'],
  ],
  tevanaot: [
    ['he',    'מה סך ההכנסות לפי חנות?'],
    ['mixed', 'כמה inventory value יש לנו לפי סניף?'],
  ],
};

async function main() {
  const results = [];
  const useHebrew = process.argv.includes('--hebrew');
  const SET = useHebrew ? HEBREW_QUESTIONS : QUESTIONS;
  const datasets = only && only !== '--hebrew' ? [only] : Object.keys(SET);

  for (const ds of datasets) {
    const entry = registry.get(ds);
    const svc = new DataQueryService(entry.getPool());
    for (const [level, question] of SET[ds]) {
      const t0 = Date.now();
      // Exactly the crew's call shape — no dataThroughDate, no timeout.
      const r = await svc.queryByQuestion(question, entry.schemaName, {
        agentName: ds,
        llmAgentName: ds,
      });
      const row = {
        dataset: ds, level, question,
        seconds: +((Date.now() - t0) / 1000).toFixed(1),
        error: r.error ? (r.timeout ? 'TIMEOUT' : r.message?.slice(0, 120)) : null,
        confidence: r.confidence || null,
        rowCount: r.rowCount ?? 0,
        columns: r.columns || [],
        sample: (r.data || []).slice(0, 3),
        sql: r.sql || null,
      };
      results.push(row);
      const status = row.error ? `ERROR ${row.error}` : `${row.rowCount} rows (conf ${row.confidence})`;
      console.log(`[${ds}/${level}] ${status} · ${row.seconds}s · ${question}`);
    }
  }

  // Per-dataset filename: concurrent runs would otherwise overwrite each
  // other's results and silently leave only the last writer's SQL behind.
  const path=require('path');const dir=path.join(__dirname,'..','verification','chat-regression');fs.mkdirSync(dir,{recursive:true});const out=path.join(dir,'chat-regression-'+(useHebrew?'he-':'')+(only&&only!=='--hebrew'?only:'all')+'.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`→ written to ${out}`);
  const errs = results.filter(r => r.error).length;
  const empty = results.filter(r => !r.error && r.rowCount === 0).length;
  console.log(`\n${results.length} questions · ${errs} errored · ${empty} returned zero rows · ${results.length - errs - empty} returned data`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
