/**
 * Runs the ZolStock question set (scripts/zolstock-qa-cases.js) through the
 * REAL pipelines and captures everything needed to judge accuracy afterwards:
 * the SQL that ran, the figures shown, and — for reports — an independent
 * re-execution of the cited SQL with code-computed aggregates to compare
 * against.
 *
 *   node scripts/zolstock-qa-run.js reports [from] [to]
 *   node scripts/zolstock-qa-run.js chat    [from] [to]
 *
 * `from`/`to` are 1-based case indexes, so a long run can be done in batches
 * without losing earlier results (each batch writes its own file).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const mode = process.argv[2] || 'reports';
const from = parseInt(process.argv[3] || '1', 10);
const to = parseInt(process.argv[4] || '999', 10);

const db = require('../services/db.pg');
const registry = require('../insights/datasets/registry');
const { REPORT_CASES, CHAT_CASES } = require('./zolstock-qa-cases');

const DATASET = 'zolstock';
const OUT_DIR = path.join(__dirname, '..', 'verification', 'zolstock-quality');

function figuresOf(insight) {
  const out = [];
  for (const b of insight.blocks || []) {
    if (b.type === 'ranked_list') for (const it of b.items || []) out.push({ kind: 'ranked_list', label: it.label, value: it.value });
    else if (b.type === 'comparison') for (const it of b.items || []) out.push({ kind: 'comparison', label: it.label, value: it.value });
    else if (b.type === 'stat_callout') out.push({ kind: 'stat_callout', label: b.label, value: b.value });
    else if (b.type === 'chart') out.push({ kind: 'chart', label: b.chart?.title, value: (b.chart?.series?.[0]?.points || []).join(' | ') });
  }
  out.push({ kind: 'impactValue', label: insight.impactLabel, value: insight.impactValue });
  return out;
}

/**
 * Which language is this text WRITTEN in?
 *
 * Not "does it contain a Hebrew character" — that was the previous test and it
 * produced false failures on every correct English answer, because entity names
 * come straight from the data and must never be translated ("כלי בית leads with
 * ₪71.6M profit" is a correct English headline). Comparing letter counts
 * distinguishes prose language from embedded data values.
 */
function detectLanguage(text) {
  const s = String(text || '');
  const hebrew = (s.match(/[֐-׿]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (hebrew === 0 && latin === 0) return null;
  return hebrew > latin ? 'he' : 'en';
}

async function runReports(pool) {
  const investigation = require('../insights/services/investigation.service');
  const DataReloadService = require('../services/data-reload.service');
  const drs = new DataReloadService(db);
  for (const a of ['zer4u', 'newdeli', 'thestock', 'hypertoy', 'zolstock', 'tevanaot']) {
    require(`../agents/${a}/data-reload`).register(drs);
  }
  investigation.setDataReloadService(drs);

  const userId = `zolqa-${crypto.randomUUID()}`;
  const cases = REPORT_CASES.slice(from - 1, to);
  const results = [];

  for (const c of cases) {
    const t0 = Date.now();
    const row = { ...c };
    let insight = null;
    try {
      insight = await investigation.investigate(DATASET, userId, c.prompt, `job-${crypto.randomUUID()}`);
      row.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      row.headline = insight.headline;
      row.title = insight.title;
      row.impact = `${insight.impactValue} (${insight.impactLabel})`;
      row.tag = insight.tag;
      row.confidence = insight.confidence;
      row.claimed = insight.evidence?.confidenceClaimed;
      row.ceiling = insight.evidence?.confidenceCeiling;
      row.sqlConfidence = insight.evidence?.sqlConfidence;
      row.verified = insight.evidence?.verification?.verified;
      row.issues = insight.evidence?.verification?.issues;
      row.dataQuestion = insight.evidence?.dataQuestion;
      // These three are the whole point of C3/C5 — capture them, or the suite
      // reports "null" for a field the pipeline actually populated and the
      // conclusion drawn from the run is wrong. (This happened: the 2026-08-19
      // run reported 0 declared departures while every one was in fact set.)
      row.substitution = insight.evidence?.substitution || null;
      row.scopeAdded = insight.evidence?.scopeAdded || null;
      row.coverage = insight.evidence?.coverage || null;
      row.sql = insight.evidence?.sql;
      row.aggregation = insight.evidence?.aggregation;
      row.figures = figuresOf(insight);
      row.answeredIn = detectLanguage(insight.headline);
      row.languageOk = (c.lang === 'he' || c.lang === 'en') ? row.answeredIn === c.lang : null;

      // Independent re-execution of the cited SQL for later comparison.
      try {
        const fresh = await pool.query(insight.evidence.sql);
        row.truthRowCount = fresh.rows.length;
        row.truthSample = fresh.rows.slice(0, 12);
      } catch (e) { row.truthError = e.message.slice(0, 160); }
    } catch (err) {
      row.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      row.error = err.message.slice(0, 240);
    }
    results.push(row);
    console.log(`[${c.id}/${c.kind}/${c.lang}] ${row.error ? 'ERROR: ' + row.error.slice(0, 70) : (row.headline || '').slice(0, 80)} · ${row.seconds}s`);
    if (insight) await investigation.deleteGenerated(DATASET, userId, insight.id).catch(() => {});
  }
  return results;
}

async function runChat(pool) {
  const { DataQueryService } = require('../services/data-query.service');
  const svc = new DataQueryService(pool);
  const cases = CHAT_CASES.slice(from - 1, to);
  const results = [];

  for (const c of cases) {
    const t0 = Date.now();
    // Exactly the crew's call shape: no dataThroughDate, no timeout override.
    const r = await svc.queryByQuestion(c.q, DATASET, { agentName: DATASET, llmAgentName: DATASET });
    const row = {
      ...c,
      seconds: +((Date.now() - t0) / 1000).toFixed(1),
      error: r.error ? (r.timeout ? 'TIMEOUT' : String(r.message).slice(0, 160)) : null,
      confidence: r.confidence || null,
      rowCount: r.rowCount ?? 0,
      columns: r.columns || [],
      sample: (r.data || []).slice(0, 8),
      sql: r.sql || null,
    };
    results.push(row);
    console.log(`[${c.id}/${c.kind}/${c.lang}] ${row.error ? 'ERROR ' + row.error.slice(0, 60) : row.rowCount + ' rows (conf ' + row.confidence + ')'} · ${row.seconds}s`);
  }
  return results;
}

async function main() {
  await db.initialize();
  const pool = registry.get(DATASET).getPool();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = mode === 'chat' ? await runChat(pool) : await runReports(pool);

  const out = path.join(OUT_DIR, `${mode}-${from}-${Math.min(to, from + results.length - 1)}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\n→ ${results.length} case(s) written to ${path.relative(path.join(__dirname, '..'), out)}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
