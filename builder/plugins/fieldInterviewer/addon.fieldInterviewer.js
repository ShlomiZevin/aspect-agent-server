/**
 * Field Interviewer plugin — server-side.
 *
 * Hybrid of Field Reasoner (one bound field) and Thinker (free-form
 * strategic output for the Talker). One LLM call, two write
 * destinations:
 *
 *   - A key in the parsed JSON matching the bound field's name →
 *     field write (same path Field Reasoner uses).
 *   - Every OTHER top-level key → thinking write under
 *     `config.domain` (default `'interview'`), same routing as Thinker.
 *
 * The prompt teaches the LLM that convention once; everything else is
 * mechanical.
 *
 * Output: json-to-memory.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');
const descriptor = require('../../addons/fieldInterviewer.addon.json');

const FIELD_INTERVIEWER_PLUGIN_ID = descriptor.pluginId;

async function run(ctx) {
  const {
    instance,
    prompt,
    modelString,
    userMessage,
    conversationId,
    agentNameForLogs,
    ownerUserId,
    historyMessages,
    llm,
    usageProcess,
    usageCrew,
    extractorFields,
  } = ctx;

  const start = Date.now();
  const cfg = instance.config || {};
  // Empty string falls back to the default so users can't silently
  // collapse multiple Interviewers into the no-domain bucket by mistake.
  const domain = (typeof cfg.domain === 'string' && cfg.domain.trim()) ? cfg.domain.trim() : 'interview';

  const result = await llm.sendOneShot(prompt, userMessage, {
    model: modelString,
    jsonOutput: instance.outputType === 'json-to-memory',
    historyMessages,
    context: usageProcess,
    agentName: agentNameForLogs,
    crewMember: usageCrew,
    conversationId: String(conversationId),
    userId: ownerUserId,
  });
  const raw = typeof result === 'string' ? result : (result?.text || '');

  const { parsed, error } = parseOutput(instance.outputType || 'json-to-memory', raw);

  const memoryWrites = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const fields = Array.isArray(extractorFields) ? extractorFields : [];
    const boundNames = new Set(fields.map(f => f.name));
    // Bound-field writes — exact same shape Field Reasoner produces so
    // downstream (memory persistence, Dynamic Context resolution, etc.)
    // can't tell who wrote the value.
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(parsed, f.name)) {
        const value = parsed[f.name];
        if (value !== null && value !== undefined) {
          memoryWrites.push({ domain: f.domain || null, field: f.name, value });
        }
      }
    }
    // Everything else → thinking domain (Thinker shape).
    for (const [field, value] of Object.entries(parsed)) {
      if (boundNames.has(field)) continue;
      if (value === null || value === undefined) continue;
      memoryWrites.push({ kind: 'thinking', domain, field, value });
    }
  }

  return {
    rawOutput:    raw,
    parsedOutput: parsed,
    memoryWrites,
    parseError:   error || undefined,
    durationMs:   Date.now() - start,
    // sendOneShot logged exact token counts via llm.js.
    tokens:       { input: 0, output: 0, total: 0 },
  };
}

registerPlugin({
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  run,
});

module.exports = { FIELD_INTERVIEWER_PLUGIN_ID };
