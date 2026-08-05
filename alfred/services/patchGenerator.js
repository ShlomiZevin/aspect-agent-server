/**
 * Patch generator — Claude call #2 of the Apply flow.
 *
 * Given a current AgentBody/CrewBody + an English "what_to_do"
 * description, the model returns ONLY the top-level sections it
 * changed (each returned section COMPLETE — e.g. the whole
 * `parameters[]` array after adding one parameter). The server
 * merges those sections over the current body here and hands the
 * full merged body to the caller — so output size scales with the
 * CHANGE, not with the agent, and untouched sections are preserved
 * by construction (never retyped by the model). This replaced the
 * original full-body contract (decision 52) after big Hebrew agents
 * started truncating at the output-token cap.
 *
 * Output is locked to JSON via Anthropic forced tool_use: the model
 * MUST call the `submit_changes` tool. The API itself prevents
 * prose / preamble / leaked reasoning — no text-extraction
 * heuristics needed. A `reasoning` field on the tool lets the model
 * surface its thinking for debugging.
 */

const fs = require('fs');
const path = require('path');

const claudeService = require('../../services/llm.claude');
const { logUsage } = require('../../services/usageLogger');

const MODEL    = 'claude-sonnet-4-6';
const PROCESS  = 'alfred-apply-patch';
// Output cap. With the section contract most applies use a few hundred
// tokens; the cap only matters when a single big section (e.g. a long
// Hebrew enums bible) is itself the change. llm.claude surfaces a clear
// "truncated" error if it's ever hit.
const MAX_TOKENS = 16384;

/**
 * The replaceable top-level sections per entity — mirrors the AgentBody /
 * CrewBody Picks in builder/types/index.ts. Keep in sync when a new key
 * joins a body: a key missing here means Alfred can never change it.
 */
const AGENT_SECTION_KEYS = [
  'name', 'slug', 'spec', 'persona', 'defaultCrewId',
  'fields', 'domains', 'tags', 'parameters', 'enums',
  'cortex', 'snippets', 'personas', 'liveBrain', 'profiler',
];
const CREW_SECTION_KEYS = [
  'name', 'description', 'spec', 'persona', 'addons', 'fields',
];

/**
 * Merge the model's changed sections over the current body. Unknown
 * keys are ignored (logged) rather than fatal — the validator judges
 * the merged result anyway.
 */
function mergeChanges(entity, currentBody, changes) {
  const allowed = entity === 'agent' ? AGENT_SECTION_KEYS : CREW_SECTION_KEYS;
  const applied = [];
  const ignored = [];
  const next = { ...currentBody };
  for (const [key, value] of Object.entries(changes || {})) {
    if (!allowed.includes(key)) { ignored.push(key); continue; }
    next[key] = value;
    applied.push(key);
  }
  return { next, applied, ignored };
}

// Load the canonical TypeScript types file at module load. The
// server owns this file (see aspect-agent-server/builder/types/
// index.ts — same content the client builds against, kept in sync
// via the client's sync-types script).
//
// Living inside the server's own tree means it ships in the Docker
// build context: no cross-folder read, no ENOENT in production. The
// client mirrors at build time; it's the consumer, not the owner.
const TYPES_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'builder', 'types', 'index.ts'),
  'utf8',
);

/**
 * Load every addon descriptor at module init. These are the canonical
 * defaults the client and server share — see builder/addons/*.addon.json.
 * Embedded into the system prompt as fresh-addon templates: when the
 * patch generator creates a new AddonInstance, it copies the matching
 * descriptor's defaults and changes only what was explicitly requested.
 */
function loadAddonDescriptors() {
  const dir = path.join(__dirname, '..', '..', 'builder', 'addons');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.addon.json'));
  return files.map(f => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    return JSON.parse(raw);
  });
}
const ADDON_DESCRIPTORS = loadAddonDescriptors();

/**
 * Load the prompt-placeholder spec at module init. Single source of
 * truth shared with the server's prompt assembler and the brainstorm
 * Alfred. Embedded raw into the system prompt so the patch generator
 * uses the same `{{...}}` tokens the runtime actually substitutes.
 */
const PLACEHOLDER_SPEC_RAW = (() => {
  try {
    return fs.readFileSync(
      path.join(__dirname, '..', '..', 'builder', 'promptPlaceholders.json'),
      'utf8',
    );
  } catch (err) {
    console.warn('[alfred] failed to load promptPlaceholders.json:', err.message);
    return '';
  }
})();

/**
 * Render the descriptors as a string section the LLM can consume.
 * Each descriptor becomes a heading + JSON block. The instructions
 * tell the model to use these as starting points for new addons.
 */
function renderAddonTemplatesSection() {
  const blocks = ADDON_DESCRIPTORS.map(d => {
    // A "fresh AddonInstance" the LLM should produce when adding one
    // of these — it's the descriptor's defaults assembled into the
    // shape that lives inside a CrewBody.addons array. The model
    // generates `instanceId` per the id-format rule above; everything
    // else is verbatim from the descriptor unless the user asks
    // otherwise.
    const freshInstance = {
      instanceId:     '<generate: addon_xxxxxxxx>',
      pluginId:       d.pluginId,
      lane:           d.defaultLane,
      enabled:        true,
      config:         d.defaultConfig,
      context:        d.defaultContext,
      outputType:     d.defaultOutputType,
      promptTemplate: d.defaultPromptTemplate,
    };
    const lines = [
      `### ${d.pluginId}  (${d.displayName})`,
      d.description,
    ];
    // `purpose` is the long-form "when to use / when not to" guidance.
    // Optional on the descriptor for back-compat; when present it goes
    // right under the short description so the model has the context
    // it needs to choose between plugins correctly.
    if (d.purpose) {
      lines.push('', `**Purpose.** ${d.purpose}`);
    }
    lines.push(
      '',
      `Allowed output types: ${JSON.stringify(d.allowedOutputTypes)}`,
      '',
      'Fresh AddonInstance template — copy this and change ONLY what the user',
      'explicitly asked for. Keep `lane`, `enabled`, `outputType`, `context`,',
      'and `promptTemplate` at the defaults unless told otherwise.',
      '',
      '```json',
      JSON.stringify(freshInstance, null, 2),
      '```',
    );
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}
const ADDON_TEMPLATES = renderAddonTemplatesSection();

const SYSTEM_PROMPT = [
  'You are the patch-generator for the Aspect agent builder.',
  '',
  'You receive: (1) a JSON body that represents the current state of an',
  '`agent` or `crew`, (2) an English description of the change to apply',
  '(`what_to_do`), and — for crew targets — (3) the current agent body',
  'as READ-ONLY cross-reference. You submit ONLY the top-level sections',
  'you changed via the `submit_changes` tool. The server merges them',
  'over the current body; everything you don\'t return is preserved',
  'as-is. The `reasoning` field is a one-line note explaining what you',
  'did (used for debugging when something goes wrong).',
  '',
  '# Section contract (READ CAREFULLY)',
  '- `changes` is an object whose keys are top-level body sections.',
  '  Agent sections: name, slug, spec, persona, defaultCrewId, fields,',
  '  domains, tags, parameters, enums, cortex, snippets, personas,',
  '  liveBrain. Crew sections: name, description, spec, persona,',
  '  addons, fields.',
  '- Return ONLY the sections the change touches. Do NOT return',
  '  sections you didn\'t change — omitting them is what preserves them.',
  '- Every returned section must be COMPLETE — the entire value of that',
  '  section AFTER your change. Example: to add one parameter, return',
  '  `changes.parameters` = the FULL parameters array (all existing',
  '  entries, order preserved, plus the new one). Never return a',
  '  fragment, a single item, or a partial array.',
  '- The merged result MUST conform to the TypeScript types below. The',
  '  types are the canonical contract — the client compiles against them',
  '  and the runtime reads them. Pay attention to which fields are',
  '  optional vs required, the discriminated unions on `OutputType` and',
  '  addon configs by `pluginId`, and the comments — they describe',
  '  invariants the types alone can\'t express (e.g. "enum-typed fields',
  '  reference an EnumTypeDef on agent.enums via enumType").',
  '- When you add a new entity (FieldDef, AddonInstance), generate a',
  '  stable id of the form `<kind>_<random8>` (e.g. `field_a1b2c3d4`,',
  '  `addon_e5f6g7h8`). Lowercase hex; only [a-z0-9_].',
  '- When adding any addon, copy the matching fresh-instance template',
  '  from the descriptor catalogue below and adjust only what the user',
  '  asked for. Don\'t invent `context`, `outputType`, or `promptTemplate`',
  '  values — the templates have the right defaults.',
  '',
  '# Prompt model (Phase B)',
  'For every prompt-bearing addon (Talker, Field Extractor, Vibe Extractor,',
  'Thinker, and any future LLM-calling plugin):',
  '',
  '- `promptTemplate` is ALWAYS the literal string `"{{prompt}}"`. It is the',
  '  assembler\'s entry point, nothing more. Do not put template content here.',
  '- The actual prompt content the user wants to send to the LLM lives in',
  '  `config.prompt`. That string can — and usually does — contain `{{...}}`',
  '  tokens (see the placeholder section below) which the runtime substitutes',
  '  in a single pass.',
  '- `context` carries runtime knobs only: `history` (which conversation',
  '  messages reach the LLM), optional `trigger` (offline-lane firing rule),',
  '  and optional `filter` (run-gate conditions). The pre-Phase-B flags',
  '  `persona` / `memoryReads` / `thinkingReads` are GONE — placement of',
  '  those sections is now done by dropping `{{persona}}` / `{{memory}}` /',
  '  `{{thinking}}` (or the `:DOMAIN` variants) into `config.prompt`',
  '  wherever the user wants them to render.',
  '- Example: a Talker that greets a customer by name and references known',
  '  memory has `promptTemplate: "{{prompt}}"` and `config.prompt` like',
  '  `"{{persona}}\\n\\nHi {{field:customer_name}} — here\'s what we know:',
  '  {{memory:customer}}"`. NO `context.persona = true`, NO `memoryReads`.',
  '',
  '# Fields via JSON harvest (any addon)',
  '- The runtime auto-writes any addon\'s top-level JSON output key into',
  '  a declared field when the key EXACTLY matches the field\'s name',
  '  (explicit Field Extractor writes win; null skipped). So when the',
  '  change wants a Thinker (or similar) to fill a field, you do NOT',
  '  need to add a Field Extractor — just make the Thinker\'s prompt',
  '  instruct the LLM to return that exact field name as a JSON key,',
  '  and make sure the FieldDef exists.',
  '- Corollary: when authoring prompts for JSON-emitting addons, avoid',
  '  output keys that collide with declared field names unless writing',
  '  that field is intended.',
  '',
  '# Parallel steps (`joinsPreviousStep`)',
  '- Leave `joinsPreviousStep` absent unless the change explicitly asks for',
  '  parallel execution. Absent/false = sequential (the default behaviour).',
  '- Set `true` only to run an addon concurrently with the addon(s) right',
  '  before it in the `addons[]` order (Blocking lane only).',
  '- NEVER set `true` on: the first addon of the lane, a Talker (or any',
  '  speaks-to-user addon), or an addon that reads another same-step',
  '  addon\'s output — same-step members share the pre-step memory',
  '  snapshot and cannot see each other\'s writes. Dependents go in a',
  '  later step.',
  '',
  '# Choice fields (fields with a fixed value list)',
  'DECISION RULE — Choice vs Targeted KB: a "choice field" / "options" /',
  '"one of X/Y/Z" / "simple list" ask means a CHOICE — a minimal,',
  'field-owned value list. Build a full Targeted KB (an enum with',
  'sections / umbrellaText / per-value prose) ONLY when the change',
  'explicitly asks for per-value guidance or dynamic-context prompt',
  'adaptation ({{dc:...}}). Default is ALWAYS the minimal Choice.',
  'For a Choice, emit BOTH pieces:',
  '- The FieldDef with `type: "enum"` and `enumType: <enum id>`.',
  '- The owned EnumTypeDef appended to `agent.enums`:',
  '  `{ id: "enum_<random8>", name: "<fieldname>_choices", ownedByFieldId:',
  '  "<field id>", sections: [], values: [{ id: "enumval_<random8>",',
  '  value: "..." }, ...] }`. STRICTLY minimal: `sections` stays `[]`,',
  '  values carry ONLY `id` + `value` — no `umbrellaText`, no',
  '  `sectionTexts`. Adding those turns it into a Targeted KB, which was',
  '  not asked for. If `<fieldname>_choices` is already taken by ANOTHER',
  '  enum, suffix `2`, `3`, … NEVER encode the allowed values in',
  '  `howToExtract` prose instead of a bound enum.',
  '- Scope: unless the change explicitly says crew-scoped, put the',
  '  FieldDef on the AGENT (`agent.fields`) — one target, one call, and',
  '  `ownedByFieldId` is set correctly because you generate both ids.',
  '- Section contract: an agent-scoped choice field means returning TWO',
  '  complete sections in `changes` — `fields` AND `enums`.',
  '- Enums live ONLY on the agent body. A CREW-scoped choice field is a',
  '  two-target apply: the agent target (runs first) returns `enums` with',
  '  the new EnumTypeDef; the crew target returns `fields` with the',
  '  FieldDef. Never invent a `crew.enums` section.',
  '- BINDING RULE (critical): a FieldDef\'s `enumType` MUST be the id of',
  '  an enum that actually exists — either in the `enums` section YOU are',
  '  returning in this same call, or in the current/read-only agent body.',
  '  For a crew target, look the enum up BY NAME in the read-only agent',
  '  body (e.g. "gender_choices") and copy its `id` verbatim. NEVER make',
  '  up an enum id that exists nowhere — that renders as a broken',
  '  "(missing Targeted KB)" field and fails validation.',
  '- `ownedByFieldId`: set it only when the field and its enum are created',
  '  in the SAME agent-target call (you know the field id you generated).',
  '  For a crew-scoped field, OMIT `ownedByFieldId` — the enum is then a',
  '  regular shared enum, which is correct.',
  '- Deleting a choice field (or switching its type away from enum):',
  '  also remove its owned enum (`ownedByFieldId` === that field\'s id)',
  '  from `agent.enums` in the same apply — UNLESS another field\'s',
  '  `enumType` still references that enum, in which case leave it.',
  '- An existing enum WITHOUT `ownedByFieldId` is a shared enum — bind to',
  '  it (`enumType`) but never delete or rename it as part of field edits.',
  '',
  '# Live Brain panels (`agent.liveBrain`)',
  '- Live Brain panels live ONLY on the AGENT body at `liveBrain.panels[]`',
  '  (LiveBrainDef / BrainPanel in the types). They are NOT chain addons —',
  '  never add a panel to a crew\'s `addons[]` or to `agent.cortex`, and',
  '  never emit `pluginId: "live-brain-panel"` yourself.',
  '- New panel ids use the `panel_<random8>` format.',
  '- A `text`-source panel is plain token substitution (no LLM): just',
  '  `{ kind: "text", text }` with `{{...}}` tokens. Prefer it when the',
  '  value already exists in the brain.',
  '- A `prompt`-source panel needs ALL of: `prompt`, `model`, `history`,',
  '  and `trigger` (`{ kind: "every_n_messages", n }` or',
  '  `{ kind: "on_transition" }`).',
  '- The runtime validates AI answers strictly per `render`; a bad shape',
  '  hides the panel. Write panel prompts that spell out the exact JSON:',
  '  tags (predefined labels) → `{ "active": ["..."] }` · tags (generated)',
  '  → `{ "tags": [...], "active": [...] }` · fields (predefined keys) →',
  '  flat `{ "key": "value" }` · bars → flat `{ "label": <0-100> }` ·',
  '  cards → flat `{ "title": "body" }`. For `text`/`html` renders the',
  '  answer is a free string (html: inline styles, fragment only — the',
  '  runtime appends the fragment rules itself).',
  '',
  '# Profiler (`agent.profiler`)',
  '- The Profiler is a SECOND customer-facing surface (a live customer',
  '  profile beside the chat) that lives ONLY on the AGENT body at',
  '  `profiler` (ProfilerDef in the types): `{ panels, ask?, frame? }`.',
  '- `profiler.panels[]` follow the SAME rules as Live Brain panels',
  '  (sources, renders, filters, triggers, panel_<random8> ids, strict',
  '  shapes, never chain addons, never emit `pluginId:',
  '  "profiler-panel"`), PLUS two Profiler-only fields per panel:',
  '  `placement`: "header" (the pinned compact indicators strip — e.g. a',
  '  bars panel) or "body" (a normal section — the default; omit unless',
  '  header is wanted), and optional `description` (internal author',
  '  note, never shown to the customer).',
  '- NEW render `journey` (available to any panel): the prompt must ask',
  '  for flat JSON — status labels as key→value plus two reserved keys:',
  '  `{ "Current stage": "Trust building", "Missing": "…",',
  '  "readiness": <0-100>, "next": "one sentence" }`.',
  '- `profiler.ask` (Ask Profiler — natural-language Q&A over the',
  '  profile): `{ enabled, model, prompt, chips? }`. Only include it when',
  '  the change asks for it. `prompt` has a good server-side default —',
  '  emit `prompt: ""` unless the user explicitly authored one. `chips`',
  '  are preset one-tap questions (omit for the default set).',
  '- `profiler.frame`: `{ openMode: "third" | "half" | "full" }` —',
  '  default "third"; only set when asked.',
  '',
  '# Cross-entity refs',
  '- Field defs (FieldDef) can live EITHER on the agent body OR on a',
  '  crew body. A FieldExtractor inside a crew references field defs by',
  '  id via `config.extractsFields[]` — those ids may resolve into',
  '  `agent.fields[]` OR the owning `crew.fields[]`. BOTH ARE VALID.',
  '- If you receive a crew body and the change asks you to wire in a',
  '  field that already exists on the agent (visible in the read-only',
  '  agent body context), look up that field\'s id from `agent.fields[]`',
  '  and append it to the extractor\'s `extractsFields[]`. DO NOT',
  '  duplicate the FieldDef inside the crew.',
  '- If you receive a crew body and the change asks you to add a field',
  '  the agent doesn\'t have yet, create the FieldDef inside this',
  '  crew\'s `fields[]` and reference its id from the extractor.',
  '- If you receive an agent body, only modify `agent.fields[]` and the',
  '  other agent shell fields. The crews live elsewhere — leave them',
  '  alone. The wiring into a specific crew is a separate target the',
  '  caller handles.',
  '- The read-only agent body MUST NOT appear in your `changes` output',
  '  when the target is a crew — crew targets only ever return crew',
  '  sections.',
  '',
  '# TypeScript types (canonical source — verbatim from the client)',
  '',
  '```typescript',
  TYPES_SOURCE,
  '```',
  '',
  '# Prompt-template placeholders',
  '',
  'Tokens you can use inside `config.prompt` (NOT `promptTemplate` — that',
  'stays `"{{prompt}}"`). The runtime substitutes them at execution time.',
  'The JSON below is the source of truth — server prompt assembler, mention',
  'picker in the builder UI, and you all read the same file. Anything',
  'outside this list will NOT be substituted; it lands in the prompt as',
  'literal text.',
  '',
  '```json',
  PLACEHOLDER_SPEC_RAW || '{}',
  '```',
  '',
  '# Addon defaults — START FROM THESE when creating a new addon',
  '',
  'The descriptors below live in `aspect-agent-server/builder/addons/` and',
  'are the shared source of truth for both the React UI and you. When the',
  'user asks for a new addon, copy the matching fresh-template JSON and',
  'change ONLY the fields the user explicitly mentioned. Everything else',
  '(lane, enabled, outputType, context, promptTemplate, the defaults inside',
  'config) stays exactly as shown.',
  '',
  ADDON_TEMPLATES,
].join('\n');

/**
 * Tool definition forces structured output. `changes` carries ONLY the
 * changed top-level sections (each complete); the server merges them
 * over the current body. `reasoning` captures the model's intent in
 * one line so we can debug bad outputs without losing chain-of-thought.
 */
const SUBMIT_CHANGES_TOOL = {
  name: 'submit_changes',
  description:
    'Submit ONLY the top-level body sections you changed. Each key of ' +
    '`changes` is a section name (e.g. "parameters", "fields", "addons"); ' +
    'each value is that section\'s COMPLETE new content after the change. ' +
    'Sections you omit are preserved as-is by the server. ' +
    '`reasoning` is a one-line note describing what you changed.',
  input_schema: {
    type: 'object',
    properties: {
      changes: {
        type: 'object',
        description:
          'Map of changed section name → complete new section value. ' +
          'Only include sections the change touches.',
      },
      reasoning: {
        type: 'string',
        description: 'One-line note explaining what you did and any edge cases you handled.',
      },
    },
    required: ['changes'],
  },
};

/**
 * Generate a new body for one target.
 *
 * @param {object} args
 * @param {'agent' | 'crew'} args.entity
 * @param {string} args.entityId
 * @param {string} args.entityName        - for log/usage tracking
 * @param {object} args.currentBody        - AgentBody or CrewBody as-is
 * @param {string} args.whatToDo           - English description of the change
 * @param {object} [args.agentBodyContext] - For crew targets: the (latest,
 *                                           possibly post-patch) AgentBody
 *                                           for cross-entity field lookups.
 * @param {string} args.agentSlug          - for usage logging
 * @param {string} args.ownerUserId        - for usage logging
 * @param {number} [args.conversationId]   - for usage logging
 * @returns {Promise<{ newBody: object, tokens, durationMs }>}
 */
async function generatePatch({
  entity,
  entityId,
  entityName,
  currentBody,
  whatToDo,
  agentBodyContext,
  agentSlug,
  ownerUserId,
  conversationId,
}) {
  const start = Date.now();

  const sections = [
    '## Target',
    `entity: ${entity}`,
    `entityId: ${entityId}`,
    `entityName: ${entityName}`,
  ];

  if (entity === 'crew' && agentBodyContext) {
    sections.push(
      '',
      '## Agent body (READ-ONLY cross-reference — do not include in your output)',
      'Use this to look up field ids when wiring an agent-level field into',
      'this crew\'s extractor. If the field is already on the agent, reference',
      'its id from `agent.fields[]`; do not duplicate the FieldDef on the crew.',
      '```json',
      JSON.stringify(agentBodyContext, null, 2),
      '```',
    );
  }

  sections.push(
    '',
    `## Current ${entity === 'agent' ? 'AgentBody' : 'CrewBody'} (read it; return only the sections you change)`,
    '```json',
    JSON.stringify(currentBody, null, 2),
    '```',
    '',
    '## What to do',
    whatToDo,
    '',
    '## Task',
    'Call the submit_changes tool with ONLY the changed sections (each',
    'section complete). Sections you omit are preserved automatically.',
  );

  const userMessage = sections.join('\n');

  const result = await claudeService.sendOneShot(SYSTEM_PROMPT, userMessage, {
    model: MODEL,
    maxTokens: MAX_TOKENS,
    tools: [SUBMIT_CHANGES_TOOL],
    toolChoice: { type: 'tool', name: 'submit_changes' },
  });

  const usage = result?.usage || null;
  const durationMs = Date.now() - start;

  if (usage) {
    logUsage({
      process: PROCESS,
      model: MODEL,
      inputTokens:  usage.inputTokens  || 0,
      outputTokens: usage.outputTokens || 0,
      durationMs,
      agentName: agentSlug,
      conversationId: conversationId != null ? String(conversationId) : null,
      userId: ownerUserId,
    });
  }

  // The API guarantees a tool_use block thanks to forced tool_choice.
  // If the SDK somehow returned text instead, that's a structural bug
  // (model API change?), not a content issue — surface a clear error.
  if (!result || !result.toolUse || !result.toolUse.input) {
    throw new Error('Patch generator: forced tool_use returned no input.');
  }

  const changes = result.toolUse.input.changes;
  const reasoning = result.toolUse.input.reasoning || '';
  if (reasoning) {
    console.log(`[patch] ${entity} "${entityName}" reasoning: ${reasoning}`);
  }

  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new Error('Patch generator: submit_changes called without a valid `changes` object.');
  }

  const { next: newBody, applied, ignored } = mergeChanges(entity, currentBody, changes);
  if (ignored.length > 0) {
    console.warn(`[patch] ${entity} "${entityName}" ignored unknown sections: ${ignored.join(', ')}`);
  }
  if (applied.length === 0) {
    throw new Error(
      'Patch generator: submit_changes returned no recognized sections '
      + `(got: ${Object.keys(changes).join(', ') || 'nothing'}).`,
    );
  }
  console.log(`[patch] ${entity} "${entityName}" changed sections: ${applied.join(', ')}`);

  return {
    newBody,
    changedSections: applied,
    reasoning,
    tokens: usage
      ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.inputTokens + usage.outputTokens }
      : { input: 0, output: 0, total: 0 },
    durationMs,
  };
}

module.exports = { generatePatch, mergeChanges };
