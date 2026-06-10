/**
 * Summarizer plugin — server-side.
 *
 * Fires on its configured offline-lane trigger (every_n_messages or
 * on_transition). Reads its own slice of chat history (per its
 * `context.history`), calls the LLM, writes the synthesis to
 * `brain.summary[name]` with a watermark = highest message id this
 * run included.
 *
 * Output JSON shape (the prompt teaches the LLM the convention):
 *   { "text": "<synthesis>" }
 *
 * Anything other than `text` is ignored — Summarizer is single-slot
 * by design. Multi-slot output would compete with the parallel
 * `since_summarizer` watermark semantic.
 *
 * The watermark is computed from the message slice the engine passed
 * in (`historyMessages`), not from the LLM output. That keeps the
 * watermark honest: it always equals the highest message id this
 * call actually consumed, regardless of what the LLM emitted.
 *
 * Output: json-to-memory.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');
const historyService = require('../../runtime/historyService');
const descriptor = require('../../addons/summarizer.addon.json');

const SUMMARIZER_PLUGIN_ID = descriptor.pluginId;

/**
 * Compute the watermark for this run.
 *
 * Watermark = highest message DB id in the slice the assembler passed
 * to the LLM. The engine passes a chronological list of
 * `{ role, content }` rows but those don't carry the DB id, so we ask
 * the history service for the conversation's current highest message
 * id. That's correct under our v1 contract: offline addons run within
 * the SAME request that produced the latest user message, so the
 * "highest message id right now" is exactly the cutoff point we want
 * the next `since_summarizer` consumer to filter from.
 *
 * If the history mode was `none` we still record the current highest
 * id — the summarizer may have produced a memory-only / persona-only
 * summary, but downstream consumers asking "what's new since the
 * checkpoint" still want to skip the messages that existed at the
 * time the checkpoint was recorded.
 */
async function computeWatermark(conversationId) {
  try {
    return await historyService.highestMessageId(conversationId);
  } catch (err) {
    console.error('[summarizer] highestMessageId failed:', err.message);
    return 0;
  }
}

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
  } = ctx;

  const start = Date.now();
  const cfg = instance.config || {};
  const name = (typeof cfg.name === 'string' && cfg.name.trim()) ? cfg.name.trim() : 'main';

  // Empty history slice — nothing to summarise. Still bump the
  // watermark (so consumers' "since checkpoint" filter accurately
  // reflects "we looked, found nothing relevant") and write an empty
  // entry. Avoid burning an LLM call on no input.
  if (historyMessages.length === 0 && !userMessage) {
    const watermark = await computeWatermark(conversationId);
    return {
      rawOutput:    '',
      parsedOutput: { text: '' },
      memoryWrites: [
        { kind: 'summary', name, entry: { text: '', watermark, ranAt: Date.now() } },
      ],
      durationMs:   Date.now() - start,
      tokens:       { input: 0, output: 0, total: 0 },
    };
  }

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

  // Extract the synthesis text. We accept either `text` (the
  // contract) or — defensively — the raw output as a string when the
  // LLM ignored the JSON instruction. Empty text is still a valid
  // outcome (the LLM said "nothing changed"); we persist it so
  // consumers see the checkpoint advanced even when content didn't.
  let text = '';
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (typeof parsed.text === 'string') text = parsed.text;
  } else if (typeof raw === 'string') {
    text = raw;
  }

  const watermark = await computeWatermark(conversationId);

  return {
    rawOutput:    raw,
    parsedOutput: parsed,
    memoryWrites: [
      { kind: 'summary', name, entry: { text, watermark, ranAt: Date.now() } },
    ],
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

module.exports = { SUMMARIZER_PLUGIN_ID };
