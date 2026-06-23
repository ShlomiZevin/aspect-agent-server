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
const { evaluateConditions } = require('./conditionMatcher');

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
    agentPersonas,
    agentParameters,
    agentEnums,
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

  // ── Per-addon filter gate. Runs BEFORE prompt assembly so we don't ──
  // waste an LLM call on an addon the author asked the engine to
  // skip. Reuses the same vocabulary / matcher the Transition Router
  // uses — one condition language across the system.
  //
  // Semantics:
  //   - No filter / empty conditions → always runs (legacy behaviour).
  //   - mode 'include' (default) → runs WHEN every condition matches.
  //   - mode 'exclude'           → runs WHEN at least one condition
  //                                fails (i.e., conditions do NOT all
  //                                hold).
  //
  // When skipped we emit an `addon.skipped` SSE event with the
  // evaluation trail so the run card shows the author exactly why,
  // and persist an addon_runs row with status 'skipped' so the
  // historical view stays consistent.
  const filter = instance.context?.filter;
  if (filter) {
    // ── Cap check FIRST ──────────────────────────────────────────
    // The cap is independent of the condition list and its
    // include/exclude polarity. Once hit, skip regardless of
    // condition state.
    const cap = Number(filter.cap);
    const hasCap = Number.isFinite(cap) && cap > 0;
    if (hasCap) {
      const counts = (memory && memory.runCounts) || {};
      const seen = Number(counts[instance.instanceId]) || 0;
      if (seen >= cap) {
        // Cap skip — kept distinct from condition skips on the
        // wire so the client can render a cleaner card (no "by
        // filter (mode)" subtitle, no per-condition eval list). The
        // single reason line carries all the detail an author needs.
        const skipPayload = {
          instanceId:  instance.instanceId,
          label:       meta.label,
          modelLabel,
          lane:        instance.lane,
          filter: {
            kind: 'cap',
            cap,
            seen,
          },
          reason:      cap === 1
            ? 'Cap reached — already ran once this conversation'
            : `Cap reached — ran ${seen} of ${cap} allowed times`,
          durationMs:  Date.now() - addonStart,
        };
        emit('addon.skipped', skipPayload);
        try {
          await addonRunsStore.insertRun({
            conversationId,
            messageId: assistantMessageId,
            instance,
            status: 'skipped',
            startedAt: new Date(addonStart),
            endedAt:   new Date(),
            durationMs: skipPayload.durationMs,
            runData:   skipPayload,
          });
        } catch (err) {
          console.error('[addonRunner] skipped addon_run insert failed:', err.message);
        }
        return { result: null, didTransition: false, broke: false, skipped: true };
      }
    }

    // ── Conditions ───────────────────────────────────────────────
    if (Array.isArray(filter.conditions) && filter.conditions.length > 0) {
      // Pass `instanceId` via ctx so legacy `run-count` conditions
      // (transition router) keep working.
      const evalResult = evaluateConditions(memory, filter.conditions, {
        instanceId: instance.instanceId,
      });
      const mode = filter.mode === 'exclude' ? 'exclude' : 'include';
      const shouldRun = mode === 'include' ? evalResult.ok : !evalResult.ok;
      if (!shouldRun) {
        const skipPayload = {
          instanceId:  instance.instanceId,
          label:       meta.label,
          modelLabel,
          lane:        instance.lane,
          filter: {
            kind: 'conditions',
            mode,
            evaluations: evalResult.evaluations,
          },
          // Single-line summary the card can use as a tooltip / chip.
          reason: mode === 'include'
            ? `Conditions not met — ${(evalResult.evaluations.find(e => !e.ok) || {}).why || 'no condition matched'}`
            : `Conditions matched (exclude mode) — ${(evalResult.evaluations.find(e => e.ok) || {}).why || ''}`,
          durationMs:  Date.now() - addonStart,
        };
        emit('addon.skipped', skipPayload);
        try {
          await addonRunsStore.insertRun({
            conversationId,
            messageId: assistantMessageId,
            instance,
            status: 'skipped',
            startedAt: new Date(addonStart),
            endedAt:   new Date(),
            durationMs: skipPayload.durationMs,
            runData:   skipPayload,
          });
        } catch (err) {
          console.error('[addonRunner] skipped addon_run insert failed:', err.message);
        }
        return { result: null, didTransition: false, broke: false, skipped: true };
      }
    }
  }

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
      personas: agentPersonas,
      memoryValuesByDomain,
      memoryDomainList,
      thinkingValuesByDomain,
      thinkingDomainList,
      fieldValueOf,
      extractorFields,
      parameters:       agentParameters,
      enums:            agentEnums,
      fieldsForDc:      fieldPool,
      summaries:        memory?.summary || {},
      // Snippet pass: agent-level reusable prompt content + the live
      // brain blob so a snippet's optional filter can be evaluated
      // against current memory. See `promptAssembler.resolveSnippetInline`.
      snippets:         Array.isArray(runnable.agent.body?.snippets)
        ? runnable.agent.body.snippets
        : [],
      brain:            memory,
      onEnumResolved: ({ enumName, section, count, text }) => {
        emit('enum.resolved', {
          instanceId: instance.instanceId,
          enumName,
          section,
          count,
          text,
        });
      },
      onDcResolved: ({ fieldName, section, matched, text }) => {
        emit('dc.resolved', {
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
  // the `since_summarizer` resolver can read watermarks. The
  // resolution record carries the requested + effective mode and any
  // fallback reason so the client can surface "why is this prompt so
  // big?" without re-deriving runtime state.
  //
  // `ctx.historyExcludeFromMessageId` is the cutoff that scopes
  // history to messages BEFORE the current turn started. Blocking-
  // chain addons get the cutoff (so they don't see their own turn's
  // user message + assistant placeholder). Offline-lane addons get
  // no cutoff — they fire after the assistant text is persisted, so
  // including the current turn is both correct and what we want.
  const { messages: historyMessages, resolution: historyResolution } =
    await historyService.loadHistory({
      conversationId,
      historyMode:           instance.context?.history,
      brain:                 memory,
      excludeFromMessageId:  ctx.historyExcludeFromMessageId,
    });

  // Blocking-phase addons receive the current user message OUTSIDE
  // historyMessages (trailing user turn for the Talker; appended as
  // `## Context` for sendOneShot plugins) — so bump the count by 1.
  // Offline addons already have the current turn inside
  // historyMessages (no cutoff), so we don't.
  const visibleCount = historyMessages.length
    + (ctx.historyExcludeFromMessageId !== undefined ? 1 : 0);

  emit('addon.prompt', {
    instanceId:    instance.instanceId,
    prompt,
    historyCount:  visibleCount,
    historyMode:   historyResolution,
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
      // Mirror the cutoff into the plugin ctx so plugins that derive
      // their own message-id watermark (Summarizer) compute it
      // against the SAME slice the engine just handed them.
      historyExcludeFromMessageId: ctx.historyExcludeFromMessageId,
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
  //
  // The plugin's own writes go first; then we harvest any SYSTEM
  // field keys (e.g. `moveOn`) from the parsed output. The plugin
  // wasn't required to know about system fields — the engine scans
  // for them universally and writes them to the `_system` domain.
  // Order: plugin writes first → system writes second. If a plugin
  // happens to also write a system-named field (legacy or hand-rolled
  // shape), the harvest pass overrides with the canonical type-coerced
  // value.
  const { harvestSystemFieldWrites, harvestDeclaredFieldWrites } = require('./systemFields');
  const pluginWrites = Array.isArray(result.memoryWrites) ? result.memoryWrites : [];
  // Names the plugin already wrote to the regular memory section.
  // The declared-field harvest skips them so a Field Extractor's
  // targeted writes aren't shadowed by an opportunistic harvest of
  // the same key. Thinking/summary writes don't compete with memory.
  const explicitMemoryNames = new Set();
  for (const w of pluginWrites) {
    if (!w || typeof w !== 'object') continue;
    if (w.kind && w.kind !== 'memory') continue;
    if (typeof w.field === 'string' && w.field) explicitMemoryNames.add(w.field);
  }
  const systemWrites = harvestSystemFieldWrites(result.parsedOutput);
  // Auto-fill any declared field whose name appears as a key in the
  // parsed output. Lets a Thinker (or any json-emitting addon) double
  // as a quiet extractor: the LLM emits `{ moveOn: true, mood: 'sad' }`
  // and `mood` lands in memory automatically if it's a declared field.
  const declaredWrites = harvestDeclaredFieldWrites(
    result.parsedOutput,
    fieldPool,
    explicitMemoryNames,
  );
  const memoryWrites = [...pluginWrites, ...systemWrites, ...declaredWrites];
  if (memoryWrites.length > 0) {
    builderMemory.applyWrites(memory, memoryWrites);
  }

  // ── Bump the per-instance run counter on the brain blob. Drives ──
  // the `run-count` filter condition. Mutates `memory` in place so
  // any downstream addon in this same turn that uses a run-count
  // filter sees this run reflected. Persisted in the same memory
  // save call below.
  if (!memory.runCounts || typeof memory.runCounts !== 'object') {
    memory.runCounts = {};
  }
  memory.runCounts[instance.instanceId] = (Number(memory.runCounts[instance.instanceId]) || 0) + 1;

  // Persist whenever memory was touched — by a write OR by the
  // run-count bump above. Single save covers both.
  try {
    await builderMemory.saveMemory(userId, conversationId, memory);
  } catch (err) {
    console.error('[addonRunner] memory save failed:', err.message);
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
    // History resolution mirrors what we emitted on addon.prompt so a
    // reloaded conversation can still show "history: last_n=5 → 5
    // msgs" without replaying the per-event stream. `visibleCount`
    // (computed above) bumps by 1 for blocking-phase addons since
    // they see the current user message outside historyMessages.
    historyMode:  historyResolution,
    historyCount: visibleCount,
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
