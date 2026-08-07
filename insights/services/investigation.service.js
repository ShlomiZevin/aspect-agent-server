/**
 * Real "Aspect investigates your data" pipeline for the Insights "investigate"
 * box — works for any dataset registered in ../datasets/registry.js and
 * enabled via ./intelligence-config.service.js (see the admin panel).
 *
 * Four LLM/DB round trips per dataset (PLAN, QUERY, SYNTHESIZE, VERIFY),
 * reusing the exact same engine the real chat agents use (DataQueryService ->
 * sql-generator.service -> schema-descriptor.service), so the generated SQL
 * is subject to the same safety validation and anti-pattern learning as
 * every other query on that dataset — nothing insight-specific is bypassed:
 *
 *   1. PLAN       — turn the free-text investigation prompt ("Main risks for
 *      the next 6 months") into one concrete, SQL-answerable data question
 *      plus a category classification.
 *   2. QUERY      — run that question through the real NL->SQL pipeline
 *      against the actual dataset database and get real result rows back.
 *   3. SYNTHESIZE — feed the real rows (not the plan, not a guess) back to
 *      the model and ask it to write the full insight (headline, scenarios,
 *      reasoning trail, confidence) grounded only in those numbers.
 *   4. VERIFY     — an INDEPENDENT LLM pass (no memory of writing the
 *      insight, no stake in it sounding compelling) fact-checks step 3's
 *      output against the real rows again. One regenerate-and-recheck retry
 *      if it finds unsupported numbers or internal contradictions; if it's
 *      still not satisfied after that, the insight is downgraded (tag ->
 *      "DATA QUALITY", confidence capped) rather than discarded — the query
 *      itself was real, only the write-up was over-claiming.
 *
 * PLAN and SYNTHESIZE each get one retry on a malformed/incomplete JSON
 * response (QUERY already had its own self-correcting SQL retry from day
 * one — see data-query.service.js) — a single bad LLM response no longer
 * kills the whole investigation outright.
 *
 * Generated insights are the ONLY insight content this API serves (no
 * illustrative/seed content) — persisted in Postgres via
 * ./insights-store.service.js (see db/migrations/037_add_intelligence_insights.sql).
 * NOT a local file anymore: an earlier version wrote to
 * insights/data/generated-insights.json, which lived in the deploy build
 * context and got baked into every Docker image (`COPY . .`, and that path
 * wasn't in .dockerignore) — every single deploy was silently resetting live
 * production insights back to whatever stale snapshot happened to be on the
 * deploying machine's disk. Caught live in prod 2026-08-07 (see project
 * memory) — a real insight generated during one revision's lifetime 404'd
 * the moment the next revision took over. Postgres storage doesn't have
 * that failure mode: it's the same durable DB every deploy connects to.
 */
const llmService = require('../../services/llm');
const { DataQueryService } = require('../../services/data-query.service');
const registry = require('../datasets/registry');
const intelligenceConfigService = require('./intelligence-config.service');
const store = require('./insights-store.service');

const MODEL = 'claude-sonnet-4-6';
const CATEGORY_COLOR = {
  'cross-sell': '#C026D3',
  margin: '#C2410C',
  inventory: '#7C3AED',
  trend: '#7C3AED',
  risk: '#C2410C',
};
const VALID_CATEGORIES = Object.keys(CATEGORY_COLOR);

/** @returns {Object} the registry entry for a dataset id — throws a 404-shaped error if unknown. */
function getDatasetEntry(datasetId) {
  const entry = registry.get(datasetId);
  if (!entry) {
    const err = new Error(`Unknown dataset: ${datasetId}`);
    err.status = 404;
    throw err;
  }
  return entry;
}

// Set once at server startup (see server.js, next to the data-reload
// registrations) — lets getDataThroughDate() reuse the SAME per-schema
// freshness lookup DataStatusBar already uses (DataReloadService.getDataInfo),
// instead of a dataset-specific hardcoded SQL query.
let dataReloadServiceRef = null;
function setDataReloadService(instance) {
  dataReloadServiceRef = instance;
}

// bootstrap() has no requesting user (admin/system-triggered dataset seed,
// see bootstrap() below) — its output lives under this fixed sentinel rather
// than a real anon id. Reports are otherwise private per anonymous browser
// session — the same identity model chat conversations already use (see
// services/conversation.service.js: users.externalId, created by
// POST /api/user/create, persisted client-side in localStorage).
const BOOTSTRAP_USER_ID = 'system';

// datasetId -> DataQueryService — several datasets currently share one
// underlying pg Pool (see services/db.*.js), but a dedicated pool for any of
// them is just as valid, so this is keyed per dataset rather than assuming
// a single shared instance.
const dataQueryServices = new Map();
function getDataQueryService(datasetId) {
  if (!dataQueryServices.has(datasetId)) {
    dataQueryServices.set(datasetId, new DataQueryService(getDatasetEntry(datasetId).getPool()));
  }
  return dataQueryServices.get(datasetId);
}

// Real "today" for this dataset, cached after the first lookup per dataset —
// without this, the model has no idea what year the business is actually in
// and falls back to guessing from its own training era (caught writing "as
// of Q3 2024" in a headline when the data is really anchored around mid-
// 2026). Reuses the SAME per-schema freshness lookup DataStatusBar already
// uses (DataReloadService.getDataInfo → lastDataDate) instead of a
// dataset-specific hardcoded SQL query — every dataset's own reloader
// already knows how to compute this for its own schema.
const cachedDataThrough = new Map();
async function getDataThroughDate(datasetId) {
  if (cachedDataThrough.has(datasetId)) return cachedDataThrough.get(datasetId);
  let value = null;
  try {
    const schemaName = getDatasetEntry(datasetId).schemaName;
    const info = dataReloadServiceRef ? await dataReloadServiceRef.getDataInfo(schemaName) : null;
    value = info?.lastDataDate || null;
  } catch {
    value = null;
  }
  cachedDataThrough.set(datasetId, value);
  return value;
}

function extractFirstJSON(text) {
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJSON(text) {
  let clean = text.trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }
  try {
    return JSON.parse(clean);
  } catch {
    const jsonStr = extractFirstJSON(clean);
    if (!jsonStr) throw new Error('No JSON object found in model response');
    return JSON.parse(jsonStr);
  }
}

/**
 * "Gentle helper" (design turn 4c) — before committing to a multi-minute
 * investigation, check whether the typed prompt is actually just a quick
 * lookup ("top 10 products", "revenue today") that Data Chat can answer
 * instantly, rather than something worth a real investigation ("why did X
 * decline", "which stores will miss target and why"). One short, cheap LLM
 * call — no SQL, no dataset query — so it doesn't meaningfully add to the
 * wait before either path starts.
 * @returns {Promise<boolean>}
 */
async function classifyPrompt(prompt) {
  const systemPrompt = `You classify a business-intelligence request as either a SIMPLE lookup or a real INVESTIGATION.

SIMPLE: a single fact or a straightforward list, answerable by one direct query with no real reasoning needed — e.g. "top 10 products", "revenue today", "how many stores do we have", "show me last month's inventory".

INVESTIGATION: asks why something is happening, wants a comparison/trend/risk assessment, or otherwise needs analysis and judgment, not just a lookup — e.g. "why did margin drop", "which stores will miss target and why", "main risks for the next 6 months".

Respond with ONLY a JSON object: { "isSimpleQuery": true or false }`;

  try {
    const response = await llmService.sendOneShot(systemPrompt, `Request: "${prompt}"`, {
      model: MODEL, maxTokens: 64, jsonOutput: true, context: 'insights_classify_prompt',
    });
    const parsed = parseJSON(response);
    return !!parsed.isSimpleQuery;
  } catch {
    // Ambiguous is safer than blocking — if classification itself fails,
    // treat it as a real investigation and let the normal pipeline run.
    return false;
  }
}

/**
 * Code-level (non-LLM) safety net — independent of whether the synthesis
 * prompt's own self-check instruction, or the separate VERIFY step below,
 * actually catches it. Detects two shapes of "this smells like a broken
 * JOIN, not a real finding":
 *   - "all-zero": a numeric column EXACTLY 0 on every row — the original bug
 *     this was built for (the "19 stores at 0% Q3 attainment" false finding).
 *   - "all-same-value": a numeric column pinned to the exact same NON-zero
 *     value on every row — the same underlying pipeline gap, just not zero,
 *     which the original check missed entirely.
 * Real business data essentially never produces the identical value across
 * 3+ rows for a dimension that's supposed to genuinely vary (store, week,
 * SKU...); this is cheap and deterministic, so it runs before either LLM
 * step even sees the data.
 * @returns {{flagged: boolean, reason: 'all-zero'|'all-same-value'|null, columns: string[]}}
 */
function detectSuspiciousResult(data) {
  if (!Array.isArray(data) || data.length < 3) return { flagged: false, reason: null, columns: [] };
  const isNumericLike = v => typeof v === 'number' || v === null || /^-?\d+(\.\d+)?$/.test(String(v));
  const numericCols = Object.keys(data[0]).filter(k => data.every(row => isNumericLike(row[k])));

  // Require the column to be non-null numeric zero somewhere (not just
  // all-null, which is a different, benign case).
  const allZeroCols = numericCols.filter(k =>
    data.every(row => row[k] === 0 || row[k] === '0' || row[k] === '0.00' || row[k] === null)
    && data.some(row => row[k] === 0 || row[k] === '0' || row[k] === '0.00')
  );
  if (allZeroCols.length > 0) return { flagged: true, reason: 'all-zero', columns: allZeroCols };

  // Exclude columns whose own name says they're a deliberately-constant
  // benchmark (a percentile/average cross-joined onto every row for
  // comparison, e.g. "revenue_p75_threshold" or "avg_inventory_units") —
  // caught live in prod being identical isn't a JOIN bug there, it's exactly
  // how that SQL pattern is supposed to look. Deliberately does NOT exclude
  // "target" — a real per-store sales target column pinned to the same
  // value on every row IS the original bug this check exists to catch.
  const isLikelyBenchmarkCol = k => /avg|average|median|percentile|benchmark|threshold|_p\d{2}(_|$)/i.test(k);
  const allSameCols = numericCols.filter(k => {
    if (isLikelyBenchmarkCol(k)) return false;
    const values = data.map(row => String(row[k])).filter(v => v !== 'null');
    if (values.length < 3) return false;
    return values.every(v => v === values[0]) && values[0] !== '0' && values[0] !== '0.00';
  });
  if (allSameCols.length > 0) return { flagged: true, reason: 'all-same-value', columns: allSameCols };

  return { flagged: false, reason: null, columns: [] };
}

async function planQuestion(datasetId, config, prompt) {
  const dataThrough = await getDataThroughDate(datasetId);
  const systemPrompt = `You are planning a proactive business-intelligence investigation for ${config.brandLabel}. You will be given an open-ended investigation prompt (like "Main risks for the next 6 months" or "Bundle opportunities hiding in baskets"). Your job is NOT to answer it yet — it is to turn it into exactly ONE concrete, specific, SQL-answerable data question that a text-to-SQL engine could run against a single database table to gather the evidence needed.

${dataThrough ? `The data runs through ${dataThrough} — treat that as "now" for anything relative ("recent," "this quarter," "next 6 months"). Do not assume any other year.\n\n` : ''}The data available: ${config.dataModelDescription}

Respond with ONLY a JSON object:
{
  "category": one of "cross-sell" | "margin" | "inventory" | "trend" | "risk",
  "dataQuestion": "a single, specific, concrete question in English that can be answered with one SQL aggregate query — mention the measure(s), a breakdown dimension if useful (e.g. by store, by product family, by week), and a time window"
}

Pick the category that best matches what the investigation prompt is actually about. Do not hedge or ask a follow-up question — commit to one specific, well-scoped data question.`;

  // Up to 2 attempts: an LLM JSON round trip occasionally comes back
  // malformed or missing "dataQuestion" — this used to kill the whole
  // investigation immediately (no recourse, no canned fallback since Round
  // 4 — see project memory). Same "self-correcting retry" philosophy the
  // QUERY step already has for SQL execution errors, applied here to this
  // step's own failure mode instead.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await llmService.sendOneShot(systemPrompt, `Investigation prompt: "${prompt}"`, {
        model: MODEL, maxTokens: 512, jsonOutput: true, context: 'insights_investigate_plan',
      });
      const parsed = parseJSON(response);
      if (!parsed.dataQuestion) throw new Error('Plan step returned no dataQuestion');
      const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'trend';
      return { category, dataQuestion: parsed.dataQuestion };
    } catch (err) {
      lastErr = err;
      console.error(`   [plan attempt ${attempt}] failed: ${err.message}`);
    }
  }
  throw lastErr;
}

async function synthesizeInsight({ datasetId, config, prompt, category, dataQuestion, queryResult, dataAnomaly, verifierFeedback }) {
  const { sql, explanation, data, rowCount } = queryResult;
  // Cap what we feed back — enough rows to see the shape/pattern, not the whole table.
  const sampleRows = data.slice(0, 30);
  const dataThrough = await getDataThroughDate(datasetId);

  const systemPrompt = `You are Aspect, an AI that proactively investigates ${config.brandLabel}'s data and writes up findings for a business audience. You already ran a real SQL query and have the real result rows below — write the insight using ONLY these numbers. Do not invent any figure that isn't directly computable from the provided rows.

${dataThrough ? `The data runs through ${dataThrough} — that is "now." When your headline/title/description says something like "as of," "currently," "this quarter," or names a year, it MUST be consistent with that real date, not a guess from any other year.\n` : ''}
SANITY CHECK before writing anything: if EVERY row shows the key metric at exactly 0 (or some other suspiciously uniform value across 100% of rows), that is a strong signal of a JOIN/pipeline/data-gap bug, not a genuine uniform business outcome — real business data almost never produces the identical extreme value on every single row. In that case do NOT write a confident business-risk headline with a specific dollar figure. Instead: use tag "DATA QUALITY" (not "RISK" or any other category tag), keep the headline factual and hedged ("N rows show $0 — likely a data or pipeline issue, not confirmed store performance"), cap confidence at 40, and make the FIRST confidenceChecks entry the specific caveat explaining what looks broken (e.g. a join key that shouldn't match, a null field that should be populated). Only write a normal confident finding when the pattern varies across rows the way real business data does.


The detail page is NOT one fixed template — you choose, for THIS specific finding, which content blocks actually convey it best, from this palette:
- "chart": a line/bar/pie/table series over categories (weeks, months, stores, product families...) — best when there's a real trend or a multi-item breakdown worth plotting.
- "ranked_list": a numbered leaderboard of items with a value and a relative bar — best for "which N stores/products/families..." questions, where a ranked comparison IS the finding.
- "stat_callout": one big headline number with a short description — best for a simple, single-fact finding that doesn't need a trend or a ranking.
- "comparison": 2-3 side-by-side cards contrasting distinct groups (e.g. in-stock vs stockout, this month vs last month) — best when the finding IS a contrast between two or three things.
- "scenarios": exactly 4 cards (Current / Good prognosis / Neutral / Negative) with forward-looking projections — best when the finding calls for "what happens if we act vs don't."

Pick 1 to 3 blocks — whichever combination best presents THIS finding. Do not default to using all of them out of habit; a simple finding might genuinely need only a "stat_callout", while a multi-store ranking finding might need "ranked_list" + "scenarios". Never include a block type that doesn't add real information beyond what's already in another block you picked.

Respond with ONLY a JSON object with this exact shape (all string fields, ₪ for currency, matching this house style):
{
  "tag": "short uppercase label, e.g. \\"OPPORTUNITY · CROSS-SELL\\" or \\"MARGIN ALERT\\" or \\"RISK\\" or \\"TREND\\" or \\"INVENTORY\\"",
  "categoryLabel": "Cross-sell" | "Margin alert" | "Inventory" | "Trend" | "Risk",
  "confidence": integer 0-100 reflecting how strong/clear the pattern in the actual data is,
  "headline": "one sentence, specific, with real numbers from the data — shown on the card",
  "title": "a slightly longer headline for the detail page, same real numbers",
  "breadcrumbLabel": "short 3-6 word label for the breadcrumb",
  "impactValue": "short value with sign and unit, e.g. \\"+₪86K / mo\\" or \\"-₪54K / mo\\" or \\"₪2.4M locked\\"",
  "impactLabel": "1-3 words describing what impactValue is, e.g. \\"recoverable revenue\\"",
  "impactDirection": "positive" | "negative" | "neutral",
  "ctaLabel": "2-3 lowercase words for a call-to-action button, e.g. \\"restock plan\\", \\"margin plan\\", \\"action plan\\"",
  "chart": {
    "title": "UPPERCASE chart caption describing what's plotted",
    "unit": "short axis/unit label",
    "categories": ["array of 2-8 labels from the real data, e.g. store names, weeks, months"],
    "series": [{ "key": "short id", "label": "series label", "points": [numbers matching categories, from the real data] }]
  },
  "sourceNote": "one line citing the real source, e.g. \\"Source: facts table · ${rowCount} rows\\"",
  "blocks": [
    // 1-3 objects, each ONE of:
    { "type": "chart", "title": "UPPERCASE caption", "unit": "short unit", "categories": ["..."], "series": [{ "key": "id", "label": "...", "points": [numbers] }] },
    { "type": "ranked_list", "title": "short title", "unit": "short unit shown after each value", "items": [{ "label": "...", "value": "real number/short string", "pct": 0-100 relative to the top item }] },
    { "type": "stat_callout", "value": "the headline number", "label": "1-4 words", "description": "1-2 sentences of real context" },
    { "type": "comparison", "items": [{ "label": "...", "value": "...", "sub": "1 short line of context", "direction": "positive" | "negative" | "neutral" }] },
    { "type": "scenarios", "items": [
      { "key": "current", "label": "Current", "value": "real current figure", "description": "1 sentence, grounded in the data" },
      { "key": "good", "label": "Good prognosis", "value": "a plausible improved figure", "description": "1 sentence describing a realistic action and its effect" },
      { "key": "neutral", "label": "Neutral", "value": "a plausible partial figure", "description": "1 sentence describing a partial/smaller action" },
      { "key": "negative", "label": "Negative", "value": "a plausible downside figure", "description": "1 sentence describing the cost of inaction" }
    ] }
  ],
  "reasoning": [
    { "title": "short step name", "description": "what was actually done — you may reference the real SQL/measure used" },
    { "title": "short step name", "description": "..." },
    { "title": "short step name", "description": "..." }
  ],
  "confidenceChecks": [
    { "positive": true, "text": "a real strength of this finding" },
    { "positive": true, "text": "another real strength" },
    { "positive": false, "text": "a real caveat or limitation" }
  ],
  "confidenceBasis": "one sentence citing the real sample size / time window"
}

The top-level "chart" field is separate from "blocks" — it's always a small, simple preview used only on the insight's list-view card, so still fill it in even if you don't choose a "chart" block for the detail page. Inside "blocks", the only place you may reason beyond the literal query result is a "scenarios" block's good/neutral/negative values (forward-looking projections — keep them plausible and proportionate to the real current figure). Every other field, in every block, must trace back to the actual data provided.

ARITHMETIC SELF-CHECK before finalizing "impactValue" (and any total figure in "headline"/"title"): if it represents a combined/aggregate total across several items (e.g. "N stores/families... ₪X total"), and you are ALSO listing those same individual items in a block (ranked_list/comparison), ₪X MUST equal the literal sum of the individual item values you put in that block — actually add them up, don't estimate. A frequent real mistake is citing a bigger, rounder headline total (e.g. including borderline/excluded items) while the block only lists the narrower set that supports it — pick ONE consistent set of items and make every figure describing it agree exactly.`;

  const anomalyNote = dataAnomaly?.flagged
    ? (dataAnomaly.reason === 'all-zero'
        ? `\n\nAUTOMATED CHECK FLAGGED THIS RESULT: column(s) [${dataAnomaly.columns.join(', ')}] are exactly 0 on every row. Per the SANITY CHECK instruction above, this MUST be written up as a likely data/pipeline issue, not a confident business finding.`
        : `\n\nAUTOMATED CHECK FLAGGED THIS RESULT: column(s) [${dataAnomaly.columns.join(', ')}] show the exact same non-zero value on every single row — the same kind of JOIN/pipeline-gap smell as an all-zero column, just not zero. Per the SANITY CHECK instruction above, this MUST be written up as a likely data/pipeline issue, not a confident business finding.`)
    : '';
  // Set only on the regenerate retry after the separate VERIFY step (see
  // verifyInsight() below) rejected the first attempt — tells the model
  // exactly what it invented/contradicted last time instead of making it
  // guess what to fix.
  const verifierNote = verifierFeedback?.length
    ? `\n\nA PRIOR ATTEMPT AT THIS WRITE-UP WAS FACT-CHECKED AND REJECTED for: ${verifierFeedback.join('; ')}. Fix these specific problems this time — every number must be directly traceable to the result rows below, or (for a "scenarios" block only) an explicitly-labeled forward-looking projection.`
    : '';

  const userMessage = `Original investigation prompt: "${prompt}"
Category: ${category}
Data question asked: "${dataQuestion}"
SQL executed: ${sql}
Explanation: ${explanation}
Row count: ${rowCount}
Result rows (JSON, up to 30): ${JSON.stringify(sampleRows)}${anomalyNote}${verifierNote}`;

  // Up to 2 attempts: an LLM JSON round trip occasionally comes back
  // malformed or missing a required field. Same retry philosophy as
  // planQuestion() above and the QUERY step's own SQL retry — a single bad
  // response shouldn't kill the whole investigation, and a response with no
  // headline shouldn't silently ship a broken card either.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await llmService.sendOneShot(systemPrompt, userMessage, {
        model: MODEL, maxTokens: 2048, jsonOutput: true, context: 'insights_investigate_synthesize',
      });
      const parsed = parseJSON(response);
      if (!parsed.headline) throw new Error('Synthesize step returned no headline');
      return parsed;
    } catch (err) {
      lastErr = err;
      console.error(`   [synthesize attempt ${attempt}] failed: ${err.message}`);
    }
  }
  throw lastErr;
}

/**
 * Step 4, VERIFY — deliberately a SEPARATE LLM call from synthesizeInsight,
 * not another instruction bolted onto the same prompt. Asking one model call
 * to both "write a compelling finding" and "critically fact-check itself" in
 * the same breath is a conflict of incentives; a genuinely independent pass
 * — given only the raw rows and the finished insight's factual fields, none
 * of the reasoning that produced them — is a materially stronger check for
 * the specific failure mode detectSuspiciousResult() can't catch: a
 * plausible-looking number that was simply invented, not literally
 * duplicated everywhere the way a JOIN-bug artifact is.
 * @returns {Promise<{verified: boolean, issues: string[]}>}
 */
async function verifyInsight({ config, queryResult, synthesized }) {
  const { data, rowCount } = queryResult;
  const sampleRows = data.slice(0, 30);

  const systemPrompt = `You are a strict fact-checker reviewing a business-intelligence write-up for ${config.brandLabel} BEFORE it is shown to a user. You did not write it and have no stake in it sounding impressive — your only job is to catch numbers or claims that are NOT actually supported by the real query result rows provided.

Check specifically:
- Every concrete number in "headline", "title", and "impactValue", and inside "blocks" (chart points, ranked_list values, stat_callout value, comparison values), must be directly present in, or a simple direct aggregate (sum/count/avg/max/min/%) of, the provided rows. Reject a number that isn't.
- Exception: a "scenarios" block's "good"/"neutral"/"negative" values are ALLOWED to be plausible forward-looking projections, not literal row data — do not flag those alone for being projections.
- ARITHMETIC CHECK (do this explicitly, don't eyeball it): if "impactValue" (or a total inside "headline"/"title") claims a combined/aggregate figure across several items — e.g. "N stores/families... ₪X total" — and a block (ranked_list/comparison) lists those same individual items, ACTUALLY ADD UP the individual item values yourself and compare the sum to ₪X. Flag it as a real issue if they disagree beyond simple rounding — this is a common real bug: a bigger headline total that silently includes items the detail blocks don't, or excludes items they do.
- Internal consistency: if the same metric appears in two places (e.g. a stat_callout and the chart, or a number restated inside a "scenarios" description), the values must agree with each other.
- The finding must not overstate what a thin result actually shows (e.g. presenting 2 rows as a firm multi-point trend).

Respond with ONLY a JSON object:
{ "verified": true or false, "issues": ["short specific issue", ...] }
Set "verified": false only for a REAL problem (an invented/unsupported number, an internal contradiction, or a wildly overstated claim) — not for writing style or a clearly-labeled scenario projection. Empty "issues" array when verified is true.`;

  const userMessage = `Real query result rows (JSON, up to 30 of ${rowCount}): ${JSON.stringify(sampleRows)}

Insight to verify:
headline: ${synthesized.headline}
title: ${synthesized.title}
impactValue: ${synthesized.impactValue}
blocks: ${JSON.stringify(synthesized.blocks)}
chart: ${JSON.stringify(synthesized.chart)}`;

  try {
    const response = await llmService.sendOneShot(systemPrompt, userMessage, {
      model: MODEL, maxTokens: 512, jsonOutput: true, context: 'insights_investigate_verify',
    });
    const parsed = parseJSON(response);
    return { verified: parsed.verified !== false, issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5).map(String) : [] };
  } catch (err) {
    // The verifier itself failing (network hiccup, malformed JSON) should
    // never block or downgrade an otherwise-real insight — treat as "unable
    // to verify this time," not "verification failed."
    console.error(`   Verify step failed, not blocking on it: ${err.message}`);
    return { verified: true, issues: [] };
  }
}

function confidenceLabelFor(score) {
  if (score >= 85) return 'High';
  if (score >= 65) return 'Medium';
  return 'Low';
}

// Distinct hues for a genuine multi-series chart (3+ series — e.g. several
// product families' margin trends plotted together). The old logic gave
// series[0] the real category color and EVERY other series the exact same
// orange + dashed styling, so a 6-series chart rendered as "1 real line + 5
// identical indistinguishable dashed lines" — impossible to tell apart, per
// se the "хуй пойми что к чему относится" from Kosta.
const SERIES_PALETTE = ['#7C3AED', '#C026D3', '#E0752E', '#12996B', '#0EA5E9', '#F59E0B', '#DB2777', '#059669'];

function normalizeChart(raw, color, fallbackTitle) {
  const rawSeries = raw?.series || [];
  // Exactly 2 series is almost always "this vs. a comparison baseline"
  // (in-stock vs stockout, actual vs target) — keep that dedicated
  // primary-solid / secondary-dashed-orange treatment, it reads correctly
  // for a pair. 3+ series is a genuine multi-item comparison and needs a
  // real distinct color per item instead.
  const isPair = rawSeries.length === 2;
  return {
    title: raw?.title || fallbackTitle,
    unit: raw?.unit || '',
    categories: raw?.categories || [],
    series: rawSeries.map((s, i) => ({
      key: s.key || `s${i}`,
      label: s.label,
      color: isPair ? (i === 0 ? color : '#E0752E') : SERIES_PALETTE[i % SERIES_PALETTE.length],
      dashed: isPair && i > 0,
      points: s.points || [],
    })),
  };
}

const VALID_BLOCK_TYPES = ['chart', 'ranked_list', 'stat_callout', 'comparison', 'scenarios'];

/**
 * Normalizes the LLM's freely-chosen block list into the shape the frontend
 * renders — this is the part that makes the detail page dynamic per
 * question instead of one fixed template (chart + 4 scenario boxes) every
 * time, per Kosta's explicit request.
 */
function normalizeBlocks(rawBlocks, color, fallbackTitle) {
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) return [];
  return rawBlocks
    .filter(b => b && VALID_BLOCK_TYPES.includes(b.type))
    .slice(0, 3)
    .map(b => {
      if (b.type === 'chart') return { type: 'chart', chart: normalizeChart(b, color, fallbackTitle) };
      if (b.type === 'ranked_list') {
        return {
          type: 'ranked_list',
          title: b.title || fallbackTitle,
          unit: b.unit || '',
          items: (b.items || []).slice(0, 10).map(it => ({
            label: it.label || '',
            value: it.value ?? '',
            pct: Math.max(0, Math.min(100, Number(it.pct) || 0)),
          })),
        };
      }
      if (b.type === 'stat_callout') {
        return { type: 'stat_callout', value: b.value ?? '', label: b.label || '', description: b.description || '' };
      }
      if (b.type === 'comparison') {
        return {
          type: 'comparison',
          items: (b.items || []).slice(0, 3).map(it => ({
            label: it.label || '',
            value: it.value ?? '',
            sub: it.sub || '',
            direction: ['positive', 'negative', 'neutral'].includes(it.direction) ? it.direction : 'neutral',
          })),
        };
      }
      // scenarios
      return { type: 'scenarios', items: b.items || [] };
    });
}

/**
 * Picks a fresh investigation angle without the user typing one — this is
 * what "Request a new insight" runs. Genuinely decided by the model from the
 * real data model and what's already been found, NOT a hardcoded rotation of
 * topics: every already-generated insight's actual data question is listed
 * so the model is pushed to find a real gap rather than repeat one.
 *
 * Takes `userId` (fixed 2026-08-07: this previously called listGenerated()
 * with only datasetId, silently omitting userId — since listGenerated keys
 * strictly on datasetId+userId, "existing" was ALWAYS an empty list, so the
 * "don't repeat what's already been found" instruction below had nothing to
 * compare against and never actually worked. Caught while migrating this
 * file's persistence to Postgres.)
 */
async function proposeInvestigationPrompt(datasetId, userId, config) {
  const existing = await listGenerated(datasetId, userId);
  const covered = existing.length
    ? existing.map(i => `- [${i.category}] ${i.evidence?.dataQuestion || i.headline}`).join('\n')
    : '(nothing investigated yet — pick any strong angle)';

  const systemPrompt = `You are Aspect, an AI that proactively investigates ${config.brandLabel}'s data and finds business insights on its own, without being asked a specific question. The data available: ${config.dataModelDescription}

Propose ONE new investigation to run next — something a sharp analyst would genuinely want to know, phrased as a business question (not SQL, not generic filler like "analyze sales"). It must be meaningfully different from everything already investigated below: a different measure, dimension, or angle — not a rephrasing of an existing one.

Already investigated:
${covered}

Respond with ONLY a JSON object: { "prompt": "the new investigation request, one sentence, phrased the way a business user would ask it" }`;

  const response = await llmService.sendOneShot(systemPrompt, 'Propose the next investigation.', {
    model: MODEL, maxTokens: 256, jsonOutput: true, context: 'insights_investigate_propose',
  });
  const parsed = parseJSON(response);
  if (!parsed.prompt) throw new Error('Propose step returned no prompt');
  return parsed.prompt;
}

/**
 * Runs the full plan -> query -> synthesize pipeline and stores the result.
 * `prompt` is optional — when omitted (the "Request a new insight" card, no
 * text box involved), proposeInvestigationPrompt() picks the angle instead.
 * @returns {Promise<Object>} the new InsightDetail-shaped record (with id)
 */
async function investigate(datasetId, userId, prompt) {
  const entry = getDatasetEntry(datasetId);
  const config = await intelligenceConfigService.getConfig(datasetId);
  if (!config.enabled) {
    const err = new Error(`Aspect Intelligence is not enabled for dataset: ${datasetId}`);
    err.status = 404;
    throw err;
  }

  // Captured before actualPrompt overwrites an empty prompt with Aspect's own
  // proposed angle — the History page needs to tell "I asked this" apart
  // from "Aspect suggested this on its own" (design turn 12a: "my report" vs
  // "proposed" tag), which the fallback logic below would otherwise erase.
  const origin = prompt && prompt.trim() ? 'user' : 'proposed';
  const actualPrompt = prompt && prompt.trim() ? prompt.trim() : await proposeInvestigationPrompt(datasetId, userId, config);

  const { category, dataQuestion } = await planQuestion(datasetId, config, actualPrompt);

  const queryResult = await getDataQueryService(datasetId).queryByQuestion(dataQuestion, entry.schemaName, {
    llmAgentName: 'Aspect Intelligence',
  });
  if (queryResult.error) {
    throw new Error(`Data query failed: ${queryResult.message}`);
  }

  const dataAnomaly = detectSuspiciousResult(queryResult.data);

  let synthesized = await synthesizeInsight({ datasetId, config, prompt: actualPrompt, category, dataQuestion, queryResult, dataAnomaly });

  // Step 4, VERIFY: an independent LLM pass fact-checks step 3's own output
  // against the real rows (see verifyInsight() doc comment for why this is a
  // separate call rather than more instructions in the same prompt). One
  // regenerate-and-recheck retry, feeding the verifier's specific complaint
  // back in — most rejections are a single invented number and self-correct
  // immediately once named explicitly, the same way the QUERY step's SQL
  // retry already works.
  let verification = await verifyInsight({ config, queryResult, synthesized });
  if (!verification.verified) {
    console.log(`   Verify rejected first synthesis attempt, regenerating once: ${verification.issues.join('; ')}`);
    synthesized = await synthesizeInsight({ datasetId, config, prompt: actualPrompt, category, dataQuestion, queryResult, dataAnomaly, verifierFeedback: verification.issues });
    verification = await verifyInsight({ config, queryResult, synthesized });
  }

  // Hard enforcement, not just a prompt hint: cap confidence and mark the tag
  // even if the model's own self-check (see synthesizeInsight's system
  // prompt) didn't kick in for this particular response, AND even if the
  // independent verify pass above still isn't satisfied after the retry. A
  // failed verification downgrades rather than discards — the query itself
  // was real, only the write-up over-claimed, so a real (if less confident)
  // insight is still more useful than nothing per the no-canned-fallback
  // stance (see project memory, Round 4).
  let confidence = Math.max(0, Math.min(100, Math.round(synthesized.confidence ?? 70)));
  let tag = synthesized.tag || category.toUpperCase();
  let confidenceChecks = synthesized.confidenceChecks || [];
  if (dataAnomaly.flagged) {
    confidence = Math.min(confidence, 40);
    if (!/data quality/i.test(tag)) tag = 'DATA QUALITY';
  }
  if (!verification.verified) {
    confidence = Math.min(confidence, 40);
    if (!/data quality/i.test(tag)) tag = 'DATA QUALITY';
    confidenceChecks = [
      { positive: false, text: `Automated verification flagged: ${verification.issues.join('; ') || 'unsupported figures'}` },
      ...confidenceChecks,
    ];
  }
  const color = CATEGORY_COLOR[category];
  const chart = normalizeChart(synthesized.chart, color, dataQuestion.toUpperCase());
  let blocks = normalizeBlocks(synthesized.blocks, color, dataQuestion.toUpperCase());
  // Safety net, not the normal path: if the model returned no usable blocks,
  // fall back to the one thing we always have — the card-preview chart —
  // rather than shipping an empty detail page.
  if (blocks.length === 0) blocks = [{ type: 'chart', chart }];
  const insight = {
    id: `investigate-${Date.now()}`,
    category,
    categoryLabel: synthesized.categoryLabel || category,
    tag,
    confidence,
    confidenceLabel: confidenceLabelFor(confidence),
    foundAgo: 'just now',
    isGenerated: true,
    createdAt: Date.now(),
    origin,
    // Flips to true the first time the detail page is opened — see
    // markViewed(), called from the GET /:datasetId/:insightId route.
    viewed: false,
    // Toggled from the detail page's "Track" button — see setTracked/listTracked below.
    // This is the ONLY source of "Tracked by you" content now: no separate
    // auto-computed metric set, so the strip is genuinely user-curated.
    tracked: false,
    headline: synthesized.headline,
    title: synthesized.title || synthesized.headline,
    breadcrumbLabel: synthesized.breadcrumbLabel || synthesized.headline?.slice(0, 40),
    impactValue: synthesized.impactValue,
    impactLabel: synthesized.impactLabel,
    impactDirection: synthesized.impactDirection || 'neutral',
    ctaLabel: synthesized.ctaLabel || 'action plan',
    // Small, fixed preview chart for the list-view card only — separate from
    // "blocks" below, which is what the detail page actually renders.
    chart,
    sourceNote: synthesized.sourceNote || `Source: facts table · ${queryResult.rowCount} rows`,
    // The detail page's actual content — 1-3 blocks the model chose from a
    // palette (chart/ranked_list/stat_callout/comparison/scenarios) based on
    // what best presents THIS finding, not a fixed template every time.
    blocks,
    reasoning: synthesized.reasoning || [],
    confidenceScore: confidence,
    confidenceChecks,
    confidenceBasis: synthesized.confidenceBasis || '',
    // Real evidence backing this insight — rendered by "View SQL queries" on
    // the detail page, so investors/Kosta can verify the pipeline actually
    // ran a real query rather than fabricating numbers. `verification`
    // records the independent VERIFY pass's own verdict for the same reason
    // — proof the write-up was itself checked, not just the query.
    evidence: {
      prompt: actualPrompt,
      dataQuestion,
      sql: queryResult.sql,
      verification: { verified: verification.verified, issues: verification.issues },
    },
  };

  await store.insert(datasetId, userId, insight);

  return insight;
}

/**
 * Runs the dataset's curated prompt set (config.bootstrapPrompts — see
 * insights/datasets/registry.js for defaults, admin-editable via
 * intelligence-config.service.js) sequentially — not in parallel, since each
 * one is already 4+ LLM/DB round trips (plan/query/synthesize/verify, see
 * investigate() above) and running them concurrently would multiply load for
 * no benefit — and returns whichever succeeded. Failures are logged and
 * skipped, never thrown: this is a best-effort populate, not a user-facing
 * action that should fail loudly.
 */
async function bootstrap(datasetId) {
  const config = await intelligenceConfigService.getConfig(datasetId);
  if (!config) throw new Error(`Unknown dataset: ${datasetId}`);
  const results = [];
  for (const prompt of config.bootstrapPrompts) {
    try {
      const insight = await investigate(datasetId, BOOTSTRAP_USER_ID, prompt);
      results.push(insight);
    } catch (err) {
      console.error(`❌ Bootstrap prompt failed, skipping: "${prompt}" — ${err.message}`);
    }
  }
  return results;
}

function listGenerated(datasetId, userId) {
  return store.listByUser(datasetId, userId);
}

/**
 * Admin-only, cross-user: every generated insight for this dataset
 * regardless of which anonymous session created it — used by the admin
 * dataset overview/monitoring pages (insights-admin.routes.js), which need a
 * dataset-wide count/list, not one user's private view.
 */
function listGeneratedAll(datasetId) {
  return store.listAll(datasetId);
}

function getGeneratedById(datasetId, userId, insightId) {
  return store.getById(datasetId, userId, insightId);
}

/** Admin-only, cross-user version of deleteGenerated. @returns {Promise<boolean>} true if an insight with this id existed and was removed */
function deleteGeneratedAny(datasetId, insightId) {
  return store.removeAny(datasetId, insightId);
}

/** Admin-only, cross-user version of setTracked. @returns {Promise<Object|null>} the updated insight, or null if unknown */
function setTrackedAny(datasetId, insightId, tracked) {
  return store.updateInsightAny(datasetId, insightId, insight => {
    insight.tracked = !!tracked;
    if (insight.tracked) insight.trackedOrder = Date.now();
  });
}

/** @returns {Promise<boolean>} true if an insight with this id existed and was removed */
function deleteGenerated(datasetId, userId, insightId) {
  return store.remove(datasetId, userId, insightId);
}

/**
 * Marks a report as opened — drives the History page's "Ready — not viewed
 * yet" highlight (design turn 12a).
 */
async function markViewed(datasetId, userId, insightId) {
  await store.updateInsight(datasetId, userId, insightId, insight => { insight.viewed = true; });
}

/**
 * Generates the "Open <plan>" action plan for an insight (e.g. "Open margin
 * plan") — was a dead button with nothing behind it. Grounded ONLY in that
 * insight's own already-computed fields (headline, category, blocks,
 * reasoning) — no new SQL query, since every number needed to recommend
 * concrete next steps was already established when the insight was found.
 * Cached on the insight after the first call so reopening the modal doesn't
 * re-run the LLM every time.
 * @returns {Promise<Object|null>} the plan, or null if no such insight exists
 */
async function generateActionPlan(datasetId, userId, insightId) {
  const insight = await store.getById(datasetId, userId, insightId);
  if (!insight) return null;
  if (insight.actionPlan) return insight.actionPlan;

  const config = await intelligenceConfigService.getConfig(datasetId);
  const systemPrompt = `You are Aspect, an AI that helps ${config.brandLabel} act on business insights it already found. You are NOT running a new query — you already have this finding, fully computed. Write a concrete, specific action plan a store/category manager could actually execute this week, grounded ONLY in the numbers already present below. Do not invent any new figure that isn't already stated.

Respond with ONLY a JSON object:
{
  "planTitle": "short plan name, e.g. \\"Margin Recovery Plan\\"",
  "steps": [
    { "title": "short imperative step name, e.g. \\"Renegotiate supplier cost\\"", "detail": "1-2 sentences, concrete and specific to this finding, referencing its real numbers" }
  ],
  "expectedImpact": "one sentence tying the plan back to this insight's own impact figure"
}
3 to 5 steps, ordered by priority (highest-impact / most urgent first).`;

  const userMessage = `Insight: "${insight.headline}"
Category: ${insight.categoryLabel}
Impact: ${insight.impactValue} (${insight.impactLabel})
Supporting detail blocks: ${JSON.stringify(insight.blocks)}
How it was found: ${JSON.stringify(insight.reasoning)}`;

  const response = await llmService.sendOneShot(systemPrompt, userMessage, {
    model: MODEL, maxTokens: 1024, jsonOutput: true, context: 'insights_action_plan',
  });
  const parsed = parseJSON(response);
  const plan = {
    planTitle: parsed.planTitle || `${insight.ctaLabel || 'Action'} plan`,
    steps: (parsed.steps || []).slice(0, 5).map(s => ({ title: s.title || '', detail: s.detail || '' })),
    expectedImpact: parsed.expectedImpact || '',
  };

  await store.updateInsight(datasetId, userId, insightId, i => { i.actionPlan = plan; });
  return plan;
}

// Calendar-shaped category labels (months, quarters, week numbers, bare
// years) — a single-series chart plotted against these is a genuine TIME
// TREND, never a ranking, regardless of point count.
const TIME_CATEGORY_PATTERN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|w(eek)?\s?\d{1,2}|\d{4})/i;
function looksLikeTimeSeries(categories) {
  return categories.length > 0 && categories.every(c => TIME_CATEGORY_PATTERN.test(String(c).trim()));
}

/**
 * Turns a tracked insight into a "Tracked by you" strip card — reuses the
 * insight's own card-preview chart (same one InsightCard shows) rather than
 * a separately computed metric, so what you tracked is literally what you
 * see, just condensed.
 */
function toTrackedMetric(insight) {
  const series = insight.chart?.series || [];
  const categories = insight.chart?.categories || [];
  const points = series[0]?.points || [];
  // More than 2 points on a single series COULD be a RANKED SNAPSHOT across
  // different entities (e.g. "top 8 product families by revenue") rather
  // than a value sampled over time — those categories are typically sorted
  // by rank, so "first point vs last point" would really be "leader vs last
  // place," trivially a huge, meaningless "decline" every time. But it could
  // just as easily be a genuine multi-month trend (categories = "Feb", "Mar",
  // "Apr"...), which has the exact same shape (1 series, >2 points) and was
  // being misclassified as a ranking by point-count alone — caught live on a
  // real 6-month margin-trend insight showing a nonsense "Leader: Jun" label
  // instead of its real declining trend. looksLikeTimeSeries() checks the
  // actual category labels first; only genuinely non-calendar categories
  // (store/product/family names) fall through to the ranking treatment.
  const isRanking = points.length > 2 && series.length === 1 && !looksLikeTimeSeries(categories);

  let trendDir = 'flat', trendLabel = '— flat';
  if (isRanking) {
    const maxIdx = points.indexOf(Math.max(...points));
    trendLabel = categories[maxIdx] ? `Leader: ${categories[maxIdx]}`.slice(0, 40) : 'Ranked';
  } else if (points.length >= 2) {
    const first = points[0], last = points[points.length - 1];
    if (first !== 0) {
      const pct = ((last - first) / Math.abs(first)) * 100;
      if (Math.abs(pct) >= 1) {
        trendDir = pct > 0 ? 'up' : 'down';
        trendLabel = `${trendDir === 'up' ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%`;
      }
    }
  }
  return {
    id: insight.id,
    label: insight.breadcrumbLabel || insight.headline,
    value: insight.impactValue,
    sub: insight.categoryLabel,
    trendDir,
    trendLabel,
    points,
    isRanking,
  };
}

async function listTracked(datasetId, userId) {
  const tracked = await store.listTracked(datasetId, userId);
  return tracked.map(toTrackedMetric);
}

/** @returns {Promise<Object|null>} the updated insight, or null if no insight with this id exists */
function setTracked(datasetId, userId, insightId, tracked) {
  return store.updateInsight(datasetId, userId, insightId, insight => {
    insight.tracked = !!tracked;
    // Newly tracked items go to the end of the manage-tracking order — reuse
    // Date.now() as a simple monotonically-increasing value, same pattern
    // already used for insight ids themselves elsewhere in this file.
    if (insight.tracked) insight.trackedOrder = Date.now();
  });
}

/**
 * "Manage tracking" drag-to-reorder — the client sends the full new order as
 * a list of insight ids; server reassigns sequential trackedOrder values (0,
 * 1, 2...) rather than trying to diff/insert, since the client always has
 * the complete ordered list already (it's the one rendering the drag UI).
 * @returns {Promise<Object[]>} the reordered tracked metrics, same shape as listTracked
 */
async function reorderTracked(datasetId, userId, insightIds) {
  await store.reorderTracked(datasetId, userId, insightIds);
  return listTracked(datasetId, userId);
}

module.exports = {
  investigate, listGenerated, listGeneratedAll, getGeneratedById, deleteGenerated, deleteGeneratedAny,
  setTrackedAny, markViewed, bootstrap, listTracked, setTracked, reorderTracked, generateActionPlan,
  classifyPrompt, setDataReloadService,
  // Exported purely so scripts/test-insights-unit.js can exercise this
  // pure, DB/LLM-free logic directly as real regression tests (see the
  // 2026-08-07 bugs each of these was fixed for) — not part of the public
  // API surface any route calls into.
  detectSuspiciousResult, looksLikeTimeSeries,
};
