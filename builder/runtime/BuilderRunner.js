/**
 * Builder V2 — BuilderRunner.
 *
 * One run per HTTP request. Resolves the viewing (or active) crew
 * from the persisted project doc, loops blocking-lane addons in
 * order, calls llm.js for each, parses output, emits SSE events.
 *
 * Routing is config-driven, NOT plugin-id based:
 *   - `outputType === 'text-to-user'`    → streaming call; tokens
 *     flow back as addon.token events. We log the trailing
 *     `{ type: 'usage' }` event to llm_usage ourselves (the stream
 *     yields raw; only the one-shot path is auto-logged by llm.js).
 *   - `outputType === 'json-to-memory'`  → one-shot with
 *     `jsonOutput: true` (provider-specific structured output mode);
 *     parsed via outputParser into per-field writes.
 *
 * Memory: per-conversation `## Memory` / `## Already collected`
 * blobs are loaded from context_data (namespace `builder_memory`)
 * at the start of each run, threaded into the prompt assembler as
 * `fieldValueOf` + `memoryValuesByDomain` callbacks, and merged +
 * persisted back after each extractor produces writes.
 *
 * P1 scope:
 *   - Blocking lane only (skip background + offline for now).
 *   - History reads are NOT yet wired (that's P2). For now we send
 *     no history; the LLM sees the prompt and the latest message
 *     only.
 *   - addon_runs persistence is P2.
 *
 * SSE events emitted (per the contract):
 *   conversation, addon.start, addon.prompt, addon.token,
 *   addon.output, addon.error, assistant.message, done
 */

const llmService = require('../../services/llm');
const { assemblePrompt } = require('./promptAssembler');
const { parseOutput } = require('./outputParser');
const { resolveRunnable } = require('../services/builderProjects');
const { logUsage } = require('../../services/usageLogger');
const builderMemory = require('./builderMemory');

/**
 * Run one turn end-to-end.
 *
 * @param {object} args
 * @param {string} args.agentSlug
 * @param {string} args.ownerUserId
 * @param {number} args.userId — internal DB user id; required for memory persistence
 * @param {string} args.conversationId — internal (DB) conversation id; required for usage logs
 * @param {string} args.userMessage
 * @param {'viewing'|'active'} args.version
 * @param {function} args.emit — (eventType, payload) → void; writes an SSE event
 * @returns {Promise<{ assistantText: string }>}
 */
async function runOnce({ agentSlug, ownerUserId, userId, conversationId, userMessage, version, emit }) {
  const totalStart = Date.now();

  // 1. Resolve which crew + addons to run.
  const runnable = await resolveRunnable({
    agentSlug,
    ownerUserId,
    mode: version === 'active' ? 'active' : 'viewing',
  });

  const agentPersona = runnable.agent.body?.persona || '';
  // Use the agent's body name for llm_usage / log attribution so it
  // matches what the dashboard filters by (e.g. 'Aspect', 'Freeda 2.0').
  // Falls back to the slug if the body has no name.
  const agentNameForLogs = runnable.agent.body?.name || agentSlug;
  const allAddons = Array.isArray(runnable.crew.body?.addons) ? runnable.crew.body.addons : [];
  const blockingAddons = allAddons
    .filter(a => a.lane === 'main' && a.enabled !== false);

  // 2. Iterate blocking addons in order.
  let assistantText = '';

  // Load the conversation's accumulated memory blob (created by prior
  // turns' extractors). The blob shape is documented in builderMemory.js.
  // We mutate it in place across the run, then persist after each
  // extractor that produces writes.
  const memory = await builderMemory.loadMemory(userId, conversationId);

  console.log(`🏃 [BuilderRunner] runOnce slug=${agentSlug} version=${version} agentName="${agentNameForLogs}" agentVersionId=${runnable.agent.versionId} crewVersionId=${runnable.crew.versionId} userId=${userId} convId=${conversationId}`);
  console.log(`🏃 [BuilderRunner] agentPersona length=${agentPersona.length}${agentPersona ? ` first40="${agentPersona.slice(0,40).replace(/\n/g,' ')}"` : ' (empty)'}`);
  console.log(`🏃 [BuilderRunner] loaded memory:`, JSON.stringify(memory));
  console.log(`🏃 [BuilderRunner] addons: ${blockingAddons.map(a => `${a.pluginId}(persona=${!!a.context?.persona}, memReads=${JSON.stringify(a.context?.memoryReads || [])}, outputType=${a.outputType})`).join(', ')}`);

  const fieldValueOf = (name) => builderMemory.findFieldValue(memory, name);
  const memoryValuesByDomain = (domain) => builderMemory.valuesForDomain(memory, domain);

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

    console.log(`📜 [BuilderRunner] ${instance.pluginId} assembled prompt (${prompt.length} chars):\n--- PROMPT START ---\n${prompt}\n--- PROMPT END ---`);

    emit('addon.prompt', {
      instanceId:   instance.instanceId,
      prompt,
      historyCount: 0,            // P2 will wire this
    });

    const model = instance.config?.model || {};
    // llm.js expects a flat model string ('gpt-4o', 'claude-...', 'gemini-...').
    // Our config carries { providerId, modelId } — flatten.
    const modelString = typeof model === 'string'
      ? model
      : (model.modelId || null);

    if (!modelString) {
      emit('addon.error', {
        instanceId: instance.instanceId,
        error: { code: 'no_model', message: 'Addon has no model configured' },
      });
      continue;
    }

    // 3. Call the LLM. Routing is config-driven (NOT plugin-id based):
    //   outputType === 'text-to-user'    → stream tokens to the user
    //   outputType === 'json-to-memory'  → one-shot with jsonOutput=true
    // Any future output type would slot in here without touching the
    // plugin identity. The plugin enforces which outputTypes it
    // supports via its descriptor; the user's chosen value flows
    // through `instance.outputType`.
    const outputType  = instance.outputType || 'text-to-user';
    const isStreaming = outputType === 'text-to-user';
    const wantsJson   = outputType === 'json-to-memory';

    // For llm_usage:
    //   process    = the addon's pluginId verbatim (talker, field-extractor) — no prefix
    //   crewMember = the crew's name (displayed under the "CREW" column)
    // Addons themselves are distinguished by the process column,
    // which keeps the CREW column meaningful (= the crew this call
    // belongs to) rather than an opaque instanceId.
    const usageProcess = instance.pluginId;
    const usageCrew    = runnable.crew.body?.name || 'crew';

    if (isStreaming) {
      // Stream tokens through addon.token events. Capture the trailing
      // `{ type: 'usage' }` event from the provider and log it to
      // llm_usage (the one-shot path is logged automatically by
      // llm.sendOneShot, but streaming yields raw and the consumer is
      // responsible).
      let collected = '';
      let usageData = null;
      try {
        const streamStart = Date.now();
        const stream = llmService.sendMessageStreamWithPrompt(userMessage, conversationId, {
          prompt,
          model: modelString,
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
              durationMs:   chunk.durationMs   || (Date.now() - streamStart),
            };
          }
          // Other chunk types (function calls, etc.) are ignored in P1.
        }
      } catch (err) {
        emit('addon.error', {
          instanceId: instance.instanceId,
          error: { code: 'llm_failed', message: err.message },
        });
        continue;
      }

      if (usageData) {
        console.log(`📊 [BuilderRunner] usage: ${instance.pluginId} (${modelString}) in=${usageData.inputTokens} out=${usageData.outputTokens}`);
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
      } else {
        console.warn(`⚠️ [BuilderRunner] no usage chunk for streaming ${instance.pluginId} (${modelString})`);
      }

      assistantText = collected;
      emit('addon.output', {
        instanceId:   instance.instanceId,
        rawOutput:    collected,
        parsedOutput: null,
        memoryWrites: [],
        tokens:       usageData
          ? { input: usageData.inputTokens, output: usageData.outputTokens, total: usageData.inputTokens + usageData.outputTokens }
          : { input: 0, output: 0, total: 0 },
        durationMs:   Date.now() - addonStart,
      });
    } else {
      // One-shot for json-producing addons. `jsonOutput` flips on the
      // provider's structured-output mode (OpenAI json_object,
      // Google responseMimeType, Claude prompt suffix). Driven by the
      // addon's outputType — no plugin-id branching.
      let raw = '';
      try {
        const result = await llmService.sendOneShot(prompt, userMessage, {
          model: modelString,
          jsonOutput: wantsJson,
          context: usageProcess,
          agentName: agentNameForLogs,
          crewMember: usageCrew,
          conversationId: String(conversationId),
          userId: ownerUserId,
        });
        raw = typeof result === 'string' ? result : (result?.text || '');
      } catch (err) {
        emit('addon.error', {
          instanceId: instance.instanceId,
          error: { code: 'llm_failed', message: err.message },
        });
        continue;
      }

      const { parsed, error } = parseOutput(instance.outputType || 'json-to-memory', raw);

      // Build memoryWrites from parsed_output ∩ extractor's field
      // definitions. Merge them into the conversation memory blob
      // so downstream addons (this turn) and future turns see them.
      const memoryWrites = [];
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const fields = Array.isArray(instance.config?.fields) ? instance.config.fields : [];
        for (const f of fields) {
          if (Object.prototype.hasOwnProperty.call(parsed, f.name)) {
            const value = parsed[f.name];
            if (value !== null && value !== undefined) {
              memoryWrites.push({ domain: f.domain || null, field: f.name, value });
            }
          }
        }
      }

      if (memoryWrites.length > 0) {
        builderMemory.applyWrites(memory, memoryWrites);
        console.log(`💾 [BuilderRunner] memory writes from ${instance.pluginId}:`, JSON.stringify(memoryWrites), 'merged memory:', JSON.stringify(memory));
        try {
          await builderMemory.saveMemory(userId, conversationId, memory);
        } catch (err) {
          console.error('[BuilderRunner] memory save failed:', err.message);
        }
      } else {
        console.log(`💾 [BuilderRunner] no memory writes from ${instance.pluginId} (parsed=${JSON.stringify(parsed)})`);
      }

      emit('addon.output', {
        instanceId:   instance.instanceId,
        rawOutput:    raw,
        parsedOutput: parsed,
        memoryWrites,
        tokens:       { input: 0, output: 0, total: 0 },
        durationMs:   Date.now() - addonStart,
        ...(error ? { parseError: error } : {}),
      });
    }
  }

  return { assistantText, totalMs: Date.now() - totalStart };
}

module.exports = { runOnce };
