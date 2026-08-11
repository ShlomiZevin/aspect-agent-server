/**
 * Cross-dataset accuracy suite for Aspect Intelligence.
 *
 * For every prompt it runs the REAL pipeline in-process, then independently
 * re-executes the SQL the resulting insight cites, rebuilds the authoritative
 * aggregates from that fresh result, and compares EVERY number the write-up
 * put on screen against them. The point is not "did it finish" (that's
 * test-insights-battery.js) — it's "is what it said true".
 *
 * Prompts come from two places:
 *   · the dataset's own configured example prompts (the chips a user clicks)
 *   · a hand-written set of 2 simple + 2 complex questions per dataset below
 *
 * Datasets that are not enabled are enabled for the duration of the run and
 * restored afterwards in a finally block, so the suite can cover all six
 * without leaving config changed.
 *
 * Usage:
 *   node scripts/test-insights-suite.js <datasetId> [chips|manual|all]
 */
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const datasetId = process.argv[2] || 'hypertoy';
const which = process.argv[3] || 'all';

const db = require('../services/db.pg');
const registry = require('../insights/datasets/registry');
const { buildResultDigest, parseNumeric } = require('../insights/services/result-digest.service');

/**
 * Hand-written cases per dataset: 2 SIMPLE (a single fact or a plain list) and
 * 2 COMPLEX (needs comparison, ranking over time, or two measures at once) —
 * deliberately not overcomplicated, so a wrong answer means a real defect
 * rather than an unanswerable question. Worded from each dataset's own
 * documented data model.
 */
const MANUAL_CASES = {
  hypertoy: [
    { level: 'simple', prompt: 'What is the total revenue by store?' },
    { level: 'simple', prompt: 'What are the top 10 product families by units sold?' },
    { level: 'complex', prompt: 'Which stores have the largest gap between sales target and actual revenue this year?' },
    { level: 'complex', prompt: 'Which product families combine high revenue with below-average profit margin?' },
  ],
  zer4u: [
    { level: 'simple', prompt: 'What is the total revenue by store?' },
    { level: 'simple', prompt: 'What are the top 10 items by quantity sold?' },
    { level: 'complex', prompt: 'Which stores are furthest behind their sales target this quarter, and by how much?' },
    { level: 'complex', prompt: 'Which product categories declined the most in revenue over the last several months?' },
  ],
  newdeli: [
    { level: 'simple', prompt: 'How many completed orders does each branch have?' },
    { level: 'simple', prompt: 'What is the average order value overall?' },
    { level: 'complex', prompt: 'Which branches have the steepest decline in order volume over the last few months?' },
    { level: 'complex', prompt: 'Which order items appear most often, and how does that compare across branches?' },
  ],
  thestock: [
    { level: 'simple', prompt: 'What is the total revenue by store?' },
    { level: 'simple', prompt: 'What are the top 10 products by revenue?' },
    { level: 'complex', prompt: 'Which stores have the steepest revenue decline over the last several months?' },
    { level: 'complex', prompt: 'Which SKUs tie up the most inventory value relative to how fast they sell?' },
  ],
  zolstock: [
    { level: 'simple', prompt: 'What is the total revenue by store?' },
    { level: 'simple', prompt: 'What are the top 10 items by quantity sold?' },
    { level: 'complex', prompt: 'Which stores have the steepest sales decline over recent weeks?' },
    { level: 'complex', prompt: 'How concentrated is profit across sellers — do a few sellers drive most of it?' },
  ],
  tevanaot: [
    { level: 'simple', prompt: 'What is the total revenue by store?' },
    { level: 'simple', prompt: 'What are the top 10 shoe models by quantity sold?' },
    { level: 'complex', prompt: 'Which shoe models tie up the most inventory value with the slowest sell-through?' },
    { level: 'complex', prompt: 'How does revenue split by shoe season across the last several months?' },
  ],
};

/**
 * HEBREW case set — the same two simple questions per dataset as MANUAL_CASES,
 * asked in Hebrew. These clients are Israeli retailers and Hebrew is the
 * primary language of the product, so an English-only pass proves very little:
 * the schemas hold Hebrew values (record types, store and product names), and
 * the write-up is expected to answer in the language it was asked in.
 */
const HEBREW_CASES = {
  hypertoy: [
    { level: 'he-simple', prompt: 'מה סך ההכנסות לפי סניף?' },
    { level: 'he-simple', prompt: 'מהן 10 משפחות המוצרים המובילות לפי כמות שנמכרה?' },
  ],
  zer4u: [
    { level: 'he-simple', prompt: 'מה סך ההכנסות לפי חנות?' },
    { level: 'he-simple', prompt: 'מהם 10 הפריטים הנמכרים ביותר לפי כמות?' },
  ],
  newdeli: [
    { level: 'he-simple', prompt: 'כמה הזמנות שהושלמו יש בכל סניף?' },
    { level: 'he-simple', prompt: 'מהו ערך ההזמנה הממוצע?' },
  ],
  thestock: [
    { level: 'he-simple', prompt: 'מה סך ההכנסות לפי חנות?' },
    { level: 'he-simple', prompt: 'מהם 10 המוצרים המובילים לפי הכנסה?' },
  ],
  zolstock: [
    { level: 'he-simple', prompt: 'מה סך ההכנסות לפי חנות?' },
    { level: 'he-simple', prompt: 'מהם 10 הפריטים המובילים לפי כמות שנמכרה?' },
  ],
  tevanaot: [
    { level: 'he-simple', prompt: 'מה סך ההכנסות לפי חנות?' },
    { level: 'he-simple', prompt: 'מהם 10 דגמי הנעליים הנמכרים ביותר לפי כמות?' },
  ],
};

/** Pulls every displayed figure out of an insight's blocks, with its label. */
function reportedFigures(insight) {
  const out = [];
  for (const b of insight.blocks || []) {
    if (b.type === 'ranked_list') for (const it of b.items || []) out.push({ kind: 'ranked_list', label: it.label, value: it.value });
    else if (b.type === 'comparison') for (const it of b.items || []) out.push({ kind: 'comparison', label: it.label, value: it.value });
    else if (b.type === 'stat_callout') out.push({ kind: 'stat_callout', label: b.label, value: b.value });
  }
  out.push({ kind: 'impactValue', label: insight.impactLabel || 'impact', value: insight.impactValue });
  return out;
}

/** "Campaign #146" / "  Lego " -> a comparable key. */
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[#"'`]/g, '').replace(/\s+/g, ' ').trim();
}

function toNumber(v) {
  const s = String(v ?? '');
  const m = /(-?[\d,]+(?:\.\d+)?)\s*([KM])?/i.exec(s);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  if (m[2]) n *= m[2].toUpperCase() === 'K' ? 1e3 : 1e6;
  if (s.trimStart().startsWith('-') && n > 0) n = -n;
  return n;
}

/**
 * Matches a displayed figure against the code-computed groups. Returns a
 * verdict rather than a boolean so the report can distinguish "wrong" from
 * "not checkable" — a scenario projection or a derived ratio has no
 * corresponding group and must not be scored as a failure.
 */
function checkFigure(fig, digest) {
  const reported = toNumber(fig.value);
  if (reported === null) return { verdict: 'n/a', actual: null, note: 'non-numeric' };
  if (!digest.regrouped || digest.groups.length === 0) return { verdict: 'n/a', actual: null, note: 'no authoritative grouping' };


  // Roll-up labels ("Top 10 Stores", "Combined target (5 stores)", "Remaining
  // 46 Stores") describe an aggregate ACROSS groups, not one entity, so there
  // is no single group to compare them with. Matching them loosely to one
  // group produced nine phantom failures against figures that were exactly
  // right — e.g. "Top 10 Stores: ₪24,978,277", verified correct by SQL, was
  // compared against a single store's ₪2,366,026.
  if (/\b(top|bottom|combined|remaining|rest|overall|others?|average|avg|total)\b/i.test(fig.label) ||
      /\(\s*\d+\s*[^)]*\)/.test(fig.label)) {
    return { verdict: 'n/a', actual: null, note: 'aggregate label — not a single entity' };
  }
  // Ranked-list labels often carry an annotation ("store-114 — avg attainment
  // 46.2%"); match on the entity part only.
  fig = { ...fig, label: String(fig.label).split(/\s+[\u2014\u2013]\s+/)[0] };
  const target = norm(fig.label);
  // Exact match first. Substring matching is only trusted when EXACTLY ONE
  // group matches — otherwise it silently compares two different entities and
  // reports a phantom failure. Real case: "עזריאלי תל אביב" substring-matched
  // the separate branch "עזריאלי", and "מרכזית ירושלים" matched "תחנה מרכזית
  // ירושלים", producing two 30-47% "mismatches" against figures that were in
  // fact exactly right.
  let hit = digest.groups.find(g => norm(g.key) === target);
  if (!hit) {
    const loose = digest.groups.filter(g => {
      const k = norm(g.key);
      return k.includes(target) || target.includes(k);
    });
    if (loose.length !== 1) return { verdict: 'n/a', actual: null, note: loose.length ? 'ambiguous label' : 'label not in groups' };
    hit = loose[0];
  }

  // A percentage/pp figure has no counterpart among summed measures — comparing
  // "-68.03%" against a revenue total is meaningless and was reporting a
  // guaranteed "100% off".
  if (/%|pp\b|pts\b/i.test(String(fig.value))) return { verdict: 'n/a', actual: null, note: 'percentage — no additive counterpart' };

  const candidates = Object.values(hit.values).filter(v => Number.isFinite(v));
  let best = null, bestErr = Infinity;
  for (const c of candidates) {
    const err = Math.abs(c) < 1e-9 ? (Math.abs(reported) < 1e-9 ? 0 : Infinity) : Math.abs(reported - c) / Math.abs(c);
    if (err < bestErr) { bestErr = err; best = c; }
  }
  if (best === null) return { verdict: 'n/a', actual: null, note: 'no numeric measure' };
  // 1.5% tolerance absorbs the model's rounding ("₪568K" for 568,402).
  return { verdict: bestErr <= 0.015 ? 'MATCH' : 'MISMATCH', actual: best, err: bestErr };
}

async function main() {
  await db.initialize();
  const investigation = require('../insights/services/investigation.service');

  // server.js wires this at startup; without it getDataThroughDate() returns
  // null, so the data-recency anchor is silently absent and every relative
  // window falls back to CURRENT_DATE. A harness that skips it does not
  // exercise the real pipeline — it nearly caused a working fix to be
  // reported as ineffective.
  const DataReloadService = require('../services/data-reload.service');
  const dataReloadService = new DataReloadService(db);
  for (const a of ['zer4u', 'newdeli', 'thestock', 'hypertoy', 'zolstock', 'tevanaot']) {
    require(`../agents/${a}/data-reload`).register(dataReloadService);
  }
  investigation.setDataReloadService(dataReloadService);
  const configService = require('../insights/services/intelligence-config.service');
  const pool = registry.get(datasetId).getPool();

  const config = await configService.getConfig(datasetId);
  const wasEnabled = config.enabled;
  const userId = `suite-${crypto.randomUUID()}`;
  const results = [];
  const created = [];

  try {
    if (!wasEnabled) {
      await configService.setConfig(datasetId, { enabled: true });
      console.log(`(temporarily enabled ${datasetId} for this run)`);
    }

    const cases = [];
    if (which === 'chips' || which === 'all') {
      for (const p of (config.examplePrompts || [])) cases.push({ level: 'chip', prompt: p });
    }
    if (which === 'hebrew') {
      for (const c of (HEBREW_CASES[datasetId] || [])) cases.push(c);
    }
    if (which === 'manual' || which === 'all') {
      for (const c of (MANUAL_CASES[datasetId] || [])) cases.push(c);
    }

    for (const c of cases) {
      const t0 = Date.now();
      const row = { dataset: datasetId, level: c.level, prompt: c.prompt };
      try {
        const insight = await investigation.investigate(datasetId, userId, c.prompt, `job-${crypto.randomUUID()}`);
        created.push(insight.id);
        row.seconds = +((Date.now() - t0) / 1000).toFixed(1);
        row.tag = insight.tag;
        row.confidence = insight.confidence;
        row.claimed = insight.evidence.confidenceClaimed;
        row.ceiling = insight.evidence.confidenceCeiling;
        row.verified = insight.evidence.verification.verified;
        row.issues = insight.evidence.verification.issues;
        row.headline = insight.headline;
        row.impact = `${insight.impactValue} (${insight.impactLabel})`;
        row.sqlConfidence = insight.evidence.sqlConfidence;
        row.aggregation = insight.evidence.aggregation;
        row.sql = insight.evidence.sql;

        // Independent re-verification against a fresh execution of its own SQL.
        const fresh = await pool.query(insight.evidence.sql);
        const truth = buildResultDigest(fresh.rows, {
          dimensions: insight.evidence.aggregation?.groupedBy || [],
          measures: [],
        });
        row.truthRows = fresh.rows.length;
        row.checks = reportedFigures(insight).map(f => ({ ...f, ...checkFigure(f, truth) }));
        row.mismatches = row.checks.filter(x => x.verdict === 'MISMATCH').length;
        row.matches = row.checks.filter(x => x.verdict === 'MATCH').length;
      } catch (err) {
        row.seconds = +((Date.now() - t0) / 1000).toFixed(1);
        row.error = err.message;
      }
      results.push(row);
      const flag = row.error ? 'ERROR' : (row.mismatches ? `${row.mismatches} MISMATCH` : `${row.matches} ok`);
      console.log(`[${datasetId}/${c.level}] ${flag} · ${row.seconds}s · ${(row.headline || row.error || '').slice(0, 95)}`);
    }
  } finally {
    for (const id of created) await investigation.deleteGenerated(datasetId, userId, id).catch(() => {});
    if (!wasEnabled) {
      await configService.setConfig(datasetId, { enabled: false });
      console.log(`(restored ${datasetId} to disabled)`);
    }
  }

  // Results belong in verification/, never the repo root — see CLAUDE.md.
  const dir = path.join(__dirname, '..', 'verification', 'insights-accuracy');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `suite-results-${which === 'hebrew' ? 'he-' : ''}${datasetId}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\n→ ${results.length} case(s) written to ${out}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
