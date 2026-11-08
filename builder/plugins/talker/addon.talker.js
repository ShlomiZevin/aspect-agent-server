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
const descriptor = require('../../addons/talker.addon.json');
const modelsService = require('../../../services/models.service');
const { normalizeWebSearch, createCollector } = require('../../../services/webSearch');

const TALKER_PLUGIN_ID = descriptor.pluginId;

async function run(ctx) {
  const {
    instance,
    isStopped,
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

  // Web search switch (task #967): the provider's own search tool, on when
  // the author turned it on AND the model's provider has one. The model
  // decides each turn whether to search; each search is shown live
  // (`addon.websearch`) and lands on the run card.
  const webSearch = modelsService.supportsWebSearch(modelString)
    ? normalizeWebSearch(instance.config?.webSearch)
    : null;
  const searches = createCollector();
  // Time-to-first-token — perceived latency, the moment text starts
  // appearing in the chat. Distinct from total stream duration
  // (durationMs below), which includes the trailing usage event.
  // Both are surfaced so the UI can show "starts 1.2s · full 4.5s".
  let firstTokenMs = null;

  const stream = llm.sendMessageStreamWithPrompt(userMessage, conversationId, {
    prompt,
    model: modelString,
    historyMessages,
    context: usageProcess,
    agentName: agentNameForLogs,
    crewMember: usageCrew,
    userId: ownerUserId,
    ...(webSearch ? { webSearch } : {}),
  });

  for await (const chunk of stream) {
    // Task #816: Stop pressed — leave the stream; the runner discards the turn.
    if (isStopped && isStopped()) break;
    if (typeof chunk === 'string') {
      if (firstTokenMs === null && chunk.length > 0) firstTokenMs = Date.now() - start;
      collected += chunk;
      emit('addon.token', { instanceId: instance.instanceId, token: chunk });
    } else if (chunk && chunk.type === 'text' && typeof chunk.text === 'string') {
      if (firstTokenMs === null && chunk.text.length > 0) firstTokenMs = Date.now() - start;
      collected += chunk.text;
      emit('addon.token', { instanceId: instance.instanceId, token: chunk.text });
    } else if (chunk && chunk.type === 'web_search') {
      searches.add(chunk);
      emit('addon.websearch', {
        instanceId: instance.instanceId,
        id: chunk.id,
        status: chunk.phase === 'done' ? (chunk.error ? 'error' : 'done') : 'searching',
        query: chunk.query || null,
        kind: chunk.kind || 'search',
        ...(chunk.phase === 'done' ? { sources: (chunk.sources || []).slice(0, 8) } : {}),
      });
    } else if (chunk && chunk.type === 'usage') {
      searches.setUsage(chunk);
      usageData = {
        inputTokens:  chunk.inputTokens  || 0,
        outputTokens: chunk.outputTokens || 0,
        // Reasoning-model split: billed inside outputTokens but never
        // emitted as text. Persisted so an empty-but-billed reply is
        // self-explanatory in the run card (#809). null = not reported.
        reasoningTokens: typeof chunk.reasoningTokens === 'number' ? chunk.reasoningTokens : null,
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
  const webSearchResult = webSearch ? searches.result(webSearch) : null;
  if (webSearchResult && webSearchResult.count > 0) {
    // The searches are their own priced llm_usage row (see usageLogger
    // logWebSearches / models.service USAGE_ITEMS): output = searches.
    const provider = modelsService.tryProviderOf(modelString);
    logUsage({
      process:       usageProcess,
      model:         modelsService.webSearchUsageId(provider),
      provider,
      inputTokens:   0,
      outputTokens:  webSearchResult.count,
      durationMs:    usageData ? usageData.durationMs : (Date.now() - start),
      agentName:     agentNameForLogs,
      crewMember:    usageCrew,
      conversationId: String(conversationId),
      userId:        ownerUserId,
    });
  }

  return {
    ...(webSearchResult ? { webSearch: webSearchResult } : {}),
    assistantText: collected,
    rawOutput:     collected,
    parsedOutput:  null,
    memoryWrites:  [],
    tokens: usageData
      ? {
          input:  usageData.inputTokens,
          output: usageData.outputTokens,
          total:  usageData.inputTokens + usageData.outputTokens,
          ...(usageData.reasoningTokens != null ? { reasoning: usageData.reasoningTokens } : {}),
        }
      : { input: 0, output: 0, total: 0 },
    durationMs:   Date.now() - start,
    firstTokenMs,
  };
}

registerPlugin({
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  run,
});

module.exports = { TALKER_PLUGIN_ID };
