/**
 * Talker plugin — server-side.
 *
 * Streams text tokens back to the user. The Talker's prompt IS the
 * crew's voice. Counterpart of the client `talker` plugin under
 * `aspect-react-client/src/builder/plugins/talker/`.
 *
 * Output: text-to-user (streamed).
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');

const TALKER_PLUGIN_ID = 'talker';

async function run(ctx) {
  const {
    instance,
    prompt,
    modelString,
    userMessage,
    conversationId,
    agentSlug,
    agentNameForLogs,
    ownerUserId,
    historyMessages,
    emit,
    llm,
    logUsage,
    usageProcess,
    usageCrew,
  } = ctx;

  const start = Date.now();
  let collected = '';
  let usageData = null;

  const stream = llm.sendMessageStreamWithPrompt(userMessage, conversationId, {
    prompt,
    model: modelString,
    historyMessages,
    context: usageProcess,
    agentName: agentNameForLogs,
    crewMember: usageCrew,
    userId: ownerUserId,
  });

  for await (const chunk of stream) {
    if (typeof chunk === 'string') {
      collected += chunk;
      emit('addon.token', { instanceId: instance.instanceId, token: chunk });
    } else if (chunk && chunk.type === 'text' && typeof chunk.text === 'string') {
      collected += chunk.text;
      emit('addon.token', { instanceId: instance.instanceId, token: chunk.text });
    } else if (chunk && chunk.type === 'usage') {
      usageData = {
        inputTokens:  chunk.inputTokens  || 0,
        outputTokens: chunk.outputTokens || 0,
        durationMs:   chunk.durationMs   || (Date.now() - start),
      };
    }
    // Other chunk types (function calls, etc.) ignored.
  }

  // Streaming providers yield a final `{ type: 'usage' }` chunk; the
  // engine wraps insertion into llm_usage around the plugin call,
  // but we own the streaming consumer so we log it here.
  if (usageData) {
    logUsage({
      process:       usageProcess,
      model:         modelString,
      inputTokens:   usageData.inputTokens,
      outputTokens:  usageData.outputTokens,
      durationMs:    usageData.durationMs,
      agentName:     agentNameForLogs,
      crewMember:    usageCrew,
      conversationId: String(conversationId),
      userId:        ownerUserId,
    });
  }

  return {
    assistantText: collected,
    rawOutput:     collected,
    parsedOutput:  null,
    memoryWrites:  [],
    tokens: usageData
      ? {
          input:  usageData.inputTokens,
          output: usageData.outputTokens,
          total:  usageData.inputTokens + usageData.outputTokens,
        }
      : { input: 0, output: 0, total: 0 },
    durationMs: Date.now() - start,
  };
}

registerPlugin({
  id: TALKER_PLUGIN_ID,
  allowedOutputTypes: ['text-to-user'],
  run,
});

module.exports = { TALKER_PLUGIN_ID };
