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
const dataThroughService = require('../../services/data-through.service');
const intelligenceConfigService = require('./intelligence-config.service');
const store = require('./insights-store.service');
const { buildResultDigest, formatForPrompt, SAMPLE_LIMIT } = require('./result-digest.service');
const progress = require('./investigation-progress.service');
const measureBaseline = require('./measure-baseline.service');

const MODEL = 'claude-sonnet-4-6';

/** Statement timeout for investigation queries — see the call site in investigate() for why this is far above the chat default. */
const INSIGHTS_QUERY_TIMEOUT_MS = parseInt(process.env.INSIGHTS_QUERY_TIMEOUT_MS || '75000', 10);

/** Safe wrapper — a missing digest must never blank out the prompt section that tells the model where its numbers come from. */
function digestText(digest) {
  return digest ? formatForPrompt(digest) : 'AUTHORITATIVE AGGREGATES: unavailable for this result.';
}
const CATEGORY_COLOR = {
  'cross-sell': '#C026D3',
  margin: '#C2410C',
  inventory: '#7C3AED',
  trend: '#7C3AED',
  risk: '#C2410C',
  // Only offered to PLAN when the Smart Replenishment module is live for the
  // dataset — see the prompt assembly below.
  replenishment: '#0E7490',
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
// datasetId -> { value, at }. TTL'd, and a FAILED lookup is never cached:
// previously this Map stored whatever the first call produced, forever. Two
// real consequences on a long-lived Cloud Run instance: (1) one early failure
// — the reload service not yet wired at startup, or a transient DB blip —
// cached `null` for the life of the process, so every insight it produced
// afterwards had no "now" anchor and the model went back to dating findings
// from its own training era; (2) after a data reload the anchor stayed stale
// indefinitely, so "this quarter" silently meant the previous load's quarter.
const cachedDataThrough = new Map();
const DATA_THROUGH_TTL_MS = 10 * 60 * 1000;
async function getDataThroughDate(datasetId) {
  const hit = cachedDataThrough.get(datasetId);
  if (hit && (Date.now() - hit.at) < DATA_THROUGH_TTL_MS) return hit.value;
  let value = null;
  try {
    const schemaName = getDatasetEntry(datasetId).schemaName;
    const info = dataReloadServiceRef ? await dataReloadServiceRef.getDataInfo(schemaName) : null;
    value = info?.lastDataDate || null;
  } catch {
    value = null;
  }
  value = normalizeDataThrough(value);
  // Only a real answer is worth remembering — caching a failure turns a
  // transient blip into a permanent degradation.
  if (value) cachedDataThrough.set(datasetId, { value, at: Date.now() });
  return value;
}

/**
 * DataReloadService reports freshness per schema in whatever granularity that
 * schema's reloader tracks — several return a MONTH ("2026-04"), not a full
 * date. That is harmless in the prose it was originally written for, but this
 * value is now also injected into SQL generation as `DATE '<value>'`, where
 * "2026-04" is a syntax error that would break every query for that dataset.
 *
 * Normalizes to a real YYYY-MM-DD (a bare month becomes its last day, which is
 * the correct "data runs through" reading), and returns null for anything that
 * isn't a usable date so the caller simply omits the anchor rather than
 * emitting invalid SQL.
 */
function normalizeDataThrough(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const month = /^(\d{4})-(\d{2})$/.exec(s);
  if (month) {
    const y = Number(month[1]), m = Number(month[2]);
    if (m < 1 || m > 12) return null;
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month = last day of this one
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
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
 * Cheap diagnostic, not a fix by itself — a valid JSON object always ends on
 * a closing brace (or a closing code fence around one); a response cut off
 * mid-generation almost never does. Used only to make a "No JSON object
 * found" log line actionable (raise maxTokens) instead of a bare, ambiguous
 * parse error — found live in prod via scripts/test-insights-battery.js:
 * synthesizeInsight's response for a wide multi-item finding legitimately
 * exceeded its old 2048-token cap on BOTH retry attempts (not a fluke — the
 * same prompt/data produces a similarly-sized response every time), so the
 * "1 retry" stability fix from earlier today couldn't save it by itself.
 */
function looksTruncated(rawResponse) {
  const trimmed = String(rawResponse || '').trim();
  return trimmed.length > 0 && !trimmed.endsWith('}') && !trimmed.endsWith('```');
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
      model: MODEL, maxTokens: 64, jsonOutput: true, temperature: 0, context: 'insights_classify_prompt',
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
  // Same sparse-column reasoning as the all-same-value branch below: a column
  // that is zero on 5 rows and NULL on 1,800 is not evidence of a broken join.
  const allZeroCols = numericCols.filter(k => {
    const zeroCount = data.filter(row => row[k] === 0 || row[k] === '0' || row[k] === '0.00').length;
    const allZeroOrNull = data.every(row => row[k] === 0 || row[k] === '0' || row[k] === '0.00' || row[k] === null);
    return allZeroOrNull && zeroCount > 0 && zeroCount / data.length >= 0.8;
  });
  if (allZeroCols.length > 0) return { flagged: true, reason: 'all-zero', columns: allZeroCols };

  // Exclude columns whose own name says they're a deliberately-constant
  // benchmark (a percentile/average cross-joined onto every row for
  // comparison, e.g. "revenue_p75_threshold" or "avg_inventory_units") —
  // caught live in prod being identical isn't a JOIN bug there, it's exactly
  // how that SQL pattern is supposed to look. Deliberately does NOT exclude
  // "target" — a real per-store sales target column pinned to the same
  // value on every row IS the original bug this check exists to catch.
  const isLikelyBenchmarkCol = k => /avg|average|median|percentile|benchmark|threshold|_p\d{2}(_|$)/i.test(k);
  // A column populated on only a HANDFUL of rows is a sparse annotation, not a
  // per-row metric, so its constancy says nothing about a JOIN bug. Real case
  // (2026-08-10): a "steepest margin decline" query LEFT JOINed a LIMIT-1 CTE,
  // so decline_from_pct/decline_to_pct/total_margin_change were populated on
  // ~6 of 1,814 rows — correctly identical, since they describe the one family
  // the CTE selected. The old check ignored the NULLs entirely, flagged all
  // three, and downgraded a perfectly good insight to DATA QUALITY at
  // confidence 35. The original bug this guard exists for (every store at 0%
  // attainment) had 100% coverage, so it is still caught.
  const MIN_COVERAGE = 0.8;
  const allSameCols = numericCols.filter(k => {
    if (isLikelyBenchmarkCol(k)) return false;
    const values = data.map(row => String(row[k])).filter(v => v !== 'null');
    if (values.length < 3) return false;
    if (values.length / data.length < MIN_COVERAGE) return false;
    return values.every(v => v === values[0]) && values[0] !== '0' && values[0] !== '0.00';
  });
  if (allSameCols.length > 0) return { flagged: true, reason: 'all-same-value', columns: allSameCols };

  return { flagged: false, reason: null, columns: [] };
}

/**
 * The FIRST date the dataset holds. PLAN needs both ends: given only the end
 * date it will happily propose "July 2026 vs July 2025" for a dataset that
 * begins in March 2026, and every downstream step then executes a comparison
 * against a period that does not exist — surfacing to the user as "data not
 * available" when the real fault is the question. Best-effort: a null simply
 * omits the lower bound, which is the previous behaviour.
 */
async function getDataFromDate(datasetId) {
  try {
    const entry = getDatasetEntry(datasetId);
    const { first } = await dataThroughService.resolveDataRange(entry.getPool(), entry.schemaName);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Is the Smart Replenishment module live for this dataset?
 *
 * Wrapped so an unreachable module registry can never break an
 * investigation: a false answer simply means the category is not offered,
 * which is the behaviour every dataset had before the module existed.
 */
/**
 * Replenishment rows, shaped exactly like a query result so everything
 * downstream is unchanged — same keys, so the digest, the impact reconciler,
 * the independent verifier and the downgrade guard all work on it without
 * knowing it did not come from SQL.
 *
 * `sql` is deliberately a human-readable description rather than a query: the
 * detail page shows this field as "the SQL that produced this", and putting a
 * fabricated query there would be a lie in the one place the product exists
 * to be checkable.
 *
 * @returns {object|null} null when the module is not live
 */
async function getReplenishmentRows(datasetId) {
  try {
    const svc = require('../../modules/replenishment/services/recommendations.service');
    const res = await svc.getRecommendations(datasetId, { onlyDue: true, limit: 200 });
    if (res.error) return null;

    const data = res.recommendations.map(r => ({
      item: r.itemName || r.sku,
      sku: r.sku,
      supplier: r.supplier,
      status: r.status,
      order_qty: r.orderQty,
      estimated_cost_ex_vat: r.estimatedCostExVat,
      order_by_date: r.orderByDate,
      days_late: r.daysLate,
      days_of_cover: r.daysOfCover === null ? null : Math.round(r.daysOfCover),
      sales_per_day: Number(r.velocityDaily.toFixed(3)),
      in_stock: r.warehouseQty,
      on_order: r.onOrderQty,
      lead_time_days: r.leadTimeDays,
      lead_time_source: r.leadTimeSource,
    }));

    const assumed = res.recommendations.filter(r => r.leadTimeSource !== 'supplier').length;
    return {
      sql: `-- Not a SQL query. These rows come from the Smart Replenishment calculation,\n`
         + `-- which combines sales pace, stock, open orders and a per-supplier delivery\n`
         + `-- time that is configured by hand and is not present in the database.\n`
         + `-- Data through ${res.dataThrough}; computed for ${res.today}.`,
      explanation:
        `Reorder recommendations for ${res.total} item(s): ${res.summary.orderNow} overdue, `
        + `${res.summary.dueSoon} due soon. ${assumed} of the rows shown use an ASSUMED supplier `
        + `delivery time rather than one the client set — every date here depends on it. Order `
        + `values are list-price estimates excluding VAT and before discounts.`,
      confidence: assumed > 0 ? 60 : 85,
      data,
      rowCount: data.length,
      columns: data.length ? Object.keys(data[0]) : [],
    };
  } catch (err) {
    console.warn(`[insights] replenishment rows unavailable for ${datasetId}: ${err.message}`);
    return null;
  }
}

async function isReplenishmentLive(datasetId) {
  try {
    return await require('../../modules/services/module.service').isLive(datasetId, 'replenishment');
  } catch {
    return false;
  }
}

async function planQuestion(datasetId, config, prompt) {
  const [dataThrough, dataFrom] = await Promise.all([
    getDataThroughDate(datasetId),
    getDataFromDate(datasetId),
  ]);

  // "replenishment" is offered to PLAN only when the module is live for this
  // dataset. Offering it otherwise would let PLAN commit to a question
  // nothing can answer — the rows for that category come from the module's
  // engine, not from NL->SQL, so without the module there is no source.
  const replenishmentLive = await isReplenishmentLive(datasetId);
  const categories = ['cross-sell', 'margin', 'inventory', 'trend', 'risk']
    .concat(replenishmentLive ? ['replenishment'] : []);
  const categoryList = categories.map(c => `"${c}"`).join(' | ');
  const replenishmentNote = replenishmentLive
    ? '\n\nUse "replenishment" ONLY for questions about what to REORDER — what is about to run out, what should be ordered and when. Those are answered by a dedicated calculation, not by SQL, so do not write a dataQuestion that tries to compute reorder quantities yourself; state the business question plainly and leave measures/dimensions empty.'
    : '';
  const systemPrompt = `You are planning a proactive business-intelligence investigation for ${config.brandLabel}. You will be given an open-ended investigation prompt (like "Main risks for the next 6 months" or "Bundle opportunities hiding in baskets"). Your job is NOT to answer it yet — it is to turn it into exactly ONE concrete, specific, SQL-answerable data question that a text-to-SQL engine could run against a single database table to gather the evidence needed.

${dataThrough ? `The data runs through ${dataThrough} — treat that as "now" for anything relative ("recent," "this quarter," "next 6 months"). Do not assume any other year.\n` : ''}${dataFrom ? `The data STARTS on ${dataFrom} — there is nothing before that date. Every window you choose must fall inside ${dataFrom} to ${dataThrough}. If that span is shorter than a year then a year-on-year comparison is IMPOSSIBLE: it returns zero rows, which reaches the user as "your data is not available" when the real fault is the question. Compare against an earlier period that actually exists instead, and name the period you used.\n\n` : '\n'}The data available: ${config.dataModelDescription}

Respond with ONLY a JSON object:
{
  "category": one of ${categoryList},
  "dataQuestion": "a single, specific, concrete question in English that can be answered with one SQL aggregate query — mention the measure(s), a breakdown dimension if useful (e.g. by store, by product family, by week), and a time window",
  "measures": ["the 1-3 business quantities being measured, each 1-2 plain words, e.g. \\"revenue\\", \\"units sold\\", \\"inventory value\\""],
  "dimensions": ["the 1-2 entities the result is broken down BY, each 1-2 plain words SINGULAR, e.g. \\"store\\", \\"product family\\", \\"month\\", \\"campaign\\". Use [] if the answer is a single overall figure with no breakdown."],
  "substitution": null OR { "asked": "the entity the prompt asked about", "used": "the entity you are actually reporting on", "reason": "one short clause saying why" },
  "scopeAdded": null OR { "scope": "the restriction you added, e.g. \\"the most recent complete month\\"", "reason": "one short clause saying why" }
}

${replenishmentNote}

"measures" and "dimensions" are a machine-readable restatement of the SAME question — they are used to re-aggregate the result in code, so they must match "dataQuestion" exactly. List ONLY the entity the question is really about: if the question asks for revenue per campaign, dimensions is ["campaign"] — not ["campaign","discount level"] — even if the underlying table happens to store a finer breakdown.

FIDELITY — the two rules that matter most.

1. ANSWER THE ENTITY THAT WAS ASKED ABOUT. If the prompt names an entity (customers, categories, suppliers, regions) and the data model has no such entity, do NOT quietly answer about a near-neighbour instead. Either say so — set "dataQuestion" to the closest honest question AND fill in "substitution" — or, if nothing reasonable exists, still fill in "substitution" so the write-up can lead with the gap. Answering about sellers when the prompt said customers, or grouping by item ID when the prompt said category, is the single worst thing you can do here: every downstream check will pass and the reader will be told something true about the wrong thing.

2. DO NOT NARROW THE SCOPE THE PROMPT CHOSE. If the prompt asks for a total ("what is our total gross profit"), the data question is the total — over all data, not the last month, not the most recent complete period. Add a time window ONLY when the prompt implies one ("recently", "this quarter", "trend"). If you do restrict a question that did not ask to be restricted, you MUST fill in "scopeAdded".

MANDATORY SELF-CHECK before you answer. Read your own "dataQuestion" back and compare it, word by word, against the investigation prompt:

- Does the prompt name an entity (staff, sellers, customers, discounts, invoices, channels, suppliers, regions) that your dataQuestion does NOT group by or measure? Then you have substituted. Set "substitution" with what was asked and what you used. "The entity does not exist so I measured something else" IS a substitution — it is the single most common case, not an exception to the rule.
- Does the prompt ask how something CHANGED, or over a period, while your dataQuestion asks for a current or total figure? That is also a substitution: a snapshot is not a change. Set it.
- Did you add a period, a "most recent month", a "latest snapshot" or a top-N cut the prompt did not ask for? Set "scopeAdded".

Worked examples of what MUST be declared:
- prompt "Which sales staff sell the most?" -> dataQuestion about chain-wide totals => substitution {asked: "sales staff", used: "chain-wide totals", reason: "no staff or seller dimension exists in this data"}
- prompt "Which retail customers buy the most?" -> dataQuestion about top items => substitution {asked: "retail customers", used: "items", reason: "no retail customer dimension exists"}
- prompt "How did warehouse stock change over the last three months?" -> dataQuestion about current stock => substitution {asked: "change over three months", used: "current stock level", reason: "inventory rows carry no date, so there is no history to compare"}

Writing a caveat into the headline is NOT a substitute for setting the field: the field is what the interface renders and what caps the confidence score, and prose can be dropped. If you are unsure whether something counts, set it — an unnecessary declaration is harmless, a missing one is not.

Both fields are null only when your dataQuestion measures exactly the entity and period the prompt named. They are shown to the reader verbatim, so write them as plain statements of fact.

Pick the category that best matches what the investigation prompt is actually about. Do not hedge or ask a follow-up question — commit to one specific, well-scoped data question.`;

  // Up to 2 attempts: an LLM JSON round trip occasionally comes back
  // malformed or missing "dataQuestion" — this used to kill the whole
  // investigation immediately (no recourse, no canned fallback since Round
  // 4 — see project memory). Same "self-correcting retry" philosophy the
  // QUERY step already has for SQL execution errors, applied here to this
  // step's own failure mode instead.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response;
    try {
      response = await llmService.sendOneShot(systemPrompt, `Investigation prompt: "${prompt}"`, {
        model: MODEL, maxTokens: 640, jsonOutput: true, temperature: 0, context: 'insights_investigate_plan',
      });
      const parsed = parseJSON(response);
      if (!parsed.dataQuestion) throw new Error('Plan step returned no dataQuestion');
      const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : 'trend';
      // A departure object is only trusted when it actually carries its
      // required fields — the model sometimes emits {} or "none" instead of
      // null, and an empty object would otherwise cap confidence forever.
      const asDeparture = (v, required) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const out = {};
        for (const k of ['asked', 'used', 'scope', 'reason']) {
          if (typeof v[k] === 'string' && v[k].trim()) out[k] = v[k].trim().slice(0, 200);
        }
        return required.every(k => out[k]) ? out : null;
      };
      const asStrings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 3) : []);
      return {
        category,
        dataQuestion: parsed.dataQuestion,
        // The machine-readable half of the plan — drives result-digest's
        // re-aggregation back to the grain that was actually asked for.
        spec: { measures: asStrings(parsed.measures), dimensions: asStrings(parsed.dimensions) },
        // PLAN's own declaration that it departed from the prompt. No numeric
        // guard can catch a rewritten question — the arithmetic is correct,
        // the entity or the period is not — so the departure has to be
        // declared here and carried structurally rather than inferred later.
        substitution: asDeparture(parsed.substitution, ['asked', 'used']),
        scopeAdded: asDeparture(parsed.scopeAdded, ['scope']),
      };
    } catch (err) {
      lastErr = err;
      const hint = looksTruncated(response) ? ' (response looks truncated — did not end on "}"; consider raising maxTokens)' : '';
      console.error(`   [plan attempt ${attempt}] failed: ${err.message}${hint}`);
    }
  }
  throw lastErr;
}

async function synthesizeInsight({ datasetId, config, prompt, category, dataQuestion, queryResult, dataAnomaly, verifierFeedback, digest, substitution, scopeAdded }) {
  const { sql, explanation, data, rowCount } = queryResult;
  // Cap what we feed back — enough rows to see the shape/pattern, not the whole table.
  // These are ILLUSTRATIVE ONLY: every total/ranking/percentage must come from
  // `digest` instead (see result-digest.service.js for why).
  const sampleRows = data.slice(0, SAMPLE_LIMIT);
  const dataThrough = await getDataThroughDate(datasetId);

  const systemPrompt = `You are Aspect, an AI that proactively investigates ${config.brandLabel}'s data and writes up findings for a business audience. You already ran a real SQL query and have the real result rows below — write the insight using ONLY these numbers. Do not invent any figure that isn't directly computable from the provided rows.

LANGUAGE — MIRROR THE PROMPT, NOTHING ELSE. Write EVERY user-visible string (headline, title, breadcrumbLabel, tag, categoryLabel, impactLabel, ctaLabel, block titles and labels, reasoning, confidenceChecks, sourceNote) in the SAME language the investigation prompt is written in.
- Prompt in English → the ENTIRE write-up in English.
- Prompt in Hebrew → the ENTIRE write-up in Hebrew.
Decide from the prompt's own words alone. Hebrew appearing in the DATA (store names, product names, record types) says nothing about the requested language — the data is Hebrew regardless of what was asked, so it must not pull the write-up toward Hebrew. Keep entity names exactly as they appear in the data and keep ₪ as the currency symbol in both languages. Never translate a value that came from the database.

${dataThrough ? `The data runs through ${dataThrough} — that is "now." When your headline/title/description says something like "as of," "currently," "this quarter," or names a year, it MUST be consistent with that real date, not a guess from any other year.\n` : ''}
${substitution ? `DEPARTURE — THE READER ASKED ABOUT SOMETHING ELSE. The prompt asked about "${substitution.asked}", but this data answers about "${substitution.used}"${substitution.reason ? ` (${substitution.reason})` : ''}. Your FIRST sentence — the headline — must say so plainly before it says anything else, in the prompt's language. Do not bury it in a caveat at the bottom, do not imply the numbers are about ${substitution.asked}, and do not use a confident business-opportunity tag. The reader needs to know they are looking at a different thing than they asked for.
` : ''}${scopeAdded ? `DEPARTURE — NARROWED SCOPE. The prompt did not ask for a time restriction, but this data covers ${scopeAdded.scope} only${scopeAdded.reason ? ` (${scopeAdded.reason})` : ''}. Every figure you quote must name that scope where it appears — a headline number presented as a total when it is one period's number is a wrong answer, not a partial one.
` : ''}
${queryResult.coverage ? `PARTIAL PERIOD — THIS IS NOT OPTIONAL. ${queryResult.coverage.note} Every figure you quote for ${queryResult.coverage.period} must carry that fact where it appears, and you must NOT describe a change into that period as growth or decline: a 4-day period against a 30-day one is not a comparison. Say how many days it covers, in the prompt's language.
` : ''}
SANITY CHECK before writing anything: if EVERY row shows the key metric at exactly 0 (or some other suspiciously uniform value across 100% of rows), that is a strong signal of a JOIN/pipeline/data-gap bug, not a genuine uniform business outcome — real business data almost never produces the identical extreme value on every single row. In that case do NOT write a confident business-risk headline with a specific dollar figure. Instead: use tag "DATA QUALITY" (not "RISK" or any other category tag), keep the headline factual and hedged ("N rows show $0 — likely a data or pipeline issue, not confirmed store performance"), cap confidence at 40, and make the FIRST confidenceChecks entry the specific caveat explaining what looks broken (e.g. a join key that shouldn't match, a null field that should be populated). Only write a normal confident finding when the pattern varies across rows the way real business data does.


The detail page is NOT one fixed template — you choose, for THIS specific finding, which content blocks actually convey it best, from this palette:
- "chart": a line/bar/pie/table series over categories (weeks, months, stores, product families...) — best when there's a real trend or a multi-item breakdown worth plotting.
- "ranked_list": a numbered leaderboard of items with a value and a relative bar — best for "which N stores/products/families..." questions, where a ranked comparison IS the finding. MAXIMUM 10 items — pick the top 10 by whatever measure the ranking is about, never more (anything past 10 gets discarded downstream anyway, so writing more just wastes your own output budget and risks getting cut off mid-response on a large finding).
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

ARITHMETIC SELF-CHECK before finalizing "impactValue" (and any total figure in "headline"/"title"): if it represents a combined/aggregate total across several items (e.g. "N stores/families... ₪X total"), and you are ALSO listing those same individual items in a block (ranked_list/comparison), ₪X MUST equal the literal sum of the individual item values you put in that block — actually add them up, don't estimate. A frequent real mistake is citing a bigger, rounder headline total (e.g. including borderline/excluded items) while the block only lists the narrower set that supports it — pick ONE consistent set of items and make every figure describing it agree exactly.

SOURCE OF NUMBERS — THIS OVERRIDES EVERYTHING ELSE ABOVE: the user message contains a block headed "AUTHORITATIVE AGGREGATES", computed in code over the COMPLETE result set. Those are the only trustworthy totals, per-entity values, rankings and percentages available to you. The raw result rows are a small, arbitrary sample of a much larger result and are there ONLY to show you the shape of the data — reading one raw row as an entity's total, or ranking entities by what you can see in the sample, produces catastrophically wrong findings (a real case: a campaign reported at ₪7,885 whose true total was ₪555,229, and a "top campaign" that was really 20th). Take every figure from the authoritative aggregates. If a number you want to state is not derivable from them, do not state it.`;

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

${digestText(digest)}

Raw result rows (JSON, up to ${SAMPLE_LIMIT} — ILLUSTRATIVE SAMPLE ONLY, see above): ${JSON.stringify(sampleRows)}${anomalyNote}${verifierNote}`;

  // Up to 2 attempts: an LLM JSON round trip occasionally comes back
  // malformed or missing a required field. Same retry philosophy as
  // planQuestion() above and the QUERY step's own SQL retry — a single bad
  // response shouldn't kill the whole investigation, and a response with no
  // headline shouldn't silently ship a broken card either.
  //
  // maxTokens 2048 -> 4096 -> 6144 (2026-08-07, same day, two separate
  // rounds): scripts/test-insights-battery.js caught 2048 failing on BOTH
  // attempts for wide multi-item findings, so it was bumped to 4096 (the
  // provider's own default). Then caught 4096 ALSO failing — specifically
  // on the regenerate-after-VERIFY-rejection retry, which tends to produce
  // an even LONGER response than the original attempt (the model tries to
  // be extra-thorough after being told what it got wrong) — for a
  // 15-item ranked_list finding. Paired with capping ranked_list at 10
  // items in the prompt itself just above (most of the actual bloat: items
  // 11-15 were being generated only to be discarded by normalizeBlocks()
  // downstream anyway), 6144 gives real headroom above the largest
  // legitimate response observed so far without guessing indefinitely.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let response;
    try {
      response = await llmService.sendOneShot(systemPrompt, userMessage, {
        model: MODEL, maxTokens: 6144, jsonOutput: true, temperature: 0, context: 'insights_investigate_synthesize',
      });
      const parsed = parseJSON(response);
      if (!parsed.headline) throw new Error('Synthesize step returned no headline');
      return parsed;
    } catch (err) {
      lastErr = err;
      const hint = looksTruncated(response) ? ' (response looks truncated — did not end on "}"; consider raising maxTokens)' : '';
      console.error(`   [synthesize attempt ${attempt}] failed: ${err.message}${hint}`);
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
async function verifyInsight({ config, queryResult, synthesized, digest }) {
  const { data, rowCount } = queryResult;
  const sampleRows = data.slice(0, SAMPLE_LIMIT);

  const systemPrompt = `You are a strict fact-checker reviewing a business-intelligence write-up for ${config.brandLabel} BEFORE it is shown to a user. You did not write it and have no stake in it sounding impressive — your only job is to catch numbers or claims that are NOT actually supported by the real query result rows provided.

THE AUTHORITATIVE AGGREGATES BLOCK IS YOUR SOURCE OF TRUTH, NOT THE RAW ROWS. It was computed in code over the COMPLETE result set; the raw rows below it are a small arbitrary sample of a much larger result. A figure that matches a raw row but CONTRADICTS the authoritative aggregates is WRONG — that is the most damaging error this check exists to catch (a real case: every campaign total in a shipped report was taken from a single sample row and was 70-127x too low, while a "top campaign" was really 20th). Never validate a total, ranking or percentage by adding up the sample.

Check specifically:
- Every concrete number in "headline", "title", and "impactValue", and inside "blocks" (chart points, ranked_list values, stat_callout value, comparison values), must match the authoritative aggregates, or be a simple direct arithmetic consequence of them. Reject a number that isn't — including one that is visible in the raw sample but disagrees with the aggregates.
- Any ranking (which entity is #1, top N order) must match the authoritative per-entity ranking. Reject a ranking derived from the sample.
- Any percentage must use the authoritative grand total as its denominator.
- Reject any total formed by summing a percentage, rate, average, unit price or threshold column (listed under "NOT SUMMABLE" when present).
- Exception: a "scenarios" block's "good"/"neutral"/"negative" values are ALLOWED to be plausible forward-looking projections, not literal row data — do not flag those alone for being projections.
- ARITHMETIC CHECK (do this explicitly, don't eyeball it): if "impactValue" (or a total inside "headline"/"title") claims a combined/aggregate figure across several items — e.g. "N stores/families... ₪X total" — and a block (ranked_list/comparison) lists those same individual items, ACTUALLY ADD UP the individual item values yourself and compare the sum to ₪X. Flag it as a real issue if they disagree beyond simple rounding — this is a common real bug: a bigger headline total that silently includes items the detail blocks don't, or excludes items they do.
- Internal consistency: if the same metric appears in two places (e.g. a stat_callout and the chart, or a number restated inside a "scenarios" description), the values must agree with each other.
- The finding must not overstate what a thin result actually shows (e.g. presenting 2 rows as a firm multi-point trend).

Respond with ONLY a JSON object:
{ "verified": true or false, "issues": ["short specific issue", ...] }
Set "verified": false only for a REAL problem (an invented/unsupported number, an internal contradiction, or a wildly overstated claim) — not for writing style or a clearly-labeled scenario projection. Empty "issues" array when verified is true. Each issue: ONE plain sentence, under 25 words, stating the concrete discrepancy — not your reasoning process, not a running commentary on whether you're about to flag it or not.`;

  const userMessage = `${digestText(digest)}

Raw sample rows (JSON, ${sampleRows.length} of ${rowCount} — ILLUSTRATIVE ONLY, never a basis for a total or ranking): ${JSON.stringify(sampleRows)}

Insight to verify:
headline: ${synthesized.headline}
title: ${synthesized.title}
impactValue: ${synthesized.impactValue}
blocks: ${JSON.stringify(synthesized.blocks)}
chart: ${JSON.stringify(synthesized.chart)}`;

  // maxTokens 512 -> 1024 (2026-08-07): caught live via
  // scripts/test-insights-battery.js — a real multi-issue verification
  // response ran long enough (the model tends to think out loud per issue
  // despite the "one plain sentence" instruction above) to hit 512 and get
  // silently swallowed by the catch below, meaning the insight shipped as
  // "verified: true" without ever actually being checked. That's the worst
  // failure mode for a safety net: it fails exactly on the more complex,
  // more-likely-to-have-real-issues cases, not the simple ones.
  let response;
  try {
    response = await llmService.sendOneShot(systemPrompt, userMessage, {
      model: MODEL, maxTokens: 1024, jsonOutput: true, temperature: 0, context: 'insights_investigate_verify',
    });
    const parsed = parseJSON(response);
    return { verified: parsed.verified !== false, issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5).map(String) : [] };
  } catch (err) {
    // The verifier itself failing (network hiccup, malformed JSON) should
    // never block or downgrade an otherwise-real insight — treat as "unable
    // to verify this time," not "verification failed."
    const hint = looksTruncated(response) ? ' (response looks truncated — did not end on "}"; consider raising maxTokens)' : '';
    console.error(`   Verify step failed, not blocking on it: ${err.message}${hint}`);
    return { verified: true, issues: [] };
  }
}

/**
 * Code-derived ceiling on how confident an insight is ALLOWED to be, computed
 * from signals the model doesn't get to grade itself on.
 *
 * `confidence` was previously whatever number the write-up model felt like
 * emitting (0-100), only ever clamped down by the anomaly/verify guards. So a
 * finding resting on 4 rows, from SQL the generator itself flagged as low
 * confidence, could still ship at 90 — and "90%" carried no information a user
 * could act on. Each deduction below is a fact about the evidence, and each
 * one that fires is surfaced verbatim in confidenceChecks so the score is
 * explainable rather than asserted.
 *
 * @returns {{ceiling: number, reasons: Array<{positive: boolean, text: string}>}}
 */
function confidenceCeiling({ queryResult, digest, verification, dataAnomaly, substitution, scopeAdded }) {
  let ceiling = 95; // nothing is ever certain enough for 100
  const reasons = [];
  const cap = (value, text) => {
    if (value < ceiling) ceiling = value;
    reasons.push({ positive: false, text });
  };

  const rows = queryResult.rowCount ?? 0;
  if (rows < 3) cap(50, `Only ${rows} result row(s) — too thin to establish a trend or ranking.`);
  else if (rows < 10) cap(70, `Based on ${rows} result rows — a small sample for a general claim.`);

  if (queryResult.confidence === 'low') cap(45, 'The SQL generator reported low confidence that this dataset can answer the question as asked.');
  else if (queryResult.confidence === 'medium') cap(85, 'The SQL generator reported medium confidence in its query for this question.');

  if (!verification.verified) cap(40, `Independent fact-check still unsatisfied: ${verification.issues.join('; ') || 'unsupported figures'}`);
  if (dataAnomaly.flagged) cap(40, `Automated data check flagged column(s) [${dataAnomaly.columns.join(', ')}] as ${dataAnomaly.reason}.`);

  // A result the digest could not re-aggregate to a named entity has no
  // authoritative per-item numbers behind it — see result-digest.service.js.
  if (digest && !digest.empty && !digest.regrouped) {
    cap(65, 'The result could not be re-aggregated to a single named entity, so per-item figures are not independently confirmed.');
  }
  // Most of the population being immaterial means any ranking is dominated by
  // noise unless the write-up used the material list.
  if (digest?.materiality && digest.materiality.dropped > digest.materiality.kept) {
    cap(80, `${digest.materiality.dropped} of ${digest.rowCount} rows are below the materiality threshold, so percentage rankings across the full set are noise-dominated.`);
  }

  // An answer about a different entity than the one asked about, or one
  // silently narrowed to a sub-period, is not a high-confidence answer to the
  // question that was actually put — however sound its arithmetic.
  if (substitution) {
    cap(55, `Asked about ${substitution.asked}, answered about ${substitution.used}${substitution.reason ? ` — ${substitution.reason}` : ''}.`);
  }
  if (scopeAdded) {
    cap(75, `The question did not specify a period; this answer covers ${scopeAdded.scope} only.`);
  }

  if (reasons.length === 0) {
    reasons.push({ positive: true, text: `Verified against ${rows.toLocaleString('en-US')} result rows with no data-quality or fact-check flags raised.` });
  }
  return { ceiling, reasons };
}

function confidenceLabelFor(score) {
  if (score >= 85) return 'High';
  if (score >= 65) return 'Medium';
  return 'Low';
}

// Matches the FIRST numeric digit run in a short value string like "₪159K",
// "-₪54K / mo", "1,860", "82.79" — digits (with thousands separators) plus
// an optional K/M scale suffix. Deliberately does NOT try to capture the
// sign in the same match: a leading "-" is often separated from the digits
// by a currency symbol ("-₪54K"), so the sign is detected separately (see
// parseNumberToken) by checking for a literal "-" anywhere before the
// match, rather than requiring it immediately adjacent to the digits.
const NUMBER_TOKEN = /([\d,]+(?:\.\d+)?)\s*([KM])?\b/i;

function parseNumberToken(str) {
  const s = String(str ?? '');
  const m = NUMBER_TOKEN.exec(s);
  if (!m) return null;
  const raw = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(raw)) return null;
  const scale = m[2] ? { k: 1e3, m: 1e6 }[m[2].toLowerCase()] : 1;
  const isNegative = s.slice(0, m.index).includes('-');
  return { value: (isNegative ? -1 : 1) * raw * scale, index: m.index, length: m[0].length };
}

/** Formats a MAGNITUDE only (no sign) — spliceNumber() below is responsible for reusing whatever sign character the original string already had, never adding a second one. */
function formatMagnitude(absValue) {
  const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
  if (absValue >= 1e6) return `${round(absValue / 1e6, 2)}M`;
  if (absValue >= 1e3) return `${round(absValue / 1e3, 1)}K`;
  return Number.isInteger(absValue) ? String(absValue) : String(round(absValue, 2));
}

/**
 * Splices a corrected number back into the original string in place,
 * keeping every other character (sign, currency symbol, "/ mo", "pts"...)
 * exactly as written — only the digit run itself is replaced, always with
 * a plain magnitude (see formatMagnitude), never a sign, so a "-" already
 * present earlier in the string (e.g. "-₪10.9M") is reused as-is instead of
 * risking a double sign like "-₪-10M". Callers are responsible for only
 * calling this when the replacement value's sign already matches the
 * original's (see the sign-agreement guard in reconcileImpactValue).
 */
function spliceNumber(original, token, newValue) {
  return original.slice(0, token.index) + formatMagnitude(Math.abs(newValue)) + original.slice(token.index + token.length);
}

/**
 * Deterministic correction, not just detection: if "impactValue" states a
 * combined total (or average) across several items that are ALSO listed
 * individually in a ranked_list/comparison block, recompute that sum/
 * average with real code arithmetic — which cannot hallucinate — and
 * overwrite impactValue if the model's own mental math disagreed. This is
 * the single most common real failure scripts/test-insights-battery.js
 * caught VERIFY rejecting live in prod 2026-08-07 (e.g. "impactValue claims
 * ₪10.9M but the 20 stores listed sum to ₪10.04M"). Runs BEFORE
 * verifyInsight on every synthesis attempt, so this whole class of mismatch
 * gets fixed for free — no extra LLM call, no spending the one available
 * regenerate-and-recheck retry on arithmetic code can just do exactly.
 *
 * Deliberately conservative: only corrects the short, structured
 * "impactValue" field, never headline/title prose (splicing a corrected
 * number into a full sentence isn't reliable); only fires when the claimed
 * number is close enough to the computed sum/average to be clearly the
 * SAME figure stated wrong (2%-100% off) — a number that's way off is more
 * likely an unrelated metric than a slip, and left for VERIFY to judge
 * instead of guessing.
 *
 * REAL BUG caught live in prod the same day this shipped (via
 * scripts/test-insights-battery.js's own run, not a user): a "steepest
 * margin decline" insight's impactValue correctly named ONE family's own
 * decline (-9.89pp) — its ranked_list block showed that family plus several
 * OTHER families for context/ranking, not as addends of a total. This
 * function summed the whole list anyway and overwrote the already-correct
 * -9.89pp with a meaningless "-15.44pp" (the sum of unrelated families'
 * declines), which VERIFY then correctly flagged as wrong — i.e. this
 * function INTRODUCED the exact class of error it exists to prevent. Fixed
 * by checking first whether impactValue already matches a SINGLE item in
 * the block (the common "here's the standout, the rest is context" shape)
 * — only treat it as an aggregate-across-everything claim (the "N stores...
 * ₪X total" shape this function actually targets) when it doesn't.
 */
function reconcileImpactValue(synthesized, digest) {
  if (typeof synthesized.impactValue !== 'string') return synthesized;
  const blocks = Array.isArray(synthesized.blocks) ? synthesized.blocks : [];
  const itemBlock = blocks.find(b => (b.type === 'ranked_list' || b.type === 'comparison') && Array.isArray(b.items) && b.items.length >= 2);
  if (!itemBlock) return synthesized;

  // THE BLOCK MUST BE THE WHOLE POPULATION, NOT A TOP-N EXCERPT OF IT.
  // A ranked_list is capped at 10 items, so on any result with more than 10
  // entities it is a leaderboard, not a set of addends — and summing it
  // produces a number that is simply a different quantity from the total
  // impactValue is stating. Caught live 2026-08-10 on the very first run
  // after the digest landed: a correct "₪5.0M attributed campaign revenue"
  // (28 campaigns) was overwritten with ₪3.72M, the sum of the 10 shown.
  // The digest knows the real entity count, so this is now decidable rather
  // than guessed at.
  if (digest?.regrouped && digest.distinctGroups > itemBlock.items.length) return synthesized;

  const itemValues = itemBlock.items.map(it => parseNumberToken(it.value)).filter(Boolean).map(t => t.value);
  if (itemValues.length < 2) return synthesized;

  const claimed = parseNumberToken(synthesized.impactValue);
  if (!claimed || claimed.value === 0) return synthesized;

  // impactValue naming ONE item's own value (almost always the #1/top-ranked
  // one) is a completely different, equally common shape as "a total across
  // every item" — summing the whole list would compare two unrelated
  // numbers in that case. Bail out rather than guess which shape this is.
  const matchesSingleItem = itemValues.some(v => v !== 0 && Math.abs(claimed.value - v) / Math.abs(v) <= 0.05);
  if (matchesSingleItem) return synthesized;

  const sum = itemValues.reduce((a, b) => a + b, 0);
  if (sum === 0 || Math.sign(sum) !== Math.sign(claimed.value)) return synthesized; // a sign disagreement is a different, more serious kind of error than a magnitude slip — don't guess at a fix, let VERIFY judge it
  const avg = sum / itemValues.length; // always the same sign as sum (dividing by a positive count) — one sign check covers both candidates

  // Ratio, not a one-sided relative error: |claimed-x|/|x| is bounded above
  // by 1.0 as claimed shrinks toward 0 relative to x, so it can NEVER flag
  // "claimed is basically unrelated to a much bigger x" — caught by a test
  // case where "₪2" against ₪1M-scale items still slipped under an err>1
  // cutoff. ratio = |claimed|/|x| has no such blind spot in either
  // direction: too small AND too big both show up as ratio far from 1.
  const ratioTo = candidate => Math.abs(claimed.value) / Math.abs(candidate);
  const sumRatio = ratioTo(sum), avgRatio = ratioTo(avg);

  // Whichever of {sum, avg} the model's claim is closer to (ratio nearer 1)
  // is almost certainly what it was TRYING to state — pick that as the
  // intended target, then check whether it actually got the arithmetic right.
  const sumIsCloser = Math.abs(sumRatio - 1) <= Math.abs(avgRatio - 1);
  const target = sumIsCloser ? sum : avg;
  const ratio = sumIsCloser ? sumRatio : avgRatio;

  // Within 2% either way is normal rounding, not a bug. Less than half or
  // more than double is more likely an unrelated metric than a slip —
  // left for VERIFY to judge instead of guessing at a "fix".
  if (ratio >= 0.98 && ratio <= 1.02) return synthesized;
  if (ratio < 0.5 || ratio > 2) return synthesized;

  const correctedImpactValue = spliceNumber(synthesized.impactValue, claimed, target);
  console.log(`   Reconciled impactValue via code arithmetic: "${synthesized.impactValue}" -> "${correctedImpactValue}" (block items summed in code, not model mental math)`);
  return { ...synthesized, impactValue: correctedImpactValue };
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

  // Deliberately left SAMPLED (no temperature: 0) while every other step in
  // the pipeline is pinned deterministic. This is the one step whose whole
  // job is to come up with something NEW — pinning it would make "Request a
  // new insight" propose the same angle every time the covered list happens
  // to look the same.
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
async function investigate(datasetId, userId, prompt, jobId = null) {
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
  progress.start(jobId);
  const actualPrompt = prompt && prompt.trim() ? prompt.trim() : await proposeInvestigationPrompt(datasetId, userId, config);

  const { category, dataQuestion, spec, substitution, scopeAdded } = await planQuestion(datasetId, config, actualPrompt);

  progress.set(jobId, 'query', dataQuestion);

  // ── Smart Replenishment: rows come from the ENGINE, not from NL->SQL ──
  //
  // Everything downstream is untouched. The digest, the impact reconciler,
  // the independent verifier and the downgrade guard all operate on rows and
  // a write-up; they do not care where the rows came from. That is why this
  // is a substitution at one point rather than a second pipeline.
  //
  // It has to be a substitution: the reorder arithmetic depends on a supplier
  // delivery time that is not in the database at all, so no generated query
  // could produce these numbers — and a query that looked like it had would
  // be wrong in a way every downstream check would pass.
  const engineResult = category === 'replenishment'
    ? await getReplenishmentRows(datasetId)
    : null;
  if (category === 'replenishment' && !engineResult) {
    // Module went away between PLAN and QUERY (disabled mid-investigation).
    // Fall through to the normal path rather than failing the run.
    console.warn(`[insights] ${datasetId}: replenishment planned but the module is not live — falling back to SQL`);
  }

  const queryResult = engineResult || await getDataQueryService(datasetId).queryByQuestion(dataQuestion, entry.schemaName, {
    llmAgentName: 'Aspect Intelligence',
    // Anchor relative windows ("last 4 weeks", "this quarter") to the date the
    // data really ends. Without it, any dataset whose export lags — thestock
    // was 106 days behind, newdeli 100 — returns zero rows for every recent
    // window, which was 4 of the 5 remaining zero-row failures.
    dataThroughDate: await getDataThroughDate(datasetId),
    // The default 15s statement timeout is a CHAT constraint — a user sitting
    // in front of a reply. An investigation is asynchronous background work
    // that already takes 30-100s end to end (4+ LLM round trips), and the
    // browser polls for progress rather than blocking on the response, so
    // there is no reason for it to inherit that budget. 8 of 42 suite cases
    // failed purely on this: real inventory sell-through and multi-CTE trend
    // queries need more than 15s against 40M-row fact tables.
    timeout: INSIGHTS_QUERY_TIMEOUT_MS,
  });
  if (queryResult.error) {
    throw new Error(`Data query failed: ${queryResult.message}`);
  }

  // A result with nothing in it used to flow straight into SYNTHESIZE, which
  // is REQUIRED to emit a headline and an impactValue — so "this data does
  // not exist in the schema" (the outcome the SQL retry hint explicitly asks
  // for, via a zero-row query) came back as a confidently-worded finding about
  // nothing. detectSuspiciousResult can't catch it either: it returns
  // unflagged below 3 rows. Fail loudly instead — the UI already has an error
  // state, and no insight is strictly better than an invented one.
  if (queryResult.rowCount === 0) {
    // An unsatisfiable predicate and a genuine "none" both return zero rows.
    // Saying "not available in this dataset" for the first one is wrong: the
    // records exist, the filter just could not match them.
    const err = new Error(queryResult.emptyReason
      ? `${queryResult.emptyReason.message} (asked: "${dataQuestion}")`
      : `The data needed to answer this isn't available in this dataset — the query for "${dataQuestion}" returned no rows.`);
    err.status = 422;
    throw err;
  }

  progress.set(jobId, 'aggregate');
  const dataAnomaly = detectSuspiciousResult(queryResult.data);
  // Authoritative, code-computed aggregates over the COMPLETE result set —
  // this is what the write-up and the verifier must use instead of adding up
  // a 30-row sample. See result-digest.service.js.
  const digest = buildResultDigest(queryResult.data, spec);

  // Is this result even arithmetically possible? Every other guard checks a
  // figure against the query's own rows, which cannot catch a query that is
  // itself wrong. Comparing the result's grand totals against the fact table's
  // own totals does: a filtered query is always <= the whole table, so a
  // result that EXCEEDS it has fanned out. This is what makes "₪362.9B revenue
  // for a florist chain whose sales table totals ₪51M" a detectable error
  // rather than a confident headline.
  const baselineCheck = await measureBaseline.checkAgainstBaselines(datasetId, digest);
  if (baselineCheck.exceeded) {
    const f = baselineCheck.findings[0];
    console.error(`   ❌ Impossible result: ${f.column} totals ${f.reported.toLocaleString('en-US')}, ` +
      `but all of ${entry.schemaName}.${f.table} only totals ${f.ceiling.toLocaleString('en-US')} (${f.factor.toFixed(1)}x) — the join fanned out.`);
    const err = new Error(
      `The query produced an impossible result: it reports ${f.column} of ` +
      `${Math.round(f.reported).toLocaleString('en-US')}, which is ${f.factor.toFixed(1)}x the entire dataset ` +
      `(${Math.round(f.ceiling).toLocaleString('en-US')}). This means the query duplicated rows through a join, ` +
      `so no finding from it can be trusted.`
    );
    err.status = 422;
    throw err;
  }

  progress.set(jobId, 'synthesize');
  let synthesized = await synthesizeInsight({ datasetId, config, prompt: actualPrompt, category, dataQuestion, queryResult, dataAnomaly, digest, substitution, scopeAdded });
  synthesized = reconcileImpactValue(synthesized, digest);

  // Step 4, VERIFY: an independent LLM pass fact-checks step 3's own output
  // against the real rows (see verifyInsight() doc comment for why this is a
  // separate call rather than more instructions in the same prompt). One
  // regenerate-and-recheck retry, feeding the verifier's specific complaint
  // back in — most rejections are a single invented number and self-correct
  // immediately once named explicitly, the same way the QUERY step's SQL
  // retry already works.
  progress.set(jobId, 'verify');
  let verification = await verifyInsight({ config, queryResult, synthesized, digest });

  // Up to TWO regeneration attempts, not one. Measured on the 2026-08-19
  // zolstock suite: 5 of 35 reports still failed the fact-check after a single
  // retry, and three of those shipped a genuinely wrong number in the headline
  // — one understated a year-on-year decline by roughly 9x (-0.5% against a
  // true -4.5%). A second attempt costs one LLM call and ~30s, and ONLY on a
  // case that has already failed, so a clean run pays nothing for it.
  //
  // Each attempt is fed the CURRENT complaint rather than the original one:
  // the second rejection is usually about a different figure than the first,
  // and re-sending a stale complaint just reproduces the same rewrite.
  const MAX_SYNTH_RETRIES = 2;
  for (let retry = 1; retry <= MAX_SYNTH_RETRIES && !verification.verified; retry++) {
    console.log(`   Verify rejected synthesis (attempt ${retry}/${MAX_SYNTH_RETRIES}), regenerating: ${verification.issues.join('; ')}`);
    progress.set(jobId, 'synthesize', `Rewriting after fact-check (${retry}/${MAX_SYNTH_RETRIES})`);
    synthesized = await synthesizeInsight({ datasetId, config, prompt: actualPrompt, category, dataQuestion, queryResult, dataAnomaly, digest, substitution, scopeAdded, verifierFeedback: verification.issues });
    synthesized = reconcileImpactValue(synthesized, digest);
    progress.set(jobId, 'verify');
    verification = await verifyInsight({ config, queryResult, synthesized, digest });
  }
  if (!verification.verified) {
    console.log(`   Verify still unsatisfied after ${MAX_SYNTH_RETRIES} rewrites — shipping downgraded: ${verification.issues.join('; ')}`);
  }

  // Hard enforcement, not just a prompt hint: cap confidence and mark the tag
  // even if the model's own self-check (see synthesizeInsight's system
  // prompt) didn't kick in for this particular response, AND even if the
  // independent verify pass above still isn't satisfied after the retry. A
  // failed verification downgrades rather than discards — the query itself
  // was real, only the write-up over-claimed, so a real (if less confident)
  // insight is still more useful than nothing per the no-canned-fallback
  // stance (see project memory, Round 4).
  // The model's self-reported confidence is now only ever an upper bid: the
  // real score is min(what it claimed, what the evidence actually supports).
  // Every deduction is computed from a hard signal (row count, SQL-generator
  // confidence, verification verdict, anomaly flag, whether the digest could
  // confirm per-entity numbers, materiality) and is surfaced in
  // confidenceChecks, so the number shown is explainable instead of asserted.
  const claimed = Math.max(0, Math.min(100, Math.round(synthesized.confidence ?? 70)));
  const { ceiling, reasons } = confidenceCeiling({ queryResult, digest, verification, dataAnomaly, substitution, scopeAdded });
  const confidence = Math.min(claimed, ceiling);
  let tag = synthesized.tag || category.toUpperCase();
  const confidenceChecks = [...reasons, ...(synthesized.confidenceChecks || [])];
  // The two conditions that mean "the write-up itself is not trustworthy" (as
  // opposed to merely thin) still re-tag the card, not just lower its score.
  if (dataAnomaly.flagged || !verification.verified) {
    if (!/data quality/i.test(tag)) tag = 'DATA QUALITY';
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
      // Structural, not prose: the client renders these as a fixed banner so a
      // departure cannot be lost by a model that chose not to mention it.
      substitution: substitution || null,
      coverage: queryResult.coverage || null,
      scopeAdded: scopeAdded || null,
      sql: queryResult.sql,
      sqlConfidence: queryResult.confidence,
      // What the model asked for vs what the evidence allowed — makes the
      // final score auditable instead of a bare number.
      confidenceClaimed: claimed,
      confidenceCeiling: ceiling,
      verification: { verified: verification.verified, issues: verification.issues },
      // What the numbers were actually computed from — makes the "was this a
      // sample or the whole result?" question answerable after the fact,
      // which it wasn't when the campaign report shipped.
      aggregation: {
        rowCount: digest.rowCount,
        groupedBy: digest.groupBy,
        distinctGroups: digest.distinctGroups,
        collapsedColumns: digest.collapsedColumns,
        sampleShown: Math.min(SAMPLE_LIMIT, digest.rowCount),
      },
    },
  };

  await store.insert(datasetId, userId, insight);
  progress.finish(jobId);

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

/**
 * A session's own reports, PLUS the dataset's shared suggestions.
 *
 * bootstrap() writes under the fixed `system` user while every read is scoped
 * to the caller's own anonymous session, so those reports reached nobody — a
 * new user saw "No open suggestions right now" forever, despite the route
 * existing precisely to "populate an empty feed".
 *
 * Shared rather than copied-per-user, deliberately. A suggestion is a property
 * of the DATA, not of the person: everyone querying this dataset is looking at
 * the same numbers, so they should see the same findings, and those findings
 * should refresh for everyone at once when the nightly run regenerates them. A
 * per-user copy would freeze at whatever moment that user first visited, so two
 * people would see different "current" figures for the same dataset — the exact
 * class of wrongness the rest of this pipeline exists to prevent.
 *
 * Ownership starts at Save instead (see setTracked): saving clones the report
 * to the user, which is also the right semantics — a saved report is a snapshot
 * you can return to, so it SHOULD stop moving.
 */
async function listGenerated(datasetId, userId) {
  const own = await store.listByUser(datasetId, userId);
  if (userId === BOOTSTRAP_USER_ID) return own;

  const shared = await store.listByUser(datasetId, BOOTSTRAP_USER_ID);
  if (shared.length === 0) return own;

  // A suggestion the user already saved is now theirs — don't show both.
  const alreadySaved = new Set(own.map(i => i.seededFrom).filter(Boolean));
  const suggestions = shared
    .filter(s => !alreadySaved.has(s.id))
    .map(s => ({ ...s, shared: true, origin: 'proposed', tracked: false }));

  return [...own, ...suggestions];
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

/** Falls back to the dataset's shared suggestions so opening one from the list works — it isn't owned by this session. */
async function getGeneratedById(datasetId, userId, insightId) {
  const own = await store.getById(datasetId, userId, insightId);
  if (own) return own;
  if (userId === BOOTSTRAP_USER_ID) return null;
  const shared = await store.getById(datasetId, BOOTSTRAP_USER_ID, insightId);
  // `shared: true` tells the client this report isn't the user's — the detail
  // page hides Delete, because removing it would take it from everyone.
  return shared ? { ...shared, shared: true, tracked: false } : null;
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
    model: MODEL, maxTokens: 1024, jsonOutput: true, temperature: 0, context: 'insights_action_plan',
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
async function setTracked(datasetId, userId, insightId, tracked) {
  const own = await store.updateInsight(datasetId, userId, insightId, insight => {
    insight.tracked = !!tracked;
    // Newly tracked items go to the end of the manage-tracking order — reuse
    // Date.now() as a simple monotonically-increasing value, same pattern
    // already used for insight ids themselves elsewhere in this file.
    if (insight.tracked) insight.trackedOrder = Date.now();
  });
  if (own) return own;

  // COPY-ON-SAVE. The id isn't one of this session's reports, so it is a shared
  // suggestion being saved for the first time. Clone it to the user rather than
  // mutating the shared row — otherwise one person saving would flip it saved
  // for everyone. `seededFrom` lets listGenerated hide the shared original once
  // a personal copy exists, so the same report never appears twice.
  if (!tracked || userId === BOOTSTRAP_USER_ID) return null;
  const shared = await store.getById(datasetId, BOOTSTRAP_USER_ID, insightId);
  if (!shared) return null;

  const copy = {
    ...shared,
    id: `saved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    seededFrom: shared.id,
    origin: 'proposed',
    tracked: true,
    trackedOrder: Date.now(),
    viewed: true,
    createdAt: Date.now(),
  };
  await store.insert(datasetId, userId, copy);
  return copy;
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
  // Exported ONLY for scripts/test-replenishment-insights.js, the same way
  // detectSuspiciousResult / reconcileImpactValue are exported for the unit
  // battery. No route calls this.
  __getReplenishmentRowsForTest: getReplenishmentRows,
  investigate, listGenerated, listGeneratedAll, getGeneratedById, deleteGenerated, deleteGeneratedAny,
  setTrackedAny, markViewed, bootstrap, listTracked, setTracked, reorderTracked, generateActionPlan,
  classifyPrompt, setDataReloadService,
  /** Real stage progress for a running investigation — see investigation-progress.service.js. */
  getProgress: progress.get,
  // Exported purely so scripts/test-insights-unit.js can exercise this
  // pure, DB/LLM-free logic directly as real regression tests (see the
  // 2026-08-07 bugs each of these was fixed for) — not part of the public
  // API surface any route calls into.
  detectSuspiciousResult, looksLikeTimeSeries, reconcileImpactValue,
};
