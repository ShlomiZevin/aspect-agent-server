/**
 * Vibe Extractor plugin — server-side.
 *
 * Mechanically identical to Field Extractor: one-shot LLM call with
 * structured JSON output, parsed into per-field memory writes the
 * engine then persists.
 *
 * The distinction from Field Extractor is in the descriptor JSON —
 * different defaults (bigger model, longer history), `allowedFieldSources:
 * ['inferred']` so the field editor hides the "explicit" choice, and a
 * prompt + purpose tuned for reading soft signals (tone, mood, energy)
 * rather than capturing stated facts. The runtime is the same because
 * the OUTPUT shape is the same — both write structured fields to memory.
 *
 * Output: json-to-memory.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');
const descriptor = require('../../addons/vibeExtractor.addon.json');

const VIBE_EXTRACTOR_PLUGIN_ID = descriptor.pluginId;

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
    // Resolved field defs this extractor extracts — passed by the
    // engine, looked up from agent.fields ∪ owning crew.fields
    // against `instance.config.extractsFields`.
    extractorFields,
  } = ctx;

  const start = Date.now();
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

  // Same write semantics as Field Extractor: only emit keys whose
  // value isn't null/undefined. We don't filter empty strings or other
  // "looks empty" values on top of the LLM — that hides where bad
  // outputs come from (prompt or model). Tighten the prompt instead.
  const memoryWrites = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const fields = Array.isArray(extractorFields) ? extractorFields : [];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(parsed, f.name)) {
        const value = parsed[f.name];
        if (value !== null && value !== undefined) {
          memoryWrites.push({ domain: f.domain || null, field: f.name, value });
        }
      }
    }
  }

  return {
    rawOutput:    raw,
    parsedOutput: parsed,
    memoryWrites,
    parseError:   error || undefined,
    durationMs:   Date.now() - start,
    // sendOneShot already logged exact token counts via llm.js.
    tokens:       { input: 0, output: 0, total: 0 },
  };
}

registerPlugin({
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  run,
});

module.exports = { VIBE_EXTRACTOR_PLUGIN_ID };
