/**
 * Otto's dataset brief — the knowledge pass.
 *
 * The brief is Otto's entire knowledge of a client's data: which relations
 * exist and what they mean, the whitelisted field vocabulary every plan and
 * every compiled query is allowed to touch, the manifest caveats that must
 * ride the screens, and the starter suggestions the builder page offers.
 *
 * It is built ONCE, when Otto is enabled for a client, by the standard
 * module-init pipeline (audit → propose → verify, ≤5 rounds), and stored as
 * the module's `binding` — the framework's durable per-dataset state, the
 * same slot replenishment keeps its column mapping in. Rounds can converge
 * here for the same reason they converge there: the model chooses relations
 * and columns from an enumerable set the audit provides, and a failed probe
 * names exactly which name to reconsider.
 *
 * NOTHING DOWNSTREAM TRUSTS THE MODEL. Structural validation checks every
 * relation and column against the audit before a proposal is accepted;
 * verify() re-checks against the live schema; the `heavy` flag is computed
 * from measured row counts, never taken from the proposal.
 */

const llmService = require('../../services/llm');
const datasetManifest = require('../../services/dataset-manifest');

/** Above this, a relation may only be read through views/MVs, never raw —
 *  the ZolStock 30M-row answer, enforced in the compiler via `heavy`. */
const HEAVY_ROWS = 5_000_000;

/** The brief rides every brainstorm/plan/spec prompt, so it has a hard size
 *  budget (≈2.5k tokens). A real zolstock brief (8 sources, 40 fields, 13
 *  caveats) renders at ~6.3k chars — 9k leaves room without letting a
 *  runaway brief eat the conversation's context. */
const PROMPT_BUDGET_CHARS = 9000;

const FIELD_TYPES = ['text', 'number', 'date'];
const FIELD_FORMATS = ['money', 'int', 'decimal', 'percent', 'date', 'text'];

// ── audit (read-only, no LLM) ────────────────────────────────────────────

const MAX_RELATIONS = 80;
const MAX_COLUMNS = 48;

/**
 * What the schema actually holds: every table/view/matview with estimated
 * rows and columns. This is the enumerable set the proposal chooses from
 * and the ground truth structural validation checks against.
 */
async function audit(ctx) {
  const { pool, schemaName } = ctx;
  if (!pool) throw new Error(`otto.audit: dataset '${ctx.datasetId}' has no pool`);

  const { rows: rels } = await pool.query(
    `SELECT c.relname AS name,
            CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' END AS kind,
            GREATEST(c.reltuples::bigint, 0) AS rows
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','v','m')
      ORDER BY CASE c.relkind WHEN 'm' THEN 0 WHEN 'v' THEN 1 ELSE 2 END, c.relname`,
    [schemaName]);

  // pg_attribute, NOT information_schema.columns: the latter omits
  // MATERIALIZED VIEWS entirely, which handed the first real run matviews
  // with zero columns — the model then guessed names and every round failed.
  const { rows: cols } = await pool.query(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','v','m')
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schemaName]);

  const columnsByRel = {};
  for (const c of cols) {
    (columnsByRel[c.table_name] ||= []).push({ name: c.column_name, type: c.data_type });
  }

  const relations = rels.slice(0, MAX_RELATIONS).map(r => ({
    name: r.name,
    kind: r.kind,
    rows: Number(r.rows) || 0,
    columns: (columnsByRel[r.name] || []).slice(0, MAX_COLUMNS),
    columnsTruncated: (columnsByRel[r.name] || []).length > MAX_COLUMNS,
  }));

  const manifest = datasetManifest.get(schemaName);
  return {
    schemaName,
    relations,
    relationsTruncated: rels.length > MAX_RELATIONS,
    hasManifest: Boolean(manifest),
    manifestProse: manifest ? datasetManifest.renderForPrompt(manifest) : null,
  };
}

// ── structural validation ────────────────────────────────────────────────

function isBilingual(x) {
  return Boolean(x && typeof x.en === 'string' && x.en.trim()
    && typeof x.he === 'string' && x.he.trim());
}

/**
 * Check a proposed brief against the audit. Returns a list of error strings
 * naming the exact field — that list is the round feedback, so precision
 * here is what makes the next round a revision rather than a re-roll.
 */
function validateBrief(brief, auditResult) {
  const errors = [];
  const relByName = Object.fromEntries((auditResult?.relations || []).map(r => [r.name, r]));

  if (!brief || typeof brief !== 'object') return ['brief is not an object'];
  if (!Array.isArray(brief.sources) || brief.sources.length === 0) {
    errors.push('sources must be a non-empty array');
  }
  if (!Array.isArray(brief.fields) || brief.fields.length === 0) {
    errors.push('fields must be a non-empty array');
  }
  if (errors.length) return errors;

  const sourceIds = new Set();
  for (const s of brief.sources) {
    const where = `source '${s?.id || '(no id)'}'`;
    if (!s?.id || !/^[a-z][a-z0-9_]*$/.test(s.id)) errors.push(`${where}: id must be a lowercase identifier`);
    else if (sourceIds.has(s.id)) errors.push(`${where}: duplicate id`);
    sourceIds.add(s.id);
    if (!isBilingual(s.label)) errors.push(`${where}: label must carry both en and he`);
    if (!s.relation || !relByName[s.relation]) {
      errors.push(`${where}: relation '${s?.relation}' does not exist in schema ${auditResult.schemaName} — choose from the audit list`);
    }
  }

  const fieldIds = new Set();
  for (const f of brief.fields) {
    const where = `field '${f?.id || '(no id)'}'`;
    if (!f?.id || !/^[a-z][a-z0-9_]*$/.test(f.id)) errors.push(`${where}: id must be a lowercase identifier`);
    else if (fieldIds.has(f.id)) errors.push(`${where}: duplicate id`);
    fieldIds.add(f.id);
    if (!isBilingual(f.label)) errors.push(`${where}: label must carry both en and he`);
    if (!sourceIds.has(f.sourceId)) errors.push(`${where}: sourceId '${f?.sourceId}' is not a declared source`);
    if (!FIELD_TYPES.includes(f.type)) errors.push(`${where}: type must be one of ${FIELD_TYPES.join('/')}`);
    if (f.format !== undefined && !FIELD_FORMATS.includes(f.format)) {
      errors.push(`${where}: format must be one of ${FIELD_FORMATS.join('/')}`);
    }
    const src = brief.sources.find(s => s.id === f.sourceId);
    const rel = src && relByName[src.relation];
    if (rel && !rel.columns.some(c => c.name === f.column)) {
      errors.push(`${where}: column '${f.column}' does not exist on ${src.relation} — its columns are: ${rel.columns.map(c => c.name).join(', ')}`);
    }
  }

  // Every source must be reachable through at least one field, or it is dead
  // weight in every prompt from now on.
  for (const s of brief.sources) {
    if (s.id && !brief.fields.some(f => f.sourceId === s.id)) {
      errors.push(`source '${s.id}' has no fields — remove it or map its columns`);
    }
  }

  if (!Array.isArray(brief.caveats)) errors.push('caveats must be an array (empty is fine)');
  else for (const c of brief.caveats) {
    if (!c?.id || !isBilingual(c.text)) errors.push(`caveat '${c?.id || '(no id)'}' must have an id and bilingual text`);
  }

  if (!Array.isArray(brief.starters) || brief.starters.length < 2) {
    errors.push('starters must carry at least 2 example screens');
  } else for (const st of brief.starters) {
    if (!isBilingual(st?.text)) errors.push('every starter must have bilingual text');
  }

  return errors;
}

/**
 * The `heavy` flag is DERIVED, never proposed: measured rows decide it. A
 * heavy source may only be a view/matview (already aggregated); a heavy raw
 * table is rejected as a source outright — the compiler would refuse every
 * query against it anyway, so failing here names the problem earlier.
 */
function applyHeavyFlags(brief, auditResult) {
  const relByName = Object.fromEntries((auditResult?.relations || []).map(r => [r.name, r]));
  const errors = [];
  for (const s of brief.sources) {
    const rel = relByName[s.relation];
    if (!rel) continue;
    const heavy = rel.rows > HEAVY_ROWS;
    s.heavy = heavy;
    if (heavy && rel.kind === 'table') {
      errors.push(`source '${s.id}': ${s.relation} is a raw table with ~${rel.rows.toLocaleString()} rows — pick an aggregating view or matview over it instead`);
    }
  }
  return errors;
}

// ── the knowledge pass (LLM) ─────────────────────────────────────────────

function extractJSON(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new Error('the model did not return valid JSON');
}

/**
 * proposeBinding hook — build the brief. Thrown errors carry
 * `bindingErrors` so the orchestrator records a round failure with the
 * exact list, which is what the next round's prompt receives.
 */
async function proposeBrief(ctx) {
  const { audit: auditResult, settings, round = 1, previousFailures = [] } = ctx;

  const auditForPrompt = {
    schemaName: auditResult.schemaName,
    relations: auditResult.relations.map(r => ({
      name: r.name, kind: r.kind, rows: r.rows,
      columns: r.columns.map(c => `${c.name} (${c.type})`),
    })),
  };

  const feedback = previousFailures.length
    ? `\n\nYOUR PREVIOUS PROPOSAL FAILED. Fix exactly these problems and change nothing that was not named:\n${previousFailures.map(f => `- ${f.detail || f.probe}`).join('\n')}`
    : '';

  const system = `You are preparing Otto's dataset brief. Otto is a screen builder that talks to retail employees (non-developers) and builds operational screens on their organization's data. The brief you write is Otto's ENTIRE knowledge of this dataset — his conversations, plans and queries can only use what you declare here.

Rules — all binding:
1. Choose ONLY relations and columns that appear in the audit below. Never invent a name.
2. Prefer materialized views and views over raw tables — they are pre-aggregated and fast. A relation with millions of rows must never be a source unless it is a view/matview.
3. 4 to 8 sources: the relations most useful for operational screens (stock, sales aggregates, items catalogue, suppliers, orders). Give each a short human label and a one-line description of its grain (what one row is), in BOTH English and Hebrew.
4. 15 to 40 fields: the useful columns across those sources. Each field: id (lowercase snake), sourceId, column (exact name), type (text/number/date), format (money/int/decimal/percent/date/text), label in BOTH languages.
5. caveats: honest limitations a screen built on this data must state (from the manifest notes below — quote their substance, do not soften). Empty array if none.
6. starters: 3 example screens a retail employee would actually want from THIS data, phrased as short requests, in both languages.
7. BE COMPACT. The brief rides every prompt from now on: descriptions are one short clause, labels are 1-3 words, and a field that merely duplicates another is left out.
${auditResult.manifestProse ? `\nMANIFEST (the dataset's truth card — respect it):\n${auditResult.manifestProse}\n` : ''}
Return ONLY JSON:
{
  "sources": [{ "id": "", "relation": "", "label": {"en":"","he":""}, "description": {"en":"","he":""} }],
  "fields":  [{ "id": "", "sourceId": "", "column": "", "type": "", "format": "", "label": {"en":"","he":""} }],
  "caveats": [{ "id": "", "text": {"en":"","he":""} }],
  "starters": [{ "text": {"en":"","he":""} }]
}${feedback}`;

  const user = `AUDIT of schema ${auditForPrompt.schemaName} (round ${round}):\n${JSON.stringify(auditForPrompt, null, 1)}`;

  const response = await llmService.sendOneShot(system, user, {
    model: settings?.initModel || 'claude-sonnet-5',
    // Hebrew labels are token-expensive (~1 token/char): 40 bilingual fields
    // plus caveats and starters truncated at 6000 and failed JSON parsing
    // three rounds straight in the first real run. 16k leaves headroom.
    maxTokens: 16000,
    jsonOutput: true,
    context: 'otto_knowledge',
    // Per-customer key when this dataset has one — the schema name IS the
    // key scope (provider-config.service.js normalizes the same way).
    agentName: auditForPrompt.schemaName,
  });

  let brief;
  try {
    brief = extractJSON(response);
  } catch (e) {
    const err = new Error(`brief proposal was not valid JSON: ${e.message}`);
    err.bindingErrors = [err.message];
    throw err;
  }

  const errors = validateBrief(brief, auditResult);
  if (errors.length === 0) errors.push(...applyHeavyFlags(brief, auditResult));
  if (errors.length) {
    const err = new Error(`brief failed structural validation (${errors.length} problem${errors.length > 1 ? 's' : ''})`);
    err.bindingErrors = errors;
    err.binding = brief;
    throw err;
  }

  brief.briefVersion = 1;
  return brief;
}

// ── verify (probes against the LIVE schema) ──────────────────────────────

/**
 * Re-check the converged brief against the database itself — the audit could
 * be stale by the time a round ends, and the schema-rules lesson (zer4u's
 * nine ghost matviews) says names rot silently.
 */
async function verify(ctx) {
  const { pool, binding: brief, verifySchema } = ctx;
  const probes = [];

  // Same pg_attribute source as the audit — information_schema omits
  // matviews, and a verify that cannot see them would fail every brief.
  const { rows: liveCols } = await pool.query(
    `SELECT c.relname AS table_name, a.attname AS column_name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','v','m')
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [verifySchema]);
  const live = {};
  for (const c of liveCols) (live[c.table_name] ||= new Set()).add(c.column_name);

  for (const s of brief.sources) {
    probes.push({
      probe: `relation_exists:${s.relation}`,
      passed: Boolean(live[s.relation]),
      detail: live[s.relation] ? 'ok' : `relation '${s.relation}' not found in live schema ${verifySchema}`,
    });
  }
  for (const f of brief.fields) {
    const src = brief.sources.find(s => s.id === f.sourceId);
    const ok = Boolean(src && live[src.relation]?.has(f.column));
    probes.push({
      probe: `column_exists:${f.id}`,
      passed: ok,
      detail: ok ? 'ok' : `field '${f.id}': column '${f.column}' not found on '${src?.relation}'`,
    });
  }

  const prose = renderBriefForPrompt(brief);
  probes.push({
    probe: 'prompt_budget',
    passed: prose.length <= PROMPT_BUDGET_CHARS,
    // Actionable for the next round: name the levers, not just the number.
    detail: prose.length <= PROMPT_BUDGET_CHARS
      ? `${prose.length} chars (budget ${PROMPT_BUDGET_CHARS})`
      : `${prose.length} chars over the ${PROMPT_BUDGET_CHARS} budget — drop the least useful fields and shorten source descriptions to one clause`,
  });

  probes.push({
    probe: 'starters_present',
    passed: Array.isArray(brief.starters) && brief.starters.length >= 2,
    detail: `${brief.starters?.length || 0} starters`,
  });

  return { passed: probes.every(p => p.passed), probes };
}

// ── rendering for prompts ────────────────────────────────────────────────

/**
 * The brief as prose for Otto's brainstorm/plan prompts. English throughout —
 * the conversation's LANGUAGE is governed by the mirror rule in the prompt
 * that embeds this, and Hebrew labels ride along so the model can echo the
 * user's own vocabulary.
 */
function renderBriefForPrompt(brief) {
  const lines = [];
  for (const s of brief.sources) {
    const fields = brief.fields.filter(f => f.sourceId === s.id);
    lines.push(`SOURCE ${s.id} — ${s.label.en} / ${s.label.he}${s.heavy ? ' [heavy: pre-aggregated only]' : ''}`);
    if (s.description?.en) lines.push(`  ${s.description.en}`);
    lines.push(`  fields: ${fields.map(f => `${f.id} (${f.type}${f.format ? `/${f.format}` : ''}, "${f.label.en}"/"${f.label.he}")`).join(', ')}`);
  }
  if (brief.caveats?.length) {
    lines.push('CAVEATS (must be stated on screens that touch them):');
    for (const c of brief.caveats) lines.push(`  [${c.id}] ${c.text.en}`);
  }
  return lines.join('\n');
}

module.exports = {
  audit,
  proposeBrief,
  verify,
  validateBrief,
  applyHeavyFlags,
  renderBriefForPrompt,
  HEAVY_ROWS,
  PROMPT_BUDGET_CHARS,
};
