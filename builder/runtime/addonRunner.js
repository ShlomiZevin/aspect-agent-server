/**
 * addonRunner — execute ONE addon instance end-to-end.
 *
 * Single source of truth for the per-addon execution path. Both the
 * blocking-lane loop (`BuilderRunner`) and the offline-lane dispatcher
 * (`offlineDispatcher`) call into this module, so:
 *
 *  - SSE event shapes are identical (clients can't tell the lane
 *    apart from event field names alone — only from `addon.start.lane`)
 *  - Memory persistence behaves the same
 *  - addon_runs rows are written with the same payload
 *  - Transition side-effects (currentCrewId, lastTransitionMessageId)
 *    are applied consistently
 *
 * The orchestration concern (which addons to run, in what order, with
 * what concurrency, and whether to short-circuit on `breakChain`) is
 * the caller's. This module only knows how to run a single addon.
 *
 * Inputs:
 *  - `ctx`       — the shared per-turn execution context (built once
 *                  by `BuilderRunner.runOnce` and passed to both the
 *                  blocking loop and the offline dispatcher)
 *  - `instance`  — the AddonInstance to execute
 *  - `addonStart`— wall clock at execution start (caller's choice so
 *                  parallel offline runs can timestamp independently)
 *
 * Returns:
 *  - `{ result, didTransition, broke }`
 *      - `result`        — the plugin's full run() return value, or
 *                          null when the addon was skipped due to a
 *                          known error code (already emitted on the
 *                          SSE stream)
 *      - `didTransition` — true when this addon's output produced a
 *                          crew transition that was successfully
 *                          persisted to conversation metadata
 *      - `broke`         — mirror of `result.breakChain` (only the
 *                          blocking-lane caller honours this — offline
 *                          addons always run to completion regardless)
 *
 * This file never reaches into the LLM directly, never decides which
 * addons exist in the runnable, and never touches the offline trigger
 * state. Those are all caller concerns.
 */

const { eq } = require('drizzle-orm');
const { conversations } = require('../../db/schema');
const { assemblePrompt } = require('./promptAssembler');
const { getPlugin } = require('./pluginRegistry');
const builderMemory = require('./builderMemory');
const addonRunsStore = require('./addonRunsStore');
const historyService = require('./historyService');

/**
 * Execute one addon. See module doc for ctx shape.
 *
 * @param {object} args
 * @param {object} args.ctx
 * @param {object} args.instance
 * @param {number} [args.addonStart] — wall-clock ms at start of execution.
 *                                     Defaults to `Date.now()` if omitted.
 */
async function runAddon({ ctx, instance, addonStart = Date.now() }) {
  const {
    runnable,
    agentSlug,
    ownerUserId,
    userId,
    conversationId,
    assistantMessageId,
    userMessage,
    crewLabel,
    agentNameForLogs,
    agentPersona,
    agentParameters,
    agentDynamicContexts,
    memory,
    memoryValuesByDomain,
    memoryDomainList,
    thinkingValuesByDomain,
    thinkingDomainList,
    fieldValueOf,
    drizzle,
    convRow,
    emit,
    llm,
    logUsage,
    resolveModelLabel,
  } = ctx;

  const modelLabel = resolveModelLabel(instance.config?.model);
  const meta = {
    instanceId: instance.instanceId,
    pluginId:   instance.pluginId,
    lane:       instance.lane,
    label:      instance.config?.name || instance.pluginId,
    model:      instance.config?.model || null,
    modelLabel,
  };
  emit('addon.start', meta);

  // ── Resolve the plugin descriptor. Surface unknown ids loudly. ──
  let plugin;
  try {
    plugin = getPlugin(instance.pluginId);
  } catch (err) {
    emit('addon.error', {
      instanceId: instance.instanceId,
      error: { code: 'unknown_plugin', message: err.message },
    });
    return { result: null, didTransition: false, broke: false };
  }

  // ── Resolve this addon's extracted fields, if any. Field defs ──
  // live on `agent.fields` (agent-scoped) and on each crew's
  // `crew.fields` (crew-scoped). The Field Extractor / Reasoner /
  // Interviewer store `extractsFields: ID[]` referencing them.
  const cfg = instance.config || {};
  const extractsIds = Array.isArray(cfg.extractsFields) ? cfg.extractsFields : [];
  const agentFields = Array.isArray(runnable.agent.body?.fields) ? runnable.agent.body.fields : [];
  const crewFields  = Array.isArray(runnable.crew.body?.fields)  ? runnable.crew.body.fields  : [];
  const fieldPool   = [...agentFields, ...crewFields];
  const extractorFields = extractsIds
    .map(id => fieldPool.find(f => f.id === id))
    .filter(Boolean);

  // ── Assemble the prompt. Readers close over the live brain blob ──
  // so writes from upstream addons in the same turn are visible.
  let prompt = '';
  try {
    prompt = assemblePrompt({
      instance,
      agentPersona,
      memoryValuesByDomain,
      memoryDomainList,
      thinkingValuesByDomain,
      thinkingDomainList,
      fieldValueOf,
      extractorFields,
      parameters:       agentParameters,
      dynamicContexts:  agentDynamicContexts,
      fieldsForDynamic: fieldPool,
      summaries:        memory?.summary || {},
      onDynamicResolved: ({ fieldName, section, matched, text }) => {
        emit('dynamic.resolved', {
          instanceId: instance.instanceId,
          fieldName,
          section,
          matched,
          text,
        });
      },
    });
  } catch (err) {
    emit('addon.error', {
      instanceId: instance.instanceId,
      error: { code: 'assemble_failed', message: err.message },
    });
    return { result: null, didTransition: false, broke: false };
  }

  // ── Fetch history per the instance's history config. Empty when ──
  // `mode === 'none'`. Passed as a separate LLM parameter — NOT
  // interpolated into the prompt string. The brain blob is passed so
  // the `since_summarizer` resolver can read watermarks.
  const historyMessages = await historyService.loadHistory({
    conversationId,
    historyMode: instance.context?.history,
    brain:       memory,
  });

  emit('addon.prompt', {
    instanceId:   instance.instanceId,
    prompt,
    historyCount: historyMessages.length,
  });

  // ── Resolve the model string. Configs carry { providerId, modelId }; ──
  // llm.js routes by modelId via the central models registry. Some
  // plugins (Transition Router) don't call an LLM and declare
  // `requiresModel: false` — skip the check for those.
  const model = instance.config?.model || {};
  const modelString = typeof model === 'string' ? model : (model.modelId || null);
  const needsModel = plugin.requiresModel !== false;
  if (needsModel && !modelString) {
    emit('addon.error', {
      instanceId: instance.instanceId,
      error: { code: 'no_model', message: 'Addon has no model configured' },
    });
    return { result: null, didTransition: false, broke: false };
  }

  // ── Validate the chosen outputType is allowed for this plugin. ──
  if (
    Array.isArray(plugin.allowedOutputTypes) &&
    plugin.allowedOutputTypes.length > 0 &&
    instance.outputType &&
    !plugin.allowedOutputTypes.includes(instance.outputType)
  ) {
    emit('addon.error', {
      instanceId: instance.instanceId,
      error: {
        code: 'bad_output_type',
        message: `Plugin "${plugin.id}" does not support outputType="${instance.outputType}". Allowed: ${plugin.allowedOutputTypes.join(', ')}`,
      },
    });
    return { result: null, didTransition: false, broke: false };
  }

  // ── Call the plugin. The plugin owns LLM-call shape + parsing. ──
  const usageProcess = instance.pluginId;
  const usageCrew    = crewLabel;
  let result;
  try {
    result = await plugin.run({
      instance,
      prompt,
      modelString,
      userMessage,
      conversationId,
      agentSlug,
      agentNameForLogs,
      ownerUserId,
      userId,
      memory,
      historyMessages,
      emit,
      llm,
      logUsage,
      usageProcess,
      usageCrew,
      extractorFields,
    });
  } catch (err) {
    emit('addon.error', {
      instanceId: instance.instanceId,
      error: { code: 'plugin_run_failed', message: err.message },
    });
    return { result: null, didTransition: false, broke: false };
  }

  // ── Merge memory writes + persist. Writes are visible to ──
  // downstream addons this same turn (readers close over `memory`).
  const memoryWrites = Array.isArray(result.memoryWrites) ? result.memoryWrites : [];
  if (memoryWrites.length > 0) {
    builderMemory.applyWrites(memory, memoryWrites);
    try {
      await builderMemory.saveMemory(userId, conversationId, memory);
    } catch (err) {
      console.error('[addonRunner] memory save failed:', err.message);
    }
  }

  // ── Handle transition output (Transition Router). Stamps both ──
  // `currentCrewId` and `lastTransitionMessageId` so the
  // `since_transition` history mode has a cutoff to filter on.
  let didTransition = false;
  if (result.transition && result.transition.to) {
    try {
      const currentMeta = convRow?.metadata || {};
      const nextMeta = {
        ...currentMeta,
        currentCrewId: result.transition.to,
        ...(Number.isFinite(assistantMessageId) && assistantMessageId > 0
          ? { lastTransitionMessageId: Number(assistantMessageId) }
          : {}),
      };
      await drizzle.update(conversations)
        .set({ metadata: nextMeta, updatedAt: new Date() })
        .where(eq(conversations.id, Number(conversationId)));
      if (convRow) convRow.metadata = nextMeta;
      didTransition = true;
    } catch (err) {
      console.error('[addonRunner] transition save failed:', err.message);
    }
  }

  // ── Emit addon.output. Same shape live and historical — P3 ──
  // uses the persisted `addon_runs.run_data` verbatim for replay.
  const outputPayload = {
    instanceId:   instance.instanceId,
    label:        meta.label,
    modelLabel,
    prompt,
    rawOutput:    result.rawOutput ?? '',
    parsedOutput: result.parsedOutput ?? null,
    memoryWrites,
    tokens:       result.tokens || { input: 0, output: 0, total: 0 },
    durationMs:   result.durationMs ?? (Date.now() - addonStart),
    ...(typeof result.firstTokenMs === 'number' ? { firstTokenMs: result.firstTokenMs } : {}),
    ...(result.parseError ? { parseError: result.parseError } : {}),
    ...(didTransition ? { transition: { to: result.transition.to, reason: result.transition.reason } } : {}),
    ...(result.breakChain ? { broke: true } : {}),
    // The lane is in addon.start.meta — surfacing it on addon.output
    // too means the UserChat history view can colour offline runs
    // even when rehydrating from `addon_runs.run_data` without the
    // earlier event.
    lane: instance.lane,
  };
  emit('addon.output', outputPayload);

  // ── Persist the addon_run row. Best-effort. ──
  try {
    await addonRunsStore.insertRun({
      conversationId,
      messageId: assistantMessageId,
      instance,
      status: 'success',
      startedAt: new Date(addonStart),
      endedAt: new Date(),
      durationMs: outputPayload.durationMs,
      runData: outputPayload,
    });
  } catch (err) {
    console.error('[addonRunner] addon_run insert failed:', err.message);
  }

  return {
    result,
    didTransition,
    broke: !!result.breakChain,
  };
}

module.exports = { runAddon };
