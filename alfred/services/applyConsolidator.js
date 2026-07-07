/**
 * Apply consolidator — Claude call #1 of the Apply flow.
 *
 * Reads the brainstorm chat history + the current project summary,
 * and returns a structured "plan" of what to change, filtering out
 * any suggestions the user rejected during the conversation.
 *
 * Why a separate call from the patch generator (decision 51):
 *   - Patch generator works on one body at a time and produces JSON.
 *     Consolidator works on the whole conversation and produces an
 *     English plan with multiple targets.
 *   - Different failure modes: consolidator errors are "I couldn't
 *     understand what you agreed on" (surface to user as text);
 *     patch generator errors are "the JSON I produced is malformed"
 *     (surface as "try again with this body").
 *   - Different cost profiles: consolidator is small; patch generator
 *     embeds the schema doc and runs once per target.
 *
 * Output shape:
 *   {
 *     summary:     string,    // one-line headline shown in the preview modal
 *     description: string,    // editable English plan covering all targets
 *     targets: [
 *       { entity: 'agent' | 'crew',
 *         entityId: string,        // resolved against current project
 *         entityName: string,      // snapshot for the log + display
 *         what_to_do: string       // passed verbatim to patch generator
 *       },
 *       ...
 *     ]
 *   }
 */

const claudeService = require('../../services/llm.claude');
const { logUsage } = require('../../services/usageLogger');
const { buildProjectSummary } = require('./alfredContext');
const alfredChats = require('./alfredChats');
const { hydrateProject } = require('../../builder/services/builderProjects');

const MODEL    = 'claude-sonnet-4-6';
const PROCESS  = 'alfred-apply-consolidator';
const HISTORY_TURNS = 20;

const SYSTEM_PROMPT = [
  'You are the apply-consolidator for the Aspect agent builder.',
  '',
  'Your job: read the Alfred brainstorm transcript and the current',
  'project state, and produce a structured PLAN of what changes the',
  'user has agreed to make. Filter out anything they rejected, asked',
  'to skip, or never confirmed.',
  '',
  '# What you receive',
  '- The current agent state as raw JSON (entity ids included — agent id,',
  '  crew ids). Pick `entityId` values directly from it.',
  '- The most recent N turns of the Alfred brainstorm conversation.',
  '',
  '# What you produce',
  'A single JSON object with this exact shape — and nothing else (no',
  'markdown fences, no commentary):',
  '',
  '{',
  '  "summary":     string,   // one-line headline ("Add intent field on agent + wire into Welcome crew")',
  '  "description": string,   // multi-line English plan, editable by the user',
  '  "targets": [',
  '    {',
  '      "entity":     "agent" | "crew",',
  '      "entityId":   string,   // pick from the ids listed in the project state',
  '      "entityName": string,   // the entity\'s display name (agent slug or crew name)',
  '      "what_to_do": string    // body-specific change description',
  '    }',
  '  ]',
  '}',
  '',
  '# Rules',
  '- ONLY include changes the user has clearly agreed to. If a suggestion',
  '  was made but the user said "no" / "skip" / "not now" / "let\'s think',
  '  about it" → exclude it.',
  '- A single conversation can touch multiple targets (agent body + one',
  '  or more crew bodies). One target per body that needs changing.',
  '- entityId MUST match an id present in the project state. Never invent',
  '  ids.',
  '- what_to_do is the prose handed to the patch generator. Be precise',
  '  about field names, types, addon settings — that\'s what the patch',
  '  generator will translate into JSON.',
  '- If NOTHING was agreed to, return targets: [] and put a short note',
  '  in `description` (e.g. "No concrete changes were agreed on yet.").',
  '- Output JSON only. No markdown. No prose around it.',
].join('\n');

function formatHistory(messages) {
  return messages.map(m => `### ${m.role.toUpperCase()}\n${m.content}`).join('\n\n');
}

/**
 * Tolerant JSON extractor. The consolidator stays on the text path
 * (rather than forced tool_use) because we want it free to reason in
 * prose when the conversation is ambiguous. The model sometimes leaks
 * that reasoning before committing to JSON — this parser handles it.
 *
 * Order of attempts:
 *   1. ```json fenced block.
 *   2. Direct parse (model behaved).
 *   3. First balanced { ... } block in the response.
 */
function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const inner = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(inner);
  }
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  const start = trimmed.indexOf('{');
  if (start === -1) throw new Error('Response contained no JSON object.');
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\')      escape = true;
      else if (c === '"')  inString = false;
      continue;
    }
    if (c === '"')      inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('Unbalanced JSON object in response.');
  return JSON.parse(trimmed.slice(start, end + 1));
}

/**
 * Resolve a target's entityId against the live project, enriching
 * with the current entityName. If the id is bogus, drop the target
 * with a warning rather than crashing the whole apply.
 */
function resolveTargets(planTargets, project) {
  const agent = project.agents[0];
  if (!agent) return [];

  const out = [];
  for (const t of planTargets) {
    if (t.entity === 'agent') {
      // Agent target — the id must match the project's agent.
      if (t.entityId !== agent.id) {
        console.warn('[apply] unknown agent id in plan:', t.entityId);
        continue;
      }
      out.push({
        entity:     'agent',
        entityId:   agent.id,
        entityName: agent.name || agent.slug,
        what_to_do: String(t.what_to_do || '').trim(),
      });
    } else if (t.entity === 'crew') {
      const crew = agent.crews.find(c => c.id === t.entityId);
      if (!crew) {
        console.warn('[apply] unknown crew id in plan:', t.entityId);
        continue;
      }
      out.push({
        entity:     'crew',
        entityId:   crew.id,
        entityName: crew.name || `(crew ${crew.id})`,
        what_to_do: String(t.what_to_do || '').trim(),
      });
    }
  }
  return out;
}

/**
 * Run the consolidator.
 *
 * @param {object} args
 * @param {number} args.chatId
 * @param {string} args.agentSlug
 * @param {string} args.ownerUserId
 * @returns {Promise<{ summary, description, targets, tokens, durationMs }>}
 */
async function consolidate({ chatId, agentSlug, ownerUserId }) {
  const start = Date.now();

  // 1. Recent chat history.
  const history = (await alfredChats.listMessages(chatId)).slice(-HISTORY_TURNS);
  if (history.length === 0) {
    throw new Error('No chat history to apply from.');
  }

  // 2. Current project state, both as a human summary (for the LLM's
  //    reasoning) AND as the live hydrated doc (for id resolution).
  const project = await hydrateProject({ agentSlug, ownerUserId });
  if (!project) {
    throw new Error(`No project found for slug "${agentSlug}".`);
  }
  const projectSummary = await buildProjectSummary({ agentSlug, ownerUserId });

  // Also include each entity's id alongside its name in a small
  // reference block so the LLM can pick correct ids without us
  // leaking JSON into the brainstorm context.
  const agent = project.agents[0];
  const idTable = [
    'Use these ids when filling in the `entityId` field — do not invent new ones:',
    `- agent: "${agent.id}" (slug ${agent.slug})`,
    ...agent.crews.map(c => `- crew: "${c.id}" (name ${c.name || '(unnamed)'})`),
  ].join('\n');

  const userMessage = [
    '## Current project',
    projectSummary,
    '',
    '## Entity ids',
    idTable,
    '',
    '## Alfred brainstorm transcript (most recent first turns last)',
    formatHistory(history),
    '',
    '## Task',
    'Produce the JSON plan covering everything the user agreed to. JSON only.',
  ].join('\n');

  // 3. One-shot Claude call with jsonOutput hint.
  const result = await claudeService.sendOneShot(SYSTEM_PROMPT, userMessage, {
    model: MODEL,
    maxTokens: 2048,
    jsonOutput: true,
  });

  const text = (result && typeof result === 'object' && 'text' in result) ? result.text : result;
  const usage = (result && typeof result === 'object' && 'usage' in result) ? result.usage : null;
  const durationMs = Date.now() - start;

  // Log usage.
  if (usage) {
    logUsage({
      process: PROCESS,
      model: MODEL,
      inputTokens:  usage.inputTokens  || 0,
      outputTokens: usage.outputTokens || 0,
      durationMs,
      agentName: agentSlug,
      conversationId: String(chatId),
      userId: ownerUserId,
    });
  }

  // 4. Parse the JSON.
  let plan;
  try {
    plan = extractJson(text);
  } catch (err) {
    console.error('[apply] consolidator returned unparseable JSON:', text.slice(0, 500));
    throw new Error('Consolidator returned malformed JSON — try again.');
  }

  if (typeof plan !== 'object' || plan === null) {
    throw new Error('Consolidator output was not an object.');
  }

  const targets = resolveTargets(Array.isArray(plan.targets) ? plan.targets : [], project);

  return {
    summary:     String(plan.summary     || '').trim(),
    description: String(plan.description || '').trim(),
    targets,
    tokens:      usage
      ? { input: usage.inputTokens, output: usage.outputTokens, total: usage.inputTokens + usage.outputTokens }
      : { input: 0, output: 0, total: 0 },
    durationMs,
  };
}

module.exports = { consolidate };
