/**
 * Plan → screen spec — call 3 of 3. Opus 5, the owner's explicit call
 * (task §12 Q5): one call per build, and the artifact's quality is the
 * deliverable. Chat and plan stay on Sonnet.
 *
 * The model composes from enumerable sets only — brief field ids, catalog
 * block kinds, aggregation ops. A schema-validation failure retries with
 * the exact errors named; probe failures from the build pipeline arrive
 * here the same way. It never sees rows and never writes SQL or HTML.
 */

const llmService = require('../../services/llm');
const { renderBriefForPrompt } = require('./brief.service');
const { LANGUAGE_RULE, extractJSON } = require('./brainstorm.service');
const {
  validateSpec, BLOCK_KINDS, KPI_AGGS, MEASURE_AGGS, CHART_VARIANTS,
} = require('./spec.contract');

const MAX_ATTEMPTS = 3;

function planForPrompt(plan) {
  const line = (x) => `${x.en} / ${x.he}`;
  const parts = [
    `TITLE: ${line(plan.title)}`,
    `SUMMARY: ${line(plan.summary)}`,
    `SOURCES: ${plan.sources.map(s => (typeof s === 'string' ? s : s.id)).join(', ')}`,
    `COLUMNS: ${plan.columns.map(c => `${c.field} ("${line(c.label)}")`).join(', ')}`,
  ];
  if (plan.filters?.length) parts.push(`FILTERS: ${plan.filters.map(f => `${f.field} ("${line(f.label)}")`).join(', ')}`);
  if (plan.kpis?.length) parts.push(`KPIS:\n${plan.kpis.map(k => `  - ${line(k.label)} — ${k.detail ? line(k.detail) : ''}`).join('\n')}`);
  if (plan.charts?.length) parts.push(`CHARTS (each becomes a chart block):\n${plan.charts.map(c => `  - ${line(c.label)} — ${c.detail ? line(c.detail) : ''}`).join('\n')}`);
  if (plan.actions?.length) parts.push(`ACTIONS: ${plan.actions.map(a => line(a.label)).join(', ')}`);
  if (plan.notes?.length) parts.push(`NOTES:\n${plan.notes.map(n => `  - ${line(n)}`).join('\n')}`);
  if (plan.isChange && plan.changes?.length) {
    parts.push(`THIS IS A REVISION. Approved changes:\n${plan.changes.map(c => `  - ${line(c)}`).join('\n')}`);
  }
  return parts.join('\n');
}

/**
 * @param previousSpec on a revision — change only what the plan's change
 *   list names; everything else stays, which is what "edit, don't redraw"
 *   means when the artifact is a spec instead of HTML.
 */
async function buildSpec({ plan, brief, settings, previousSpec = null, probeFeedback = null, agentName = null, usageKey = null }) {
  const system = `You compose an operational screen for the Intelligence Center as a JSON screen spec. The user already approved the plan; build exactly what it says — nothing less, no additions nobody asked for.

${LANGUAGE_RULE}

THE DATA (every field reference must be one of these ids, used with its own source):

${renderBriefForPrompt(brief)}

THE SPEC FORMAT — return ONLY this JSON shape:
{
  "specVersion": 1,
  "resultSets": [
    {
      "id": "rows",
      "source": "<brief source id>",
      "select": ["<field ids of that source>"],
      "computed": [ { "id": "shortfall", "label": {"en":"","he":""}, "expr": "safety_stock - qty_on_hand", "format": "int" } ],
      "where": "optional row condition, e.g. shortfall > 0",
      "orderBy": { "field": "<column id>", "dir": "desc" },
      "limit": 500
    }
  ],
  "blocks": [
    { "kind": "noteLine", "caveatIds": ["<brief caveat ids relevant to this screen>"] },
    { "kind": "kpiCards", "from": "rows", "cards": [
        { "id": "below", "label": {"en":"","he":""}, "sub": {"en":"","he":""},
          "agg": "countWhere", "where": "shortfall > 0", "format": "int", "tone": "alarm" } ] },
    { "kind": "filterBar", "from": "rows", "filters": ["<text column ids>"] },
    { "kind": "dataTable", "from": "rows", "columns": ["<column ids in display order>"], "sortable": true, "pageSize": 50 },
    { "kind": "chart", "from": "sets_may_differ", "variant": "<line|bar|pie — match what the plan's CHARTS entry names>", "category": "<column id>", "series": ["<numeric column ids>"], "title": {"en":"","he":""} },
    { "kind": "actionsBar", "actions": [
        { "id": "export", "type": "exportCsv", "from": "rows", "label": {"en":"","he":""} },
        { "id": "po", "type": "stub", "label": {"en":"","he":""}, "notice": {"en":"what will happen when this is wired","he":""} } ] }
  ]
}

Rules — all binding:
1. Block kinds: ${BLOCK_KINDS.join(', ')}. Nothing else exists.
2. A result set reads ONE source. For grouped data use "aggregate": { "groupBy": [...], "measures": [ { "id", "agg" (${MEASURE_AGGS.join('/')}), "field" OR "expr", "label", "format" } ] } INSTEAD of "select". A measure normally aggregates one raw field ("field"). When the number is a product of two raw fields of the SAME source (e.g. revenue = qty * unit_price, with no "revenue" field in the brief), give the measure an "expr" instead of a "field" — it runs per row, before the aggregate, over this source's raw field ids only. Never put that kind of expression in "computed": computed columns run AFTER the aggregate and cannot see raw fields that were not also selected as a groupBy or another measure.
3. KPI aggs: ${KPI_AGGS.join(', ')}. Chart variants: ${CHART_VARIANTS.join(', ')}. A pie chart needs ONE series of non-negative values and at most 10 categories — give its result set an orderBy and a limit of 10 or less.
4. Expressions ("expr", "where") are plain arithmetic and one comparison over column ids — no functions, no strings, no AND/OR.
5. Every label carries BOTH "en" and "he" — the screen renders in either language.
6. Never invent a number, a field or a caveat. Caveats come from the brief's list only.
7. If the plan names a note that matches a brief caveat, open the screen with a noteLine block.
8. Order blocks as the user will read them: noteLine, kpiCards, filterBar, dataTable/chart, actionsBar.
9. When a CHARTS entry names its type — "(pie)", "(bar)", "(line)" — that IS the variant. Never substitute a different chart type for the one the user approved.`;

  const revision = previousSpec
    ? `\n\nTHE CURRENT SPEC (this is a revision — change ONLY what the plan's change list names, keep everything else identical):\n${JSON.stringify(previousSpec)}`
    : '';

  const baseUser = `THE APPROVED PLAN:\n${planForPrompt(plan)}${revision}`;

  let feedback = probeFeedback
    ? [`the previous build failed verification:\n${probeFeedback.map(p => `- ${p.probe}: ${p.detail}`).join('\n')}`]
    : null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const user = feedback
      ? `${baseUser}\n\nYOUR PREVIOUS SPEC FAILED. Fix exactly these problems and change nothing that was not named:\n${feedback.map(e => `- ${e}`).join('\n')}`
      : baseUser;

    const response = await llmService.sendOneShot(system, user, {
      model: settings?.buildModel || 'claude-opus-5',
      // Bilingual labels across every block add up; headroom is cheap, a
      // truncated spec costs a whole retry round.
      maxTokens: 12000,
      jsonOutput: true,
      context: 'otto_spec',
      agentName,
      conversationId: usageKey,
    });

    let spec;
    try {
      spec = extractJSON(response);
    } catch (e) {
      feedback = [`not valid JSON: ${e.message}`];
      continue;
    }

    coerceChartVariants(spec, plan);
    const errors = validateSpec(spec, brief);
    if (errors.length === 0) return spec;
    feedback = errors;
  }

  const err = new Error(`the spec did not pass validation after ${MAX_ATTEMPTS} attempts`);
  err.specErrors = feedback;
  throw err;
}

/**
 * The user approved a chart TYPE in the plan ("...(pie)"), but the build
 * model kept defaulting the variant to bar regardless — a plan-approved
 * choice silently overridden, which the design forbids. When the plan names
 * exactly one chart type and the spec has exactly one chart block, honor the
 * plan deterministically instead of trusting the model to echo it.
 */
function coerceChartVariants(spec, plan) {
  const chartBlocks = (spec.blocks || []).filter(b => b.kind === 'chart');
  const named = (plan.charts || [])
    .map(c => {
      // LABEL only — the plan prompt puts the type there ("... (pie)"). The
      // detail is prose where "one line per store" appears incidentally and
      // must not flip a chart the user never asked to change.
      const text = String(c.label?.en || '').toLowerCase();
      if (/\bpie\b|\bdonut\b/.test(text)) return 'pie';
      if (/\bbar\b/.test(text)) return 'bar';
      if (/\bline\b|\btrend\b/.test(text)) return 'line';
      return null;
    })
    .filter(Boolean);
  if (chartBlocks.length === 1 && named.length === 1 && chartBlocks[0].variant !== named[0]) {
    chartBlocks[0].variant = named[0];
  }
}

module.exports = { buildSpec, planForPrompt, coerceChartVariants };
