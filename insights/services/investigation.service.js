/**
 * Real "Aspect investigates your data" pipeline for the Insights "investigate"
 * box — replaces the old canned/fixed response (POST /investigate used to
 * always return the same 4 seed insight ids regardless of the prompt).
 *
 * Three LLM/DB round trips, reusing the exact same engine the real chat uses
 * for `fetch_hypertoy_data` (DataQueryService -> sql-generator.service ->
 * schema-descriptor.service), so the generated SQL is subject to the same
 * safety validation and anti-pattern learning as every other query on this
 * dataset — nothing insight-specific was bypassed:
 *
 *   1. PLAN    — turn the free-text investigation prompt ("Main risks for
 *      the next 6 months") into one concrete, SQL-answerable data question
 *      plus a category classification.
 *   2. QUERY   — run that question through the real NL->SQL pipeline against
 *      the actual hypertoy database and get real result rows back.
 *   3. SYNTHESIZE — feed the real rows (not the plan, not a guess) back to
 *      the model and ask it to write the full insight (headline, scenarios,
 *      reasoning trail, confidence) grounded only in those numbers.
 *
 * Generated insights are the ONLY insight content this API serves now (the
 * old hypertoy.seed.js illustrative INSIGHTS/TRACKED arrays are gone —
 * Kosta was explicit that seed/fake content must not remain once the real
 * pipeline exists). Kept in-memory per dataset (module-level Map) and
 * persisted to a JSON file so a server restart before the demo doesn't wipe
 * everything that's been generated so far.
 */
const fs = require('fs');
const path = require('path');
const llmService = require('../../services/llm');
const { DataQueryService } = require('../../services/data-query.service');
const { getPool } = require('../../services/db.hypertoy');

const MODEL = 'claude-sonnet-4-6';
const CATEGORY_COLOR = {
  'cross-sell': '#C026D3',
  margin: '#C2410C',
  inventory: '#7C3AED',
  trend: '#7C3AED',
  risk: '#C2410C',
};
const VALID_CATEGORIES = Object.keys(CATEGORY_COLOR);

// Shared with planQuestion() and proposeInvestigationPrompt() — one
// description of what's actually queryable, not two hand-maintained copies
// that could drift apart.
const DATA_MODEL_DESCRIPTION = `a facts table with sales, inventory, and target rows (record types), joined to products, stores/warehouses, and customers. Common measures: revenue (ex VAT), profit, margin %, units sold, target attainment %, inventory value/units, loyalty signups. Common dimensions: store, region, branch, product, product family, date (day/week/month/quarter), cashier, campaign, customer city.`;

const PERSIST_PATH = path.join(__dirname, '..', 'data', 'generated-insights.json');

// datasetId -> InsightDetail[], newest first.
const generated = new Map();

// Insights persisted before the dynamic-blocks change (see
// project_aspect_intelligence_blocks in memory) have `chart`/`scenarios` at
// the top level but no `blocks` array — reconstruct one on load so old
// insights still render instead of showing an empty detail page.
function migrateLegacyBlocks(insight) {
  let next = insight;
  if (!next.blocks || next.blocks.length === 0) {
    const blocks = [];
    if (next.chart) blocks.push({ type: 'chart', chart: next.chart });
    if (next.scenarios && next.scenarios.length > 0) blocks.push({ type: 'scenarios', items: next.scenarios });
    next = { ...next, blocks };
  }
  if (typeof next.tracked !== 'boolean') next = { ...next, tracked: false };
  // Re-derive chart colors for insights persisted before the 3+-series
  // color fix (every series past the first used to collapse onto the same
  // dashed orange) — normalizeChart is deterministic/idempotent, so this is
  // a no-op for charts that were already correct (2-series pairs).
  const primaryColor = CATEGORY_COLOR[next.category] || '#7C3AED';
  if (next.chart) next = { ...next, chart: normalizeChart(next.chart, primaryColor, next.chart.title) };
  if (next.blocks?.length) {
    next = {
      ...next,
      blocks: next.blocks.map(b => b.type === 'chart' ? { ...b, chart: normalizeChart(b.chart, primaryColor, b.chart.title) } : b),
    };
  }
  return next;
}

function loadPersisted() {
  try {
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [datasetId, list] of Object.entries(parsed)) generated.set(datasetId, list.map(migrateLegacyBlocks));
    console.log(`📄 Loaded ${[...generated.values()].flat().length} persisted generated insight(s)`);
    persist(); // save the migration result so it doesn't need to re-run every load
  } catch {
    // No file yet, or unreadable — start empty, which is fine.
  }
}

function persist() {
  try {
    const obj = Object.fromEntries(generated.entries());
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error(`❌ Failed to persist generated insights: ${err.message}`);
  }
}

let dataQueryService = null;
function getDataQueryService() {
  if (!dataQueryService) dataQueryService = new DataQueryService(getPool());
  return dataQueryService;
}

// Real "today" for this dataset, cached after the first lookup — without
// this, the model has no idea what year the business is actually in and
// falls back to guessing from its own training era (caught writing "as of
// Q3 2024" in a headline when the data is really anchored around mid-2026).
// Same MAX(transaction_date) pattern zer4u's crew already uses for its own
// "data last updated" banner, so this always agrees with reality rather
// than a hardcoded/stale guess.
let cachedDataThrough = null;
async function getDataThroughDate() {
  if (cachedDataThrough) return cachedDataThrough;
  try {
    const r = await getPool().query(
      `SELECT TO_CHAR(MAX("transaction_date"), 'YYYY-MM-DD') AS d FROM hypertoy.facts WHERE "record_type" = 'מכירות'`
    );
    cachedDataThrough = r.rows[0]?.d || null;
  } catch {
    cachedDataThrough = null;
  }
  return cachedDataThrough;
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

async function planQuestion(prompt) {
  const dataThrough = await getDataThroughDate();
  const systemPrompt = `You are planning a proactive business-intelligence investigation for Hyper Toy, a toy retail chain. You will be given an open-ended investigation prompt (like "Main risks for the next 6 months" or "Bundle opportunities hiding in baskets"). Your job is NOT to answer it yet — it is to turn it into exactly ONE concrete, specific, SQL-answerable data question that a text-to-SQL engine could run against a single database table to gather the evidence needed.

${dataThrough ? `The data runs through ${dataThrough} — treat that as "now" for anything relative ("recent," "this quarter," "next 6 months"). Do not assume any other year.\n\n` : ''}The data available: ${DATA_MODEL_DESCRIPTION}

Respond with ONLY a JSON object:
{
  "category": one of "cross-sell" | "margin" | "inventory" | "trend" | "risk",
  "dataQuestion": "a single, specific, concrete question in English that can be answered with one SQL aggregate query — mention the measure(s), a breakdown dimension if useful (e.g. by store, by product family, by week), and a time window"
}

Pick the category that best matches what the investigation prompt is actually about. Do not hedge or ask a follow-up question — commit to one specific, well-scoped data question.`;

  const response = await llmService.sendOneShot(systemPrompt, `Investigation prompt: "${prompt}"`, {
    model: MODEL, maxTokens: 512, jsonOutput: true, context: 'insights_investigate_plan',
  });
  const parsed = parseJSON(response);
  if (!parsed.dataQuestion) throw new Error('Plan step returned no dataQuestion');
  const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'trend';
  return { category, dataQuestion: parsed.dataQuestion };
}

async function synthesizeInsight({ prompt, category, dataQuestion, queryResult }) {
  const { sql, explanation, data, rowCount } = queryResult;
  // Cap what we feed back — enough rows to see the shape/pattern, not the whole table.
  const sampleRows = data.slice(0, 30);
  const dataThrough = await getDataThroughDate();

  const systemPrompt = `You are Aspect, an AI that proactively investigates a toy retailer's (Hyper Toy) data and writes up findings for a business audience. You already ran a real SQL query and have the real result rows below — write the insight using ONLY these numbers. Do not invent any figure that isn't directly computable from the provided rows.

${dataThrough ? `The data runs through ${dataThrough} — that is "now." When your headline/title/description says something like "as of," "currently," "this quarter," or names a year, it MUST be consistent with that real date, not a guess from any other year.\n` : ''}

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

The top-level "chart" field is separate from "blocks" — it's always a small, simple preview used only on the insight's list-view card, so still fill it in even if you don't choose a "chart" block for the detail page. Inside "blocks", the only place you may reason beyond the literal query result is a "scenarios" block's good/neutral/negative values (forward-looking projections — keep them plausible and proportionate to the real current figure). Every other field, in every block, must trace back to the actual data provided.`;

  const userMessage = `Original investigation prompt: "${prompt}"
Category: ${category}
Data question asked: "${dataQuestion}"
SQL executed: ${sql}
Explanation: ${explanation}
Row count: ${rowCount}
Result rows (JSON, up to 30): ${JSON.stringify(sampleRows)}`;

  const response = await llmService.sendOneShot(systemPrompt, userMessage, {
    model: MODEL, maxTokens: 2048, jsonOutput: true, context: 'insights_investigate_synthesize',
  });
  return parseJSON(response);
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
 */
async function proposeInvestigationPrompt(datasetId) {
  const existing = listGenerated(datasetId);
  const covered = existing.length
    ? existing.map(i => `- [${i.category}] ${i.evidence?.dataQuestion || i.headline}`).join('\n')
    : '(nothing investigated yet — pick any strong angle)';

  const systemPrompt = `You are Aspect, an AI that proactively investigates a toy retailer's (Hyper Toy) data and finds business insights on its own, without being asked a specific question. The data available: ${DATA_MODEL_DESCRIPTION}

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
async function investigate(datasetId, prompt) {
  if (datasetId !== 'hypertoy') {
    throw new Error(`Real investigation is not wired up for dataset: ${datasetId}`);
  }

  const actualPrompt = prompt && prompt.trim() ? prompt.trim() : await proposeInvestigationPrompt(datasetId);

  const { category, dataQuestion } = await planQuestion(actualPrompt);

  const queryResult = await getDataQueryService().queryByQuestion(dataQuestion, 'hypertoy', {
    llmAgentName: 'Aspect Intelligence',
  });
  if (queryResult.error) {
    throw new Error(`Data query failed: ${queryResult.message}`);
  }

  const synthesized = await synthesizeInsight({ prompt: actualPrompt, category, dataQuestion, queryResult });

  const confidence = Math.max(0, Math.min(100, Math.round(synthesized.confidence ?? 70)));
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
    tag: synthesized.tag || category.toUpperCase(),
    confidence,
    confidenceLabel: confidenceLabelFor(confidence),
    foundAgo: 'just now',
    isGenerated: true,
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
    confidenceChecks: synthesized.confidenceChecks || [],
    confidenceBasis: synthesized.confidenceBasis || '',
    // Real evidence backing this insight — rendered by "View SQL queries" on
    // the detail page, so investors/Kosta can verify the pipeline actually
    // ran a real query rather than fabricating numbers.
    evidence: { prompt: actualPrompt, dataQuestion, sql: queryResult.sql },
  };

  const list = generated.get(datasetId) || [];
  list.unshift(insight);
  generated.set(datasetId, list);
  persist();

  return insight;
}

// Curated, known-workable prompts to populate the feed with real content the
// first time (or whenever asked) instead of leaving it empty — these are the
// same category angles the old seed content illustrated, now actually
// computed. Basket-affinity/cross-sell is deliberately excluded: it needs a
// self-join across ~2M rows with no supporting index and reliably times out
// (see [[project_aspect_intelligence_real_investigate]] in memory) — a real
// measure/materialized view would be needed before it belongs here.
const BOOTSTRAP_PROMPTS = [
  'Which stores are furthest behind their sales target this quarter, and why',
  'Which product family has the steepest margin decline recently',
  'Which SKUs are tying up the most inventory value with the slowest sell-through',
  'What is the loyalty signup trend over the last several weeks, and what is driving it',
];

/**
 * Runs the curated prompt set sequentially (not in parallel — each one is
 * already 3 LLM/DB round trips, running them concurrently would multiply
 * load for no benefit) and returns whichever succeeded. Failures are logged
 * and skipped, never thrown — this is a best-effort populate, not a
 * user-facing action that should fail loudly.
 */
async function bootstrap(datasetId) {
  const results = [];
  for (const prompt of BOOTSTRAP_PROMPTS) {
    try {
      const insight = await investigate(datasetId, prompt);
      results.push(insight);
    } catch (err) {
      console.error(`❌ Bootstrap prompt failed, skipping: "${prompt}" — ${err.message}`);
    }
  }
  return results;
}

function listGenerated(datasetId) {
  return generated.get(datasetId) || [];
}

function getGeneratedById(datasetId, insightId) {
  return listGenerated(datasetId).find(i => i.id === insightId) || null;
}

/** @returns {boolean} true if an insight with this id existed and was removed */
function deleteGenerated(datasetId, insightId) {
  const list = generated.get(datasetId);
  if (!list) return false;
  const next = list.filter(i => i.id !== insightId);
  const removed = next.length !== list.length;
  generated.set(datasetId, next);
  if (removed) persist();
  return removed;
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
async function generateActionPlan(datasetId, insightId) {
  const insight = getGeneratedById(datasetId, insightId);
  if (!insight) return null;
  if (insight.actionPlan) return insight.actionPlan;

  const systemPrompt = `You are Aspect, an AI that helps a toy retailer (Hyper Toy) act on business insights it already found. You are NOT running a new query — you already have this finding, fully computed. Write a concrete, specific action plan a store/category manager could actually execute this week, grounded ONLY in the numbers already present below. Do not invent any new figure that isn't already stated.

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

  insight.actionPlan = plan;
  persist();
  return plan;
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
  // More than 2 points on a single series is a RANKED SNAPSHOT across
  // different entities (e.g. "top 8 product families by revenue"), not a
  // value sampled over time. Those categories are typically sorted by rank,
  // so "first point vs last point" is really "leader vs last place" —
  // trivially a huge, meaningless "decline" every time, regardless of any
  // actual trend. Only a genuine 2-point pair (this-vs-that, before-vs-after)
  // is honest to render as a rise/fall percentage.
  const isRanking = points.length > 2 && series.length === 1;

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

function listTracked(datasetId) {
  // trackedOrder is only ever set when an insight gets tracked (or
  // explicitly reordered) — older, already-tracked insights predating this
  // field just sort first (undefined treated as -Infinity-ish via ?? 0
  // being smaller than any real Date.now()-based value), which is a
  // harmless one-time default, not a bug to special-case.
  return listGenerated(datasetId)
    .filter(i => i.tracked)
    .sort((a, b) => (a.trackedOrder ?? 0) - (b.trackedOrder ?? 0))
    .map(toTrackedMetric);
}

/** @returns {Object|null} the updated insight, or null if no insight with this id exists */
function setTracked(datasetId, insightId, tracked) {
  const list = generated.get(datasetId);
  if (!list) return null;
  const insight = list.find(i => i.id === insightId);
  if (!insight) return null;
  insight.tracked = !!tracked;
  // Newly tracked items go to the end of the manage-tracking order — reuse
  // Date.now() as a simple monotonically-increasing value, same pattern
  // already used for insight ids themselves elsewhere in this file.
  if (insight.tracked) insight.trackedOrder = Date.now();
  persist();
  return insight;
}

/**
 * "Manage tracking" drag-to-reorder — the client sends the full new order as
 * a list of insight ids; server reassigns sequential trackedOrder values (0,
 * 1, 2...) rather than trying to diff/insert, since the client always has
 * the complete ordered list already (it's the one rendering the drag UI).
 * @returns {Object[]} the reordered tracked metrics, same shape as listTracked
 */
function reorderTracked(datasetId, insightIds) {
  const list = generated.get(datasetId);
  if (!list) return [];
  insightIds.forEach((id, index) => {
    const insight = list.find(i => i.id === id && i.tracked);
    if (insight) insight.trackedOrder = index;
  });
  persist();
  return listTracked(datasetId);
}

// Called down here, not right after the function declaration above: it
// transitively calls normalizeChart() via migrateLegacyBlocks(), which
// closes over SERIES_PALETTE — a `const` declared later in this file. `const`
// isn't hoisted the way function declarations are, so calling this before
// that line runs threw "Cannot access 'SERIES_PALETTE' before initialization"
// and silently discarded every persisted insight (loadPersisted's catch
// swallowed it).
loadPersisted();

module.exports = { investigate, listGenerated, getGeneratedById, deleteGenerated, bootstrap, listTracked, setTracked, reorderTracked, generateActionPlan, classifyPrompt };
