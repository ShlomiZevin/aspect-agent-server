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

const { hydrateProject } = require('../../builder/services/builderProjects');

const SYSTEM_PROMPT = [
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

function fmtField(f) {
  const bits = [f.type];
  if (f.type === 'enum' && Array.isArray(f.enumValues) && f.enumValues.length > 0) {
    bits[0] = `enum: ${f.enumValues.join('/')}`;
  }
  bits.push(f.source);
  const head = `- ${f.name} (${bits.join(', ')})`;
  const desc = (f.howToExtract || '').trim();
  return desc ? `${head}: ${desc}` : head;
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

function fmtCrew(crew, agent) {
  const lines = [];
  const isDefault = agent.defaultCrewId === crew.id;
  lines.push(`  ${crew.name || '(unnamed crew)'}${isDefault ? '  (default)' : ''}`);
  if (crew.description) lines.push(`    Description: ${crew.description}`);
  if (crew.spec)        lines.push(`    Spec: ${crew.spec.replace(/\n+/g, ' ').slice(0, 200)}`);

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
    crew.fields.forEach(f => lines.push('      ' + fmtField(f).replace(/^- /, '')));
  }
  return lines.join('\n');
}

function fmtAgent(agent) {
  const lines = [];
  lines.push(`Agent: ${agent.name || agent.slug}  (slug: ${agent.slug})`);
  if (agent.persona) lines.push(`  Persona: ${agent.persona.replace(/\n+/g, ' ').slice(0, 300)}`);
  if (agent.spec)    lines.push(`  Spec: ${agent.spec.replace(/\n+/g, ' ').slice(0, 300)}`);

  if ((agent.fields || []).length > 0) {
    lines.push('');
    lines.push('  Agent fields:');
    agent.fields.forEach(f => lines.push('    ' + fmtField(f).replace(/^- /, '')));
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
  if (project.spec) lines.push(`  Spec: ${project.spec.replace(/\n+/g, ' ').slice(0, 400)}`);
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
