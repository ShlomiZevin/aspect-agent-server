/**
 * Field Extractor plugin — server-side.
 *
 * One-shot LLM call with structured JSON output. Parses the response
 * into per-field memory writes the engine then persists.
 *
 * Output: json-to-memory.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');

const FIELD_EXTRACTOR_PLUGIN_ID = 'field-extractor';

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
    // against `instance.config.extractsFields`. Field defs no
    // longer live inside the extractor's config.
    extractorFields,
  } = ctx;

  const start = Date.now();
  // sendOneShot logs usage automatically via llm.js, so no logUsage
  // call here. jsonOutput flips on each provider's structured-output
  // mode (OpenAI json_object, Google responseMimeType, Claude prompt
  // suffix). Driven by the instance's outputType.
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

  // Memory writes: every parsed key that matches a resolved field
  // def (engine-supplied from agent/crew bodies) and has a non-null
  // value. Domain on the field def routes the value into the right
  // memory bucket.
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
    // sendOneShot already logged exact token counts via llm.js;
    // the engine's addon.output event mirrors what we have here.
    tokens:       { input: 0, output: 0, total: 0 },
  };
}

registerPlugin({
  id: FIELD_EXTRACTOR_PLUGIN_ID,
  allowedOutputTypes: ['json-to-memory'],
  run,
});

module.exports = { FIELD_EXTRACTOR_PLUGIN_ID };
