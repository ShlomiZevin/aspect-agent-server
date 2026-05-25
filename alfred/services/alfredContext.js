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
  'summary (not JSON). Always reason and reply in that same plain-English',
  'vocabulary: agents, crews, fields, addons (talkers, field extractors,',
  'transition routers).',
  '',
  'Rules of engagement:',
  '- English only. Never write JSON, schema keys, or internal ids.',
  '- Don\'t pretend you applied changes. You can\'t — yet. Discuss the',
  '  change with the user; they\'ll save edits manually for now.',
  '- Be concrete. When suggesting a field, give a name, type, source',
  '  (explicit / inferred), and a one-line "how to extract" guide.',
  '  When suggesting a crew, give a name + what it\'s for + which',
  '  addons it should have.',
  '- Be terse. The builder UI is already noisy; don\'t pad answers.',
  '- If the user is just thinking out loud, think out loud with them.',
  '  No need to converge on a proposal every turn.',
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
