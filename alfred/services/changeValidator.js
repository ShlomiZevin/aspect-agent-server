/**
 * Change validator — confirms a user-supplied "what I changed" claim
 * actually shows up in the diff between body_before and body_after.
 *
 * Used by the "Validate & Log" button next to Save / ⭐ Set as active.
 * The user makes a manual edit, saves, then opens the log dialog and
 * types what they changed. The server compares the two body snapshots
 * via Claude and returns whether the claim matches the diff.
 *
 * Why an LLM call: a diff-as-strings comparison is trivial but doesn't
 * answer "did the user do what they say they did?" — that requires
 * reading both bodies semantically. Cheap (~$0.001-0.005 per validation).
 */

const claudeService = require('../../services/llm.claude');
const { logUsage } = require('../../services/usageLogger');

const MODEL    = 'claude-sonnet-4-6';
const PROCESS  = 'alfred-change-validate';

const SYSTEM_PROMPT = [
  'You are the change-validator for the Aspect agent builder.',
  '',
  'You are given:',
  '  - a JSON body BEFORE the user\'s edit (an `agent` or `crew` body)',
  '  - the JSON body AFTER the user\'s edit',
  '  - a one-line English claim of what the user says they changed',
  '',
  'Decide whether the claim accurately describes the diff. Return JSON:',
  '',
  '{',
  '  "matches": "yes" | "partial" | "no",',
  '  "note": string   // one-line explanation, shown to the user',
  '}',
  '',
  '- "yes"     — the diff shows exactly what the user claims (no more,',
  '              no less worth flagging).',
  '- "partial" — the diff shows something related, but the description',
  '              misses or mischaracterises part of it. Note what\'s off.',
  '- "no"      — the diff doesn\'t reflect the claim at all (or there\'s',
  '              no diff). Note what\'s actually different.',
  '',
  'Output JSON only. No fences, no prose.',
].join('\n');

/**
 * Tolerant JSON extractor — same shape as the consolidator's. The
 * validator emits a small flat `{ matches, note }` object, but the
 * model occasionally leaks reasoning before the JSON; this absorbs it.
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
 * @param {object} args
 * @param {object} args.bodyBefore
 * @param {object} args.bodyAfter
 * @param {string} args.claim
 * @param {'agent' | 'crew'} args.entity
 * @param {string} args.agentSlug
 * @param {string} args.ownerUserId
 */
async function validateClaim({ bodyBefore, bodyAfter, claim, entity, agentSlug, ownerUserId }) {
  const start = Date.now();

  const userMessage = [
    `## Entity: ${entity}`,
    '',
    '## Body BEFORE',
    '```json',
    JSON.stringify(bodyBefore, null, 2),
    '```',
    '',
    '## Body AFTER',
    '```json',
    JSON.stringify(bodyAfter, null, 2),
    '```',
    '',
    '## User\'s claim',
    claim,
    '',
    '## Task',
    'Decide whether the claim matches the diff. Output JSON.',
  ].join('\n');

  const result = await claudeService.sendOneShot(SYSTEM_PROMPT, userMessage, {
    model: MODEL,
    maxTokens: 512,
    jsonOutput: true,
  });

  const text  = (result && typeof result === 'object' && 'text'  in result) ? result.text  : result;
  const usage = (result && typeof result === 'object' && 'usage' in result) ? result.usage : null;
  const durationMs = Date.now() - start;

  if (usage) {
    logUsage({
      process: PROCESS,
      model:   MODEL,
      inputTokens:  usage.inputTokens  || 0,
      outputTokens: usage.outputTokens || 0,
      durationMs,
      agentName: agentSlug,
      userId:    ownerUserId,
    });
  }

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (err) {
    console.error('[validate] unparseable JSON:', text.slice(0, 300));
    return { matches: 'no', note: 'Validation failed: the validator returned malformed output. Try again.' };
  }

  const matches = (['yes', 'partial', 'no'].includes(parsed.matches)) ? parsed.matches : 'no';
  const note    = typeof parsed.note === 'string' ? parsed.note.trim() : '';
  return { matches, note };
}

module.exports = { validateClaim };
