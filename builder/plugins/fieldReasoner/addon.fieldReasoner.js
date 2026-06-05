/**
 * Field Reasoner plugin — server-side.
 *
 * Mechanically the same as Field Extractor / Vibe Extractor: one-shot
 * LLM call with structured JSON output, parsed into per-field memory
 * writes the engine then persists. The distinction is at the descriptor
 * + UI level — Field Reasoner targets ONE field with a richer prompt,
 * stronger default model, and a fused field-declaration + prompt modal.
 * Storage shape is identical to Field Extractor (`extractsFields: [id]`)
 * so this plugin reuses the engine's existing extractor field-resolution
 * pipeline unchanged.
 *
 * Output: json-to-memory.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');
const descriptor = require('../../addons/fieldReasoner.addon.json');

const FIELD_REASONER_PLUGIN_ID = descriptor.pluginId;

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
    // Resolved field defs the engine looked up from
    // `instance.config.extractsFields`. For Field Reasoner the UI
    // constrains this to exactly one entry; we tolerate any length
    // here so a hand-edited body doesn't crash the run.
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
    tokens:       { input: 0, output: 0, total: 0 },
  };
}

registerPlugin({
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  run,
});

module.exports = { FIELD_REASONER_PLUGIN_ID };
