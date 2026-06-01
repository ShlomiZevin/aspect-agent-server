/**
 * Patch generator — Claude call #2 of the Apply flow.
 *
 * Given a current AgentBody/CrewBody + an English "what_to_do"
 * description, returns the FULL new body JSON. Server-side validation
 * happens after this call (bodyValidator.js).
 *
 * Output is locked to JSON via Anthropic forced tool_use: the model
 * MUST call the `submit_body` tool, whose `body` input is the new
 * body. The API itself prevents prose / preamble / leaked reasoning
 * — no text-extraction heuristics needed. A `reasoning` field on the
 * tool lets the model surface its thinking for debugging.
 *
 * Decision 52: full new body, not RFC 6902 patches.
 * Decision 55: schema reference is the hand-maintained
 *              docs/guides/BUILDER_V2_SCHEMA.md — embedded verbatim.
 */

const fs = require('fs');
const path = require('path');

const claudeService = require('../../services/llm.claude');
const { logUsage } = require('../../services/usageLogger');

const MODEL    = 'claude-sonnet-4-6';
const PROCESS  = 'alfred-apply-patch';
const MAX_TOKENS = 8192;

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
  'as READ-ONLY cross-reference. You submit the FULL NEW BODY via the',
  '`submit_body` tool. The tool\'s `body` field is the agent/crew after',
  'your change. The `reasoning` field is a one-line note explaining',
  'what you did (used for debugging when something goes wrong).',
  '',
  '# Body fidelity',
  '- PRESERVE every field that wasn\'t mentioned in the change. Field',
  '  order may differ but values must be intact.',
  '- The output MUST conform to the TypeScript types below. The types',
  '  are the canonical contract — the client compiles against them and',
  '  the runtime reads them. Pay attention to which fields are optional',
  '  vs required, the discriminated unions on `OutputType` and addon',
  '  configs by `pluginId`, and the comments — they describe invariants',
  '  the types alone can\'t express (e.g. "enum requires enumValues").',
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
  '- `context` only carries `history` (runtime conversation history, not',
  '  template text) and an optional `triggeredReads` array for the Triggered',
  '  Context addon. The pre-Phase-B flags `persona` / `memoryReads` /',
  '  `thinkingReads` are GONE — placement of those sections is now done by',
  '  dropping `{{persona}}` / `{{memory}}` / `{{thinking}}` (or the `:DOMAIN`',
  '  variants) into `config.prompt` wherever the user wants them to render.',
  '- Example: a Talker that greets a customer by name and references known',
  '  memory has `promptTemplate: "{{prompt}}"` and `config.prompt` like',
  '  `"{{persona}}\\n\\nHi {{field:customer_name}} — here\'s what we know:',
  '  {{memory:customer}}"`. NO `context.persona = true`, NO `memoryReads`.',
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
  '- The read-only agent body MUST NOT appear in your `body` output',
  '  when you are returning a crew body.',
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
 * Tool definition forces structured output. `body` is the new
 * AgentBody/CrewBody. `reasoning` captures the model's intent in one
 * line so we can debug bad outputs without losing chain-of-thought.
 */
const SUBMIT_BODY_TOOL = {
  name: 'submit_body',
  description:
    'Submit the FULL new agent/crew body after applying the change. ' +
    '`body` is the entire new body object (preserve untouched fields). ' +
    '`reasoning` is a one-line note describing what you changed.',
  input_schema: {
    type: 'object',
    properties: {
      body: {
        type: 'object',
        description: 'The full new AgentBody or CrewBody after the change.',
      },
      reasoning: {
        type: 'string',
        description: 'One-line note explaining what you did and any edge cases you handled.',
      },
    },
    required: ['body'],
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
    `## Current ${entity === 'agent' ? 'AgentBody' : 'CrewBody'} (the body to mutate and return)`,
    '```json',
    JSON.stringify(currentBody, null, 2),
    '```',
    '',
    '## What to do',
    whatToDo,
    '',
    '## Task',
    `Call the submit_body tool with the FULL new ${entity === 'agent' ? 'AgentBody' : 'CrewBody'}.`,
  );

  const userMessage = sections.join('\n');

  const result = await claudeService.sendOneShot(SYSTEM_PROMPT, userMessage, {
    model: MODEL,
    maxTokens: MAX_TOKENS,
    tools: [SUBMIT_BODY_TOOL],
    toolChoice: { type: 'tool', name: 'submit_body' },
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

  const newBody = result.toolUse.input.body;
  const reasoning = result.toolUse.input.reasoning || '';
  if (reasoning) {
    console.log(`[patch] ${entity} "${entityName}" reasoning: ${reasoning}`);
  }

  if (!newBody || typeof newBody !== 'object') {
    throw new Error('Patch generator: submit_body called without a valid `body` object.');
  }

  return {
    newBody,
    reasoning,
    tokens: usage
      ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.inputTokens + usage.outputTokens }
      : { input: 0, output: 0, total: 0 },
    durationMs,
  };
}

module.exports = { generatePatch };
