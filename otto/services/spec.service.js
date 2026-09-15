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
async function buildSpec({ plan, brief, settings, previousSpec = null, probeFeedback = null }) {
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
    { "kind": "chart", "from": "sets_may_differ", "variant": "bar", "category": "<column id>", "series": ["<numeric column ids>"], "title": {"en":"","he":""} },
    { "kind": "actionsBar", "actions": [
        { "id": "export", "type": "exportCsv", "from": "rows", "label": {"en":"","he":""} },
        { "id": "po", "type": "stub", "label": {"en":"","he":""}, "notice": {"en":"what will happen when this is wired","he":""} } ] }
  ]
}

Rules — all binding:
1. Block kinds: ${BLOCK_KINDS.join(', ')}. Nothing else exists.
2. A result set reads ONE source. For grouped data use "aggregate": { "groupBy": [...], "measures": [ { "id", "agg" (${MEASURE_AGGS.join('/')}), "field", "label", "format" } ] } INSTEAD of "select".
3. KPI aggs: ${KPI_AGGS.join(', ')}. Chart variants: ${CHART_VARIANTS.join(', ')}.
4. Expressions ("expr", "where") are plain arithmetic and one comparison over column ids — no functions, no strings, no AND/OR.
5. Every label carries BOTH "en" and "he" — the screen renders in either language.
6. Never invent a number, a field or a caveat. Caveats come from the brief's list only.
7. If the plan names a note that matches a brief caveat, open the screen with a noteLine block.
8. Order blocks as the user will read them: noteLine, kpiCards, filterBar, dataTable/chart, actionsBar.`;

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
    });

    let spec;
    try {
      spec = extractJSON(response);
    } catch (e) {
      feedback = [`not valid JSON: ${e.message}`];
      continue;
    }

    const errors = validateSpec(spec, brief);
    if (errors.length === 0) return spec;
    feedback = errors;
  }

  const err = new Error(`the spec did not pass validation after ${MAX_ATTEMPTS} attempts`);
  err.specErrors = feedback;
  throw err;
}

module.exports = { buildSpec, planForPrompt };
