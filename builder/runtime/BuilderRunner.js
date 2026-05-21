/**
 * Builder V2 — BuilderRunner (engine).
 *
 * Plugin-agnostic. One run per HTTP request. Loops the crew's
 * blocking-lane addons in order, looks each plugin up in the
 * registry, and delegates the LLM-shape concerns (streaming vs
 * one-shot, output parsing, memory write extraction) to the plugin
 * descriptor's `run()`.
 *
 * The engine owns:
 *   - resolving the addons list for the requested version
 *   - loading the conversation memory blob (builderMemory)
 *   - fetching message history per addon's context.history config
 *   - assembling the prompt (promptAssembler)
 *   - emitting SSE events (addon.start / .prompt / .output / .error)
 *   - merging memory writes back into the blob and persisting it
 *   - persisting an addon_runs row per execution (P2)
 *
 * Plugins own:
 *   - the LLM call shape (which provider method, streaming vs not)
 *   - usage logging when the call streams (one-shot is auto-logged by llm.js)
 *   - output parsing
 *   - memoryWrites extraction from the parsed output
 *
 * See docs/guides/BUILDER_V2_ADDONS.md for the full plugin contract.
 *
 * SSE events emitted by the engine (per turn):
 *   conversation, addon.start, addon.prompt, addon.token (from plugin),
 *   addon.output, addon.error, assistant.message, done
 */

const llmService = require('../../services/llm');
const { eq } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { conversations } = require('../../db/schema');
const { assemblePrompt } = require('./promptAssembler');
const { resolveRunnable } = require('../services/builderProjects');
const { logUsage } = require('../../services/usageLogger');
const { getPlugin } = require('./pluginRegistry');
const builderMemory = require('./builderMemory');
const addonRunsStore = require('./addonRunsStore');
const historyService = require('./historyService');

// Side-effect: ensure built-in plugins are registered.
require('../plugins');

/**
 * Run one turn end-to-end.
 *
 * @param {object} args
 * @param {string} args.agentSlug
 * @param {string} args.ownerUserId
 * @param {number} args.userId — internal DB user id; required for memory persistence
 * @param {number} args.conversationId — internal (DB) conversation id; required for usage logs
 * @param {number} args.assistantMessageId — DB id of the (pending) assistant message; addon_runs FK
 * @param {string} args.userMessage
 * @param {'viewing'|'active'} args.version
 * @param {function} args.emit — (eventType, payload) → void; writes an SSE event
 * @returns {Promise<{ assistantText: string }>}
 */
async function runOnce({
  agentSlug,
  ownerUserId,
  userId,
  conversationId,
  assistantMessageId,
  userMessage,
  version,
  emit,
}) {
  const totalStart = Date.now();

  // Read the conversation's current-crew pointer (set by a prior
  // Transition Router firing). Empty/missing on first turn → resolver
  // falls back to the agent's defaultCrewId.
  const drizzle = db.getDrizzle();
  const [convRow] = await drizzle.select().from(conversations)
    .where(eq(conversations.id, Number(conversationId))).limit(1);
  const currentCrewId = (convRow?.metadata && convRow.metadata.currentCrewId) || null;

  // ── 1. Resolve runnable: which crew + addons for this version. ──
  const runnable = await resolveRunnable({
    agentSlug,
    ownerUserId,
    mode: version === 'active' ? 'active' : 'viewing',
    overrideCrewId: currentCrewId,
  });

  const agentPersona     = runnable.agent.body?.persona || '';
  const agentNameForLogs = runnable.agent.body?.name || agentSlug;
  const crewLabel        = runnable.crew.body?.name || 'crew';
  const allAddons        = Array.isArray(runnable.crew.body?.addons) ? runnable.crew.body.addons : [];
  const blockingAddons   = allAddons.filter(a => a.lane === 'main' && a.enabled !== false);

  // ── 2. Load accumulated memory + memory accessors for the prompt. ──
  const memory = await builderMemory.loadMemory(userId, conversationId);
  const fieldValueOf         = (name)   => builderMemory.findFieldValue(memory, name);
  const memoryValuesByDomain = (domain) => builderMemory.valuesForDomain(memory, domain);

  let assistantText = '';

  for (const instance of blockingAddons) {
    const addonStart = Date.now();
    const meta = {
      instanceId: instance.instanceId,
      pluginId:   instance.pluginId,
      lane:       instance.lane,
      label:      instance.config?.name || instance.pluginId,
      model:      instance.config?.model || null,
    };
    emit('addon.start', meta);

    // 3. Resolve the plugin descriptor. Surface unknown ids loudly —
    // means the crew body references a plugin not loaded.
    let plugin;
    try {
      plugin = getPlugin(instance.pluginId);
    } catch (err) {
      emit('addon.error', {
        instanceId: instance.instanceId,
        error: { code: 'unknown_plugin', message: err.message },
      });
      continue;
    }

    // 4. Assemble the prompt. Memory readers close over the current
    //    memory blob, which mutates across iterations as upstream
    //    extractors produce writes.
    let prompt = '';
    try {
      prompt = assemblePrompt({
        instance,
        agentPersona,
        memoryValuesByDomain,
        fieldValueOf,
      });
    } catch (err) {
      emit('addon.error', {
        instanceId: instance.instanceId,
        error: { code: 'assemble_failed', message: err.message },
      });
      continue;
    }

    // 5. Fetch history per the instance's history config. Empty when
    //    `mode === 'none'`. Passed as a separate LLM parameter — NOT
    //    interpolated into the prompt string.
    const historyMessages = await historyService.loadHistory({
      conversationId,
      historyMode: instance.context?.history,
      // Exclude the just-inserted user message; it'll be the "current"
      // message the LLM call uses separately.
      excludeAfterMessageId: null,
    });

    emit('addon.prompt', {
      instanceId:   instance.instanceId,
      prompt,
      historyCount: historyMessages.length,
    });

    // 6. Resolve the model string. Configs carry { providerId, modelId };
    //    llm.js routes by modelId via the central models registry.
    //    Some plugins (Transition Router) don't call an LLM and
    //    declare `requiresModel: false` — skip the check for those.
    const model = instance.config?.model || {};
    const modelString = typeof model === 'string' ? model : (model.modelId || null);
    const needsModel = plugin.requiresModel !== false;
    if (needsModel && !modelString) {
      emit('addon.error', {
        instanceId: instance.instanceId,
        error: { code: 'no_model', message: 'Addon has no model configured' },
      });
      continue;
    }

    // 7. Validate the chosen outputType is allowed for this plugin.
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
      continue;
    }

    // 8. Call the plugin. The plugin owns LLM-call shape + parsing.
    const usageProcess = instance.pluginId; // process column on llm_usage
    const usageCrew    = crewLabel;          // crew column on llm_usage
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
        llm: llmService,
        logUsage,
        usageProcess,
        usageCrew,
      });
    } catch (err) {
      emit('addon.error', {
        instanceId: instance.instanceId,
        error: { code: 'plugin_run_failed', message: err.message },
      });
      continue;
    }

    // 9. Merge memory writes from the plugin into the conversation
    //    memory blob + persist. Writes are visible to downstream
    //    addons this same turn (memoryValuesByDomain closes over `memory`).
    const memoryWrites = Array.isArray(result.memoryWrites) ? result.memoryWrites : [];
    if (memoryWrites.length > 0) {
      builderMemory.applyWrites(memory, memoryWrites);
      try {
        await builderMemory.saveMemory(userId, conversationId, memory);
      } catch (err) {
        console.error('[BuilderRunner] memory save failed:', err.message);
      }
    }

    // 10. Accumulate assistantText if the plugin produced any.
    if (typeof result.assistantText === 'string' && result.assistantText) {
      assistantText = result.assistantText;
    }

    // 10.5 Handle transition output (Transition Router plugin).
    //   - `result.transition.to` → write `conversation.metadata.currentCrewId`.
    //   - `result.breakChain`    → stop iterating after this addon.
    // Best-effort: a DB failure on the metadata write should not
    // break the conversation; we'll just retry on the next match.
    let didTransition = false;
    if (result.transition && result.transition.to) {
      try {
        const currentMeta = convRow?.metadata || {};
        const nextMeta = { ...currentMeta, currentCrewId: result.transition.to };
        await drizzle.update(conversations)
          .set({ metadata: nextMeta, updatedAt: new Date() })
          .where(eq(conversations.id, Number(conversationId)));
        // Mirror in the in-memory row so any later addon in the same
        // turn reads consistent state if we ever need to.
        if (convRow) convRow.metadata = nextMeta;
        didTransition = true;
      } catch (err) {
        console.error('[BuilderRunner] transition save failed:', err.message);
      }
    }

    // 11. Emit addon.output. Same shape live and historical (P3
    //     uses the persisted addon_runs.run_data verbatim).
    const outputPayload = {
      instanceId:   instance.instanceId,
      rawOutput:    result.rawOutput ?? '',
      parsedOutput: result.parsedOutput ?? null,
      memoryWrites,
      tokens:       result.tokens || { input: 0, output: 0, total: 0 },
      durationMs:   result.durationMs ?? (Date.now() - addonStart),
      ...(result.parseError ? { parseError: result.parseError } : {}),
      ...(didTransition ? { transition: { to: result.transition.to, reason: result.transition.reason } } : {}),
      ...(result.breakChain ? { broke: true } : {}),
    };
    emit('addon.output', outputPayload);

    // 12. Persist the addon_run row (P2). Best-effort — a DB hiccup
    //     here shouldn't break the conversation.
    try {
      await addonRunsStore.insertRun({
        conversationId,
        messageId: assistantMessageId, // may be null until the engine has it
        instance,
        status: 'success',
        startedAt: new Date(addonStart),
        endedAt: new Date(),
        durationMs: outputPayload.durationMs,
        runData: outputPayload,
      });
    } catch (err) {
      console.error('[BuilderRunner] addon_run insert failed:', err.message);
    }

    // 13. Break the chain if the plugin asked (Transition Router
    //     with onMatch: 'break'). Remaining addons skipped this turn.
    if (result.breakChain) break;
  }

  return { assistantText, totalMs: Date.now() - totalStart };
}

module.exports = { runOnce };
