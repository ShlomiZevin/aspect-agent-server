/**
 * Builds the prompt context for brainstorm Alfred.
 *
 * Two pieces:
 *   1. A static-ish system prompt — Alfred's identity + the (P5.1)
 *      no-tools brainstorming policy.
 *   2. A human-readable summary of the current ProjectDoc — NO raw
 *      JSON, NO instanceIds, NO schema keys. Decision 58 in
 *      BUILDER_V2_ALFRED.md.
 *
 * Patch-generator Alfred (P5.2) will live in a sibling file and DOES
 * see the raw JSON. This file is brainstorm-only.
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
  'personas, propose crews, sketch field schemas, talk through transitions and',
  'edge cases. You see the current state of the project as a plain-English',
  'summary (not raw schema). Reason and reply in that same plain-English',
  'vocabulary: agents, crews, fields, addons (talkers, field extractors,',
  'transition routers).',
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
  '- Talk in plain human vocabulary about the agent — never describe the',
  '  current state with raw JSON or internal ids; use the agent / crew /',
  '  field / addon names.',
  '- Don\'t pretend you applied changes. You can\'t — yet. Discuss the change',
  '  with the user; they\'ll save edits manually for now.',
  '- For small edits (renaming, tweaking a Talker prompt, fixing a typo),',
  '  tell the user the easiest path is to do it themselves in the builder UI',
  '  — just hand over the new text. Mention they can use the "Validate & Log"',
  '  button next to Save when the change is significant.',
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

/** Format one field for the Alfred context dump. Enum-typed fields
 *  resolve their values via the agent's enum bible (`agent.enums`) —
 *  the values list lives there, not inline on the field. */
function fmtField(f, agentEnums) {
  const bits = [f.type];
  if (f.type === 'enum' && f.enumType && Array.isArray(agentEnums)) {
    const enumDef = agentEnums.find(e => e && e.id === f.enumType);
    const vals = enumDef && Array.isArray(enumDef.values)
      ? enumDef.values.map(v => v && v.value).filter(Boolean)
      : [];
    if (vals.length > 0) bits[0] = `enum ${enumDef.name}: ${vals.join('/')}`;
    else                 bits[0] = `enum (${enumDef ? enumDef.name : 'unbound'})`;
  }
  bits.push(f.source);
  const head = `- ${f.name} (${bits.join(', ')})`;
  const desc = (f.howToExtract || '').trim();
  return desc ? `${head}: ${desc}` : head;
}

/** Format the agent's enum bible as a compact briefing for Alfred. One
 *  block per enum: name + values + section schema + value-level umbrella
 *  / section bodies (truncated if very long). */
function fmtEnumBible(enums) {
  if (!Array.isArray(enums) || enums.length === 0) return '';
  const lines = ['Enums (bible):'];
  for (const e of enums) {
    if (!e || !e.name) continue;
    const sectionNames = (Array.isArray(e.sections) ? e.sections : [])
      .map(s => s && s.name).filter(Boolean);
    lines.push(`  ${e.name} {`);
    if (sectionNames.length > 0) lines.push(`    sections: ${sectionNames.join(', ')}`);
    for (const v of (Array.isArray(e.values) ? e.values : [])) {
      if (!v || !v.value) continue;
      lines.push(`    - ${v.value}`);
      const umb = (v.umbrellaText || '').trim();
      if (umb) lines.push(`        umbrella: ${truncate1Line(umb)}`);
      for (const sec of sectionNames) {
        const body = (v.sectionTexts && v.sectionTexts[sec] || '').trim();
        if (body) lines.push(`        ${sec}: ${truncate1Line(body)}`);
      }
    }
    lines.push('  }');
  }
  return lines.join('\n');
}

function truncate1Line(s) {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? oneLine.slice(0, 140) + '…' : oneLine;
}

function fmtAddon(a, crewFieldsById, agentFieldsById) {
  const pluginLabel = ({
    talker: 'Talker',
    'field-extractor': 'Field Extractor',
    'transition-router': 'Transition Router',
  })[a.pluginId] || a.pluginId;

  if (a.pluginId === 'field-extractor') {
    const name = (a.config && a.config.name) ? `"${a.config.name}"` : '';
    const fieldIds = (a.config && Array.isArray(a.config.extractsFields)) ? a.config.extractsFields : [];
    const fieldNames = fieldIds
      .map(id => (crewFieldsById[id] || agentFieldsById[id])?.name)
      .filter(Boolean);
    const extractsLine = fieldNames.length > 0
      ? `  (extracts: ${fieldNames.join(', ')})`
      : '  (extracts: nothing yet)';
    return `${pluginLabel}${name ? ' ' + name : ''}${extractsLine}`;
  }
  return pluginLabel;
}

/**
 * Render a multi-line block of free-text (a spec or persona) under a
 * heading with consistent indentation. No truncation — the user wrote
 * this and Alfred should see it verbatim.
 */
function fmtBlock(heading, text, indent) {
  const lines = [`${indent}${heading}:`];
  const body = String(text).split(/\r?\n/);
  for (const line of body) {
    lines.push(`${indent}  ${line}`);
  }
  return lines.join('\n');
}

function fmtCrew(crew, agent) {
  const lines = [];
  const isDefault = agent.defaultCrewId === crew.id;
  lines.push(`  ${crew.name || '(unnamed crew)'}${isDefault ? '  (default)' : ''}`);
  if (crew.description) lines.push(`    Description: ${crew.description}`);
  if (crew.spec)        lines.push(fmtBlock('Spec', crew.spec, '    '));
  if (crew.persona)     lines.push(fmtBlock('Persona', crew.persona, '    '));

  const crewFieldsById  = Object.fromEntries((crew.fields  || []).map(f => [f.id, f]));
  const agentFieldsById = Object.fromEntries((agent.fields || []).map(f => [f.id, f]));

  const mainAddons = (crew.addons || []).filter(a => (a.lane || 'main') === 'main' && a.enabled !== false);
  if (mainAddons.length > 0) {
    lines.push('    Addons (main lane):');
    mainAddons.forEach((a, i) => {
      lines.push(`      ${i + 1}. ${fmtAddon(a, crewFieldsById, agentFieldsById)}`);
    });
  } else {
    lines.push('    Addons: none yet');
  }

  if ((crew.fields || []).length > 0) {
    lines.push('    Crew fields:');
    crew.fields.forEach(f => lines.push('      ' + fmtField(f, agent.enums).replace(/^- /, '')));
  }
  return lines.join('\n');
}

function fmtAgent(agent) {
  const lines = [];
  lines.push(`Agent: ${agent.name || agent.slug}  (slug: ${agent.slug})`);
  if (agent.persona) lines.push(fmtBlock('Persona', agent.persona, '  '));
  if (agent.spec)    lines.push(fmtBlock('Spec', agent.spec, '  '));

  if ((agent.fields || []).length > 0) {
    lines.push('');
    lines.push('  Agent fields:');
    agent.fields.forEach(f => lines.push('    ' + fmtField(f, agent.enums).replace(/^- /, '')));
  }

  if (Array.isArray(agent.enums) && agent.enums.length > 0) {
    lines.push('');
    const bible = fmtEnumBible(agent.enums);
    if (bible) lines.push('  ' + bible.split('\n').join('\n  '));
  }

  if ((agent.crews || []).length > 0) {
    lines.push('');
    lines.push('  Crews:');
    agent.crews.forEach(c => lines.push(fmtCrew(c, agent)));
  } else {
    lines.push('');
    lines.push('  Crews: none yet');
  }
  return lines.join('\n');
}

function fmtProject(project) {
  const lines = [];
  lines.push(`Project: ${project.name || '(unnamed)'}`);
  if (project.spec) lines.push(fmtBlock('Spec', project.spec, '  '));
  lines.push('');
  (project.agents || []).forEach(a => lines.push(fmtAgent(a)));
  return lines.join('\n');
}

/**
 * Produce the human-readable summary for the current project (by
 * slug + owner). Returns the string Alfred will see — or a short
 * placeholder if the project doesn't exist yet.
 */
async function buildProjectSummary({ agentSlug, ownerUserId }) {
  const project = await hydrateProject({ agentSlug, ownerUserId });
  if (!project) {
    return `No project found for slug "${agentSlug}". The user hasn't bootstrapped the builder yet.`;
  }
  return fmtProject(project);
}

module.exports = {
  SYSTEM_PROMPT,
  buildProjectSummary,
};
