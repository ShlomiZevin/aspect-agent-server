/**
 * Thinker plugin — server-side.
 *
 * One-shot LLM call that produces strategic guidance for the Talker
 * to consume. Output is a JSON object whose keys are whatever the
 * prompt asked the LLM to emit — no declared field schema.
 *
 * Every parsed key becomes a memoryWrite with `kind: 'thinking'` and
 * `domain: instance.config.domain` (default `'strategy'`). The engine
 * routes those into the brain's `thinking` section so downstream
 * addons can read them via `{{thinking}}` or `{{thinking:DOMAIN}}`.
 *
 * Output: json-to-memory.
 */

const { registerPlugin } = require('../../runtime/pluginRegistry');
const { parseOutput } = require('../../runtime/outputParser');
const descriptor = require('../../addons/thinker.addon.json');
const modelsService = require('../../../services/models.service');
const { normalizeWebSearch, createCollector } = require('../../../services/webSearch');

const THINKER_PLUGIN_ID = descriptor.pluginId;

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
    emit,
    usageProcess,
    usageCrew,
  } = ctx;

  const start = Date.now();
  const cfg = instance.config || {};
  // Domain comes from config — user-configurable, default 'strategy'.
  // Empty string falls back to 'strategy' so users can't silently
  // collapse multiple Thinkers into the no-domain bucket by mistake.
  const domain = (typeof cfg.domain === 'string' && cfg.domain.trim()) ? cfg.domain.trim() : 'strategy';

  // Web search switch (task #967): the provider's own search tool. What the
  // model found goes wherever the prompt asks for it in the JSON — so it
  // lands in this Thinker's domain and the Talker reads it via
  // {{thinking:DOMAIN}}. Each search is shown live (`addon.websearch`).
  const webSearch = modelsService.supportsWebSearch(modelString)
    ? normalizeWebSearch(cfg.webSearch)
    : null;
  const searches = createCollector();
  const onWebSearch = ev => {
    searches.add(ev);
    emit('addon.websearch', {
      instanceId: instance.instanceId,
      id: ev.id,
      status: ev.phase === 'done' ? (ev.error ? 'error' : 'done') : 'searching',
      query: ev.query || null,
      kind: ev.kind || 'search',
      ...(ev.phase === 'done' ? { sources: (ev.sources || []).slice(0, 8) } : {}),
    });
  };

  const result = await llm.sendOneShot(prompt, userMessage, {
    model: modelString,
    jsonOutput: instance.outputType === 'json-to-memory',
    historyMessages,
    context: usageProcess,
    agentName: agentNameForLogs,
    crewMember: usageCrew,
    conversationId: String(conversationId),
    userId: ownerUserId,
    ...(webSearch ? { webSearch, onWebSearch, withMeta: true } : {}),
  });
  const raw = typeof result === 'string' ? result : (result?.text || '');
  let webSearchResult = null;
  if (webSearch) {
    const usage = (result && typeof result === 'object' && result.usage) || {};
    // Searches the live listener missed (OpenAI one-shot reports them all
    // at the end too) — the collector de-dupes by id.
    for (const ev of usage.webEvents || []) searches.add(ev);
    searches.setUsage(usage);
    webSearchResult = searches.result(webSearch);
  }

  const { parsed, error } = parseOutput(instance.outputType || 'json-to-memory', raw);

  // Memory writes: every top-level key from the parsed JSON, written
  // to the `thinking` section under the configured domain. Unlike
  // Field Extractor, the Thinker has no declared field list — the
  // prompt IS the schema. We trust whatever the LLM returned (subject
  // to the same null/undefined filter applied elsewhere).
  //
  // Rolling-replace semantics: the Thinker owns its `(thinking,
  // domain)` bucket entirely. Each run's output IS the current
  // thinking, not an addition to it. So we emit a domain-replace
  // marker first to wipe whatever the previous run left there, then
  // apply this run's writes. Without this, a key emitted last turn
  // (e.g. `atr1`) would linger after a turn that only emits `atr2`.
  // Only emit when parsing succeeded — a failed parse means we don't
  // know what the LLM intended, so leave the previous state intact.
  const memoryWrites = [];
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    memoryWrites.push({ kind: 'thinking', domain, replace: true });
    for (const [field, value] of Object.entries(parsed)) {
      if (value === null || value === undefined) continue;
      memoryWrites.push({ kind: 'thinking', domain, field, value });
    }
  }

  return {
    ...(webSearchResult ? { webSearch: webSearchResult } : {}),
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

module.exports = { THINKER_PLUGIN_ID };
