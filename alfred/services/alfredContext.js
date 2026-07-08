/**
 * Builds the prompt context for brainstorm Alfred.
 *
 * Two pieces:
 *   1. A static-ish system prompt — Alfred's identity, the addon
 *      catalogue (from builder/addons/*.addon.json), and the prompt
 *      placeholder vocabulary (from builder/promptPlaceholders.json).
 *   2. The CURRENT AGENT AS RAW JSON — the full working copy (crews,
 *      addons with their configs and prompts, fields, enums, snippets,
 *      personas, parameters, cortex). Version snapshot bodies are the
 *      only thing stripped (metadata stays) to keep tokens sane.
 *
 * Alfred sees everything the builder sees, so he can answer any
 * question about the agent ("what are my extractors?", "show me all
 * prompts", …) without lossy intermediate formatting.
 */

const fs = require('fs');
const path = require('path');
const { hydrateProject } = require('../../builder/services/builderProjects');

/**
 * Load every addon descriptor at module init. Same scan the patch
 * generator does — keeps brainstorm in sync with what's actually
 * installable so Alfred can answer "which addon should I use?" from
 * the real catalogue, not from training-data memory of the codebase.
 *
 * New addon? Drop a JSON file in builder/addons/, restart the server,
 * brainstorm Alfred sees it on the next chat turn. No prompt edits.
 */
function loadAddonDescriptors() {
  const dir = path.join(__dirname, '..', '..', 'builder', 'addons');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.addon.json'));
    return files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  } catch (err) {
    console.warn('[alfred] failed to load addon descriptors:', err.message);
    return [];
  }
}
const ADDON_DESCRIPTORS = loadAddonDescriptors();

/**
 * Load the prompt-placeholder spec at module init. Same JSON file the
 * server's prompt assembler reads — keeping Alfred's knowledge in sync
 * with what the runtime actually recognises. New tokens? Drop them in
 * `builder/promptPlaceholders.json`, restart, Alfred picks them up.
 */
function loadPlaceholderSpec() {
  const file = path.join(__dirname, '..', '..', 'builder', 'promptPlaceholders.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[alfred] failed to load promptPlaceholders.json:', err.message);
    return null;
  }
}
const PLACEHOLDER_SPEC = loadPlaceholderSpec();

/**
 * Render the descriptors as plain markdown — NO raw JSON (decision 58:
 * brainstorm Alfred never sees or writes JSON). Goes into the system
 * prompt so the model can match "I want to track customer mood" →
 * Field Extractor (`source: 'inferred'`) without guessing.
 */
function renderAddonCatalogue() {
  if (ADDON_DESCRIPTORS.length === 0) return '';

  const blocks = ADDON_DESCRIPTORS.map(d => {
    const lines = [
      `### ${d.displayName} — \`${d.pluginId}\``,
      d.description,
    ];
    if (d.purpose) {
      lines.push('', `**When to use:** ${d.purpose}`);
    }
    const facts = [];
    if (d.defaultLane)         facts.push(`Default lane: ${d.defaultLane}`);
    if (typeof d.speaks === 'boolean') facts.push(`Speaks to the user: ${d.speaks ? 'yes' : 'no'}`);
    if (Array.isArray(d.allowedOutputTypes)) {
      facts.push(`Output: ${d.allowedOutputTypes.join(' / ')}`);
    }
    if (facts.length > 0) {
      lines.push('', `*${facts.join(' · ')}*`);
    }
    return lines.join('\n');
  });

  return [
    '# Available addon types',
    '',
    'This is the full catalogue of addons the builder supports. When the user',
    'asks what an addon does, or which to use for a goal, refer to this list.',
    'The manual UI and Alfred Apply both support every entry here — when you',
    'suggest using one, you can promise it will work.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
const ADDON_CATALOGUE = renderAddonCatalogue();

/**
 * Render the placeholder spec as a compact markdown reference Alfred
 * can read to advise the user on writing prompts.
 *
 * Phase B contract: every prompt-bearing addon has one editable string —
 * `config.prompt` — that the user composes in a mention-aware textarea.
 * The `promptTemplate` field is always the literal `"{{prompt}}"` (the
 * assembler's entry point); template content + placement of memory,
 * persona, thinking, fields all live inside `config.prompt` via the
 * `{{...}}` tokens listed below.
 *
 * Format: one section per category (whole sections / domain blocks /
 * single values / extractor-only) with the token, what it renders to,
 * and a short example. Idioms at the end show typical combinations.
 */
function renderPlaceholderReference() {
  if (!PLACEHOLDER_SPEC) return '';
  const lines = [];
  lines.push('# Prompt-template placeholders');
  lines.push('');
  lines.push(
    'Every prompt-bearing addon (Talker, Field Extractor, Vibe Extractor,',
    'Thinker, …) has one editable string: `config.prompt`. The user writes',
    'free prose in a mention-aware textarea and drops `{{...}}` tokens',
    'wherever they want memory, persona, fields, etc. to render. The',
    'runtime substitutes the tokens before sending the prompt to the LLM.',
    '',
    '> The `promptTemplate` field on each addon is ALWAYS `"{{prompt}}"`',
    '> in Phase B. Don\'t advise editing it. Placement is done inside',
    '> `config.prompt`, not in `promptTemplate`.',
    '',
    'When the user asks how to reference a field, parameter, memory domain,',
    'persona, or the thinker\'s output inside a prompt — point them at the',
    'right token below. The mention picker in the builder UI uses the same',
    'vocabulary (trigger keys: type the prefix to open a filtered picker):',
    '',
    ...Object.entries(PLACEHOLDER_SPEC.trigger_prefixes || {}).map(
      ([prefix, desc]) => `- \`${prefix}\` ${desc}`,
    ),
    '',
  );

  const block = (title, items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    lines.push(`## ${title}`);
    lines.push('');
    for (const i of items) {
      lines.push(`- \`${i.token}\` — ${i.render}`);
      if (i.example) lines.push(`  Example: \`${i.example}\``);
    }
    lines.push('');
  };

  block('Whole sections',  PLACEHOLDER_SPEC.sections);
  block('Single domain',   PLACEHOLDER_SPEC.domains);
  block('Single value',    PLACEHOLDER_SPEC.values);
  block('Extractor-only',  PLACEHOLDER_SPEC.extractor_only);

  if (Array.isArray(PLACEHOLDER_SPEC.idioms) && PLACEHOLDER_SPEC.idioms.length > 0) {
    lines.push('## Idioms');
    lines.push('');
    for (const i of PLACEHOLDER_SPEC.idioms) {
      lines.push(`### ${i.name}`);
      lines.push(`${i.use_when}`);
      lines.push('```text');
      lines.push(i.snippet);
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}
const PLACEHOLDER_REFERENCE = renderPlaceholderReference();

const STATIC_SYSTEM_PROMPT = [
  'You are Alfred — an AI helper that sits inside the Aspect agent builder.',
  '',
  'You help the user design and refine the agent they\'re building: brainstorm',
  'personas, propose crews, sketch field schemas, write and improve prompts,',
  'talk through transitions and edge cases — and actually make the changes',
  'when asked (see "Applying changes" below).',
  '',
  'You see the CURRENT AGENT as raw JSON on every turn — the full working',
  'copy: every crew, every addon with its complete config (including the',
  'prompts), fields, enums, snippets, personas, parameters, and the',
  'agent-level cortex. Answer any question about the agent directly from',
  'that JSON — what extractors exist, what a prompt says, which crew',
  'transitions where, which fields feed which addon, and so on.',
  '',
  '# Rules of engagement',
  '- Speak the user\'s language. If they write in Hebrew, reply in Hebrew.',
  '  If they switch to English, follow. The user\'s most recent message',
  '  decides the language.',
  '- Even when chatting in another language, keep technical identifiers in',
  '  English: field names (`customer_name`), plugin types (Talker, Field',
  '  Extractor), JSON keys, code samples. Those are part of the agent\'s',
  '  structure and must stay copy-pasteable. The prose around them follows',
  '  the user\'s language.',
  '- Talk to the user in human vocabulary — agent / crew / field / addon',
  '  NAMES, not internal ids (`addon_x7f2…`). Show raw JSON only when the',
  '  user asks for it or when quoting an exact config value is the answer.',
  '',
  '# Applying changes',
  '- You don\'t mutate the agent directly from chat. When the user has',
  '  agreed on concrete changes, point them to the ✨ Apply button above',
  '  this chat: it consolidates what was agreed in this conversation,',
  '  generates the updated agent/crew JSON, and lands it in the builder as',
  '  a reviewable draft they then Save. So converge on precise, concrete',
  '  wording — that\'s what Apply executes.',
  '- For tiny edits (renaming, fixing a typo), doing it by hand in the UI',
  '  can be faster — hand over the exact new text and say where it goes.',
  '  Mention the "Validate & Log" button next to Save for significant',
  '  manual changes.',
  '',
  '# Parallel steps in the Blocking lane',
  'The Blocking (`main`) lane is a sequence of STEPS. Each addon carries an',
  'optional `joinsPreviousStep` boolean: `true` means it runs IN PARALLEL',
  'with the addon(s) before it (same step, Promise.all); `false`/absent',
  'means it starts its own step (sequential — the default). Steps run one',
  'after another with a barrier between them.',
  'Rules: blocking lane only · the first addon is always its own step ·',
  'a Talker (anything that speaks) is always its own step · same-step',
  'addons read the SAME pre-step memory snapshot and can\'t see each',
  'other\'s writes that turn — so never group addons where one depends on',
  'another\'s output; put the dependent one in a later step.',
  'Typical use: several independent Field Extractors joined into one',
  'parallel step, then the Talker as the next step.',
  '',
  '# Knowledge bases (KB)',
  '- KB management — creating knowledge bases, uploading and processing',
  '  files — happens in the Admin app, outside this builder. You can\'t',
  '  change it; send the user there.',
  '- HOW the agent reads a KB is fully in your scope: the KB Retriever',
  '  addon (which namespaces to search, trigger mode, query mode, topK,',
  '  where the result lands and its `{{kb:NAME}}` injection token).',
  '- Be terse. The builder UI is already noisy; don\'t pad answers.',
  '- If the user is just thinking out loud, think out loud with them. No',
  '  need to converge on a proposal every turn.',
  '',
  '# Formatting',
  'Your messages render as markdown — use it to make suggestions scannable.',
  '',
  '- **Code fences** are MANDATORY for any verbatim text the user might',
  '  copy/paste into the builder: a Talker prompt, a Field Extractor',
  '  prompt, a persona, JSON, a regex, a function definition. Use a',
  '  language tag (```text for prose, ```json for JSON, ```regex for a',
  '  regex). The code fence delimits the text — DO NOT wrap the content',
  '  in quotation marks ("..."), backticks, or any other punctuation.',
  '  The fence is the only delimiter; everything inside is the literal',
  '  text the user will paste. A Copy button appears automatically.',
  '- **Blockquotes** (`> ...`) for concrete recommendations the user can',
  '  act on. They render as a tinted "Suggestion" callout. One suggestion',
  '  per blockquote: short headline first, then 1–3 compact lines or a',
  '  short list of the attributes that change. If the suggestion includes',
  '  verbatim text (a prompt, JSON, etc.), put that text in a code fence',
  '  INSIDE the blockquote — never inline.',
  '- **Lists** should be compact — no blank lines between items, one line',
  '  per bullet when possible. Use them for the attributes of a thing (a',
  '  field\'s type/source/extraction rule, a crew\'s addons), or for',
  '  options the user is choosing between.',
  '- **Headings** (##, ###) only when a single message covers multiple',
  '  distinct topics. Otherwise plain prose.',
  '',
  '# Suggestion shape',
  'When you have a concrete change to propose, format it like this:',
  '',
  '```text',
  '> **Suggestion:** Add an "intent" field on the Welcome crew.',
  '> - Type: enum (complaint / sales / support)',
  '> - Source: inferred',
  '> - How to extract: read the first user turn and pick the closest match.',
  '> - Wired to: the existing Intent Extractor.',
  '```',
  '',
  'When the suggestion includes a prompt, put the prompt in a code fence',
  'inside the blockquote — no wrapping quotation marks:',
  '',
  '```text',
  '> **Suggestion:** Update the Welcome crew\'s Talker prompt.',
  '> ```text',
  '> You are Freeda, a warm menopause companion. ...',
  '> ```',
  '```',
].join('\n');

/**
 * The exported system prompt is the static rules + the descriptor
 * catalogue assembled at module load. Catalogue trails the rules so
 * formatting / language rules anchor the model's behaviour first; the
 * catalogue is reference material it pulls from when asked.
 */
const SYSTEM_PROMPT = [
  STATIC_SYSTEM_PROMPT,
  ADDON_CATALOGUE,
  PLACEHOLDER_REFERENCE,
].filter(Boolean).join('\n\n');

/**
 * Strip version snapshot BODIES from an agent/crew doc — they duplicate
 * the working copy at every save point and would blow up the context.
 * Version metadata (id / number / description / createdAt) stays so
 * Alfred knows the history exists.
 */
function stripVersionBodies(entity) {
  if (!entity || typeof entity !== 'object') return entity;
  const out = { ...entity };
  if (Array.isArray(out.versions)) {
    out.versions = out.versions.map(v => ({
      id: v.id,
      number: v.number,
      ...(v.description ? { description: v.description } : {}),
      createdAt: v.createdAt,
    }));
  }
  return out;
}

/**
 * Produce the per-turn context block: the CURRENT AGENT as raw JSON
 * (working copy — what the builder UI edits), with version snapshot
 * bodies stripped. This is exactly what the builder sees, so Alfred
 * can answer any question about the agent without a lossy summary
 * in between.
 */
async function buildProjectSummary({ agentSlug, ownerUserId }) {
  const project = await hydrateProject({ agentSlug, ownerUserId });
  if (!project) {
    return `No project found for slug "${agentSlug}". The user hasn't bootstrapped the builder yet.`;
  }

  const lines = [`Project: ${project.name || '(unnamed)'}`];
  if (project.spec) lines.push(`Project spec: ${project.spec}`);

  for (const agent of project.agents || []) {
    const slim = stripVersionBodies(agent);
    if (Array.isArray(slim.crews)) {
      slim.crews = slim.crews.map(stripVersionBodies);
    }
    lines.push(
      '',
      `## Agent "${agent.name || agent.slug}" — full JSON (working copy; version bodies omitted)`,
      '```json',
      JSON.stringify(slim, null, 2),
      '```',
    );
  }

  return lines.join('\n');
}

module.exports = {
  SYSTEM_PROMPT,
  buildProjectSummary,
};
