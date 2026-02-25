/**
 * Dispatcher Service
 *
 * Routes messages to the appropriate crew member and handles transitions.
 * Supports parallel field extraction via micro-agents with buffered streaming.
 *
 * The dispatcher determines which crew member should handle a message based on:
 * 1. Override provided in the request (for testing)
 * 2. Current crew member stored in conversation metadata
 * 3. Default crew member for the agent
 *
 * When a crew member has fieldsToCollect, the dispatcher runs a FieldsExtractorAgent
 * in parallel with the main crew response. Crew chunks are buffered until the extractor
 * completes, then either flushed (no transfer) or discarded (pre-transfer triggered).
 */
const crewService = require('./crew.service');
const conversationService = require('../../services/conversation.service');
const agentContextService = require('../../services/agentContext.service');
const llmService = require('../../services/llm');
const fieldsExtractor = require('../micro-agents/FieldsExtractorAgent');
const promptService = require('../../services/prompt.service');
const CrewMember = require('../base/CrewMember');

class DispatcherService {
  constructor() {
    // No state management needed - override comes with each request
  }

  /**
   * Get the current crew member for a conversation
   *
   * Priority:
   * 1. Override provided in request
   * 2. currentCrewMember from conversation metadata
   * 3. Default crew for the agent
   *
   * @param {string} agentName - Name of the agent
   * @param {string} conversationId - External conversation ID
   * @param {string} overrideCrewName - Optional override crew name
   * @returns {Promise<CrewMember>} - The crew member to use
   */
  async getCurrentCrew(agentName, conversationId, overrideCrewName = null) {
    // 1. Check for override
    if (overrideCrewName) {
      const overrideCrew = await crewService.getCrewMember(agentName, overrideCrewName);
      if (overrideCrew) {
        console.log(`🔄 Using override crew: ${overrideCrewName}`);
        return overrideCrew;
      }
      console.warn(`⚠️ Override crew not found: ${overrideCrewName}, falling back`);
    }

    // 2. Check conversation metadata for current crew
    if (conversationId) {
      const conversation = await conversationService.getConversationByExternalId(conversationId);
      if (conversation?.currentCrewMember) {
        const crew = await crewService.getCrewMember(agentName, conversation.currentCrewMember);
        if (crew) {
          console.log(`📍 Using conversation's current crew: ${conversation.currentCrewMember}`);
          return crew;
        }
      }
      // Also check metadata (backward compatibility)
      if (conversation?.metadata?.currentCrewMember) {
        const crew = await crewService.getCrewMember(agentName, conversation.metadata.currentCrewMember);
        if (crew) {
          console.log(`📍 Using crew from metadata: ${conversation.metadata.currentCrewMember}`);
          return crew;
        }
      }
    }

    // 3. Fall back to default crew
    const defaultCrew = await crewService.getDefaultCrew(agentName);
    if (defaultCrew) {
      console.log(`🏠 Using default crew: ${defaultCrew.name}`);
      return defaultCrew;
    }

    throw new Error(`No crew member found for agent: ${agentName}`);
  }

  /**
   * Dispatch a message to the appropriate crew member (streaming)
   *
   * If the crew member has fieldsToCollect, runs the fields extractor in parallel
   * with the main crew response using a buffered streaming strategy.
   *
   * @param {Object} params - Dispatch parameters
   * @param {string} params.message - User's message
   * @param {string} params.conversationId - External conversation ID
   * @param {string} params.agentName - Name of the agent
   * @param {string} params.overrideCrewMember - Optional crew override
   * @param {boolean} params.useKnowledgeBase - Whether client wants KB (toggle)
   * @param {Object} params.agentConfig - Agent config from database (provider-specific details)
   * @returns {AsyncGenerator} - Stream of response chunks
   */
  async *dispatch(params) {
    const {
      conversationId,
      agentName,
      overrideCrewMember = null
    } = params;

    // Get current crew member
    const crew = await this.getCurrentCrew(agentName, conversationId, overrideCrewMember);

    console.log(`🚀 Dispatching to crew: ${crew.name} (${crew.displayName})`);

    // Ensure currentCrewMember is set in DB (important for fields endpoint)
    // This handles the case where default crew is used but never explicitly set
    if (conversationId) {
      const conversation = await conversationService.getConversationByExternalId(conversationId);
      if (conversation && !conversation.currentCrewMember) {
        await conversationService.updateCurrentCrewMember(conversationId, crew.name);
        console.log(`📝 Set initial currentCrewMember to: ${crew.name}`);
      }
    }

    // Always yield crew_info at the start so client knows current crew
    // This is essential for the fields panel to load the correct field definitions
    yield { type: 'crew_info', crew: crew.toJSON() };

    // ========== ONE-SHOT CREW CHECK ==========
    // If crew is oneShot and has already delivered, skip to transitionTo
    if (crew.oneShot && crew.transitionTo) {
      const conversation = await conversationService.getConversationByExternalId(conversationId);
      const oneShotDelivered = conversation?.metadata?.oneShotDelivered || {};

      if (oneShotDelivered[crew.name]) {
        console.log(`⚡ OneShot crew ${crew.name} already delivered, transitioning to ${crew.transitionTo}`);

        // Update conversation's current crew member BEFORE yielding (prevents race condition)
        await conversationService.updateCurrentCrewMember(conversationId, crew.transitionTo);

        // Yield transition event
        yield {
          type: 'crew_transition',
          transition: {
            from: crew.name,
            to: crew.transitionTo,
            reason: 'OneShot crew already delivered',
            timestamp: new Date().toISOString()
          }
        };

        // Get target crew and stream its response
        const targetCrew = await crewService.getCrewMember(agentName, crew.transitionTo);
        if (targetCrew) {
          yield { type: 'crew_info', crew: targetCrew.toJSON() };
          yield* this._streamCrew(targetCrew, params);
        }
        return;
      }
    }

    // Check if crew has fields to collect (triggers parallel extraction)
    const hasFieldsToCollect = crew.fieldsToCollect && crew.fieldsToCollect.length > 0;

    if (!hasFieldsToCollect) {
      // No fields to collect → original streaming path (zero overhead)
      yield* this._streamCrew(crew, params);
      return;
    }

    // ========== EARLY PRE-TRANSFER CHECK ==========
    // If all fields were already collected (from previous messages),
    // transition immediately without starting the crew stream or extractor.
    if (crew.transitionTo) {
      // Set context user early for crews that may use getContext in preMessageTransfer
      const conversation = await conversationService.getConversationByExternalId(conversationId);
      if (conversation?.userId) {
        crew.setContextUser(conversation.userId, conversation.id, conversationId);
      }

      const existingFields = await agentContextService.getCollectedFields(conversationId);
      const missingFields = await agentContextService.getMissingFields(conversationId, crew.fieldsToCollect);

      if (missingFields.length === 0) {
        const shouldTransferEarly = await crew.preMessageTransfer(existingFields);
        if (shouldTransferEarly) {
          console.log(`⚡ Early pre-transfer: all fields already collected, transitioning ${crew.name} → ${crew.transitionTo}`);

          // Update conversation's current crew member BEFORE yielding (prevents race condition)
          await conversationService.updateCurrentCrewMember(conversationId, crew.transitionTo);

          yield { type: 'crew_transition', transition: {
            from: crew.name,
            to: crew.transitionTo,
            reason: 'All required fields already collected',
            timestamp: new Date().toISOString()
          }};

          const targetCrew = await crewService.getCrewMember(agentName, crew.transitionTo);
          if (targetCrew) {
            yield { type: 'crew_info', crew: targetCrew.toJSON() };
            yield* this._streamCrew(targetCrew, params);
          }
          return;
        }
      }
    }

    // ========== BUFFERED PARALLEL EXECUTION ==========
    // Run extractor and crew stream in parallel, buffer crew chunks
    // until extractor completes, then decide to flush or discard.

    console.log(`🔍 Crew ${crew.name} has ${crew.fieldsToCollect.length} fields to collect, running extractor in parallel`);

    // Start extractor in background (non-blocking)
    let extractorDone = false;
    let extractorResult = null;

    const extractorPromise = this._runExtractor(crew, params)
      .then(result => {
        extractorDone = true;
        extractorResult = result;
        return result;
      })
      .catch(err => {
        console.error('❌ Extractor failed:', err.message);
        extractorDone = true;
        extractorResult = { newFields: {}, allCollected: {}, remainingFields: crew.fieldsToCollect.map(f => f.name) };
        return extractorResult;
      });

    // Start crew stream in parallel
    const crewStream = this._streamCrew(crew, params);

    const buffer = [];
    let bufferProcessed = false;
    let shouldTransfer = false;

    for await (const chunk of crewStream) {
      if (!extractorDone) {
        // Extractor still running → buffer this chunk
        buffer.push(chunk);
        continue;
      }

      // Extractor finished → process results once
      if (!bufferProcessed) {
        bufferProcessed = true;

        // Check preMessageTransfer
        shouldTransfer = await crew.preMessageTransfer(extractorResult.allCollected);

        if (shouldTransfer) {
          // Discard buffer - don't yield any buffered chunks
          console.log(`🔄 preMessageTransfer triggered for ${crew.name}, discarding response`);
          break;
        }

        // No transfer → yield field events, flush buffer, continue streaming
        for (const [field, value] of Object.entries(extractorResult.newFields)) {
          yield { type: 'field_extracted', field, value };
        }

        for (const buffered of buffer) {
          yield buffered;
        }
        buffer.length = 0;
      }

      // Normal streaming (buffer already flushed)
      yield chunk;
    }

    // ========== POST-LOOP PROCESSING ==========
    // If extractor wasn't done when crew stream ended, wait for it now
    if (!extractorDone) {
      console.log('⏳ Crew stream ended, waiting for extractor...');
      await extractorPromise;
    }

    // Process extractor results if the buffer wasn't processed during the loop
    // (this covers: crew stream ended before extractor, or crew produced no chunks)
    if (!bufferProcessed) {
      bufferProcessed = true;
      shouldTransfer = await crew.preMessageTransfer(extractorResult.allCollected);

      if (!shouldTransfer) {
        // Yield field events and flush buffer
        for (const [field, value] of Object.entries(extractorResult.newFields)) {
          yield { type: 'field_extracted', field, value };
        }
        for (const buffered of buffer) {
          yield buffered;
        }
      }
    }

    // ========== DEBUG: POST-EXTRACTION CONTEXT ==========
    if (params.debug && extractorResult) {
      yield {
        type: 'debug_context_update',
        data: {
          extractedFields: extractorResult.newFields,
          allCollectedFields: extractorResult.allCollected,
          remainingFields: extractorResult.remainingFields,
        }
      };
    }

    // ========== HANDLE TRANSITION ==========
    if (shouldTransfer && crew.transitionTo) {
      // Yield field events for any newly extracted fields
      for (const [field, value] of Object.entries(extractorResult.newFields)) {
        yield { type: 'field_extracted', field, value };
      }

      // Update conversation's current crew member BEFORE yielding (prevents race condition)
      await conversationService.updateCurrentCrewMember(conversationId, crew.transitionTo);

      // Yield transition event
      const transition = {
        from: crew.name,
        to: crew.transitionTo,
        reason: 'Required fields collected',
        timestamp: new Date().toISOString()
      };
      yield { type: 'crew_transition', transition };

      // Get target crew and stream its response
      const targetCrew = await crewService.getCrewMember(agentName, crew.transitionTo);
      if (targetCrew) {
        console.log(`🎯 Streaming response from target crew: ${targetCrew.name}`);

        // Send updated crew info
        yield { type: 'crew_info', crew: targetCrew.toJSON() };

        yield* this._streamCrew(targetCrew, params);
      }
    }
  }

  /**
   * Stream response from a crew member (extracted from original dispatch logic)
   *
   * @param {Object} crew - CrewMember instance
   * @param {Object} params - Dispatch parameters
   * @returns {AsyncGenerator} - Stream of response chunks
   * @private
   */
  async *_streamCrew(crew, params) {
    const {
      message,
      conversationId,
      agentName,
      useKnowledgeBase = false,
      agentConfig = {},
      promptOverrides = {}, // Session overrides: { crewName: prompt }
      modelOverrides = {}   // Session overrides: { crewName: modelName }
    } = params;

    // Get conversation for context
    const conversation = await conversationService.getConversationByExternalId(conversationId);
    const collectedData = conversation?.metadata?.collectedData || {};

    // Get collected fields from context service
    const collectedFields = await agentContextService.getCollectedFields(conversationId);

    // Set context user for crew's getContext/writeContext methods
    if (conversation?.userId) {
      crew.setContextUser(conversation.userId, conversation.id, conversationId);
    }

    // Build context from crew member
    const context = await crew.buildContext({
      conversation,
      user: {},
      collectedData,
      collectedFields,
      metadata: {}
    });

    // Pre-process message
    const processedMessage = await crew.preProcess(message, context);

    // ========== RESOLVE PROMPT ==========
    // Priority: 1. Session override → 2. DB active → 3. Code default
    let resolvedPrompt = crew.guidance;
    let promptSource = 'code';

    // Debug: log received overrides and current crew
    console.log(`🔍 Prompt resolution for crew: "${crew.name}"`);
    console.log(`🔍 Received promptOverrides keys:`, Object.keys(promptOverrides));
    if (Object.keys(promptOverrides).length > 0) {
      console.log(`🔍 Override for "${crew.name}" exists:`, crew.name in promptOverrides);
    }

    // Variables to track DB prompt for transition system prompt resolution
    let dbPrompt = null;

    // Check for session override
    if (promptOverrides[crew.name]) {
      resolvedPrompt = promptOverrides[crew.name];
      promptSource = 'session_override';
      console.log(`📝 Using session override prompt for ${crew.name} (${resolvedPrompt.substring(0, 50)}...)`);
    } else {
      // Try to get active prompt from database
      try {
        dbPrompt = await promptService.getActivePrompt(agentName, crew.name);
        if (dbPrompt) {
          resolvedPrompt = dbPrompt.prompt;
          promptSource = 'database';
          console.log(`📝 Using DB prompt for ${crew.name} (v${dbPrompt.version})`);
        }
      } catch (err) {
        // DB not available or error - use code default
        console.log(`📝 Using code-defined prompt for ${crew.name} (DB unavailable)`);
      }
    }

    // ========== RESOLVE MODEL ==========
    // Priority: 1. Session override → 2. Crew default
    let resolvedModel = crew.model;
    let modelSource = 'crew_default';

    // Debug: log received model overrides
    console.log(`🔍 Model resolution for crew: "${crew.name}"`);
    console.log(`🔍 Received modelOverrides:`, modelOverrides);
    console.log(`🔍 Crew default model: ${crew.model}`);

    if (modelOverrides[crew.name]) {
      resolvedModel = modelOverrides[crew.name];
      modelSource = 'session_override';
      console.log(`✅ Using session override model for ${crew.name}: ${resolvedModel}`);
    } else if (Object.keys(modelOverrides).length > 0) {
      console.log(`⚠️ Model overrides exist but none match crew "${crew.name}". Keys: [${Object.keys(modelOverrides).join(', ')}]`);
    }

    console.log(`🤖 Final model for ${crew.name}: ${resolvedModel} (source: ${modelSource})`)

    // ========== RESOLVE TRANSITION SYSTEM PROMPT ==========
    // Priority: DB value > code value (same as regular prompt)
    let resolvedTransitionPrompt = crew.transitionSystemPrompt || null;
    if (dbPrompt?.transitionSystemPrompt) {
      resolvedTransitionPrompt = dbPrompt.transitionSystemPrompt;
    }

    // Detect if this is a new crew transition (need to inject system prompt)
    const lastCrewWithPrompt = conversation?.metadata?.lastCrewWithTransitionPrompt;
    const isNewCrewTransition = resolvedTransitionPrompt && lastCrewWithPrompt !== crew.name;

    if (isNewCrewTransition) {
      console.log(`🔄 Transition system prompt will be injected for ${crew.name} (previous: ${lastCrewWithPrompt || 'none'})`);
    }

    // Resolve knowledge base: crew config + client toggle
    // Uses explicit provider IDs from crew config (no auto-routing by model)
    const crewKBEnabled = crew.knowledgeBase?.enabled !== false;
    const resolvedKB = (useKnowledgeBase && crewKBEnabled) ? {
      enabled: true,
      storeId: crew.knowledgeBase?.storeId || null,
      googleCorpusId: crew.knowledgeBase?.googleCorpusId || null,
    } : null;

    // Auto-inject knowledge base note into context when KB is active
    if (resolvedKB) {
      context.knowledgeBaseNote = 'You have access to an internal knowledge base for reference. These are NOT files uploaded by the user - never mention seeing uploaded files or documents. Use this information to answer questions accurately without referencing the source files directly.';
    }

    // Build tool handler map from crew member tools
    const toolHandlers = {};
    for (const tool of crew.tools) {
      if (tool.handler) {
        toolHandlers[`call_${tool.name}`] = tool.handler;
      }
    }

    // Build LLM config from crew member (provider-agnostic)
    const llmConfig = {
      prompt: resolvedPrompt,
      model: resolvedModel,
      maxTokens: crew.maxTokens,
      tools: crew.getToolSchemas(),
      toolHandlers,
      knowledgeBase: resolvedKB,
      agentConfig,
      context,
      transitionSystemPrompt: resolvedTransitionPrompt,
      isNewCrewTransition
    };

    // Emit debug data if requested (before LLM call)
    if (params.debug) {
      // Build fullInstructions exactly as llm.openai.js does
      let fullInstructions = resolvedPrompt;
      if (context && Object.keys(context).length > 0) {
        fullInstructions += `\n\n## Current Context\n${JSON.stringify(context, null, 2)}`;
      }

      // Build transition logic debug data
      const transitionLogic = this._buildTransitionDebugData(crew, collectedFields);

      yield {
        type: 'debug_prompt',
        data: {
          crewName: crew.name,
          crewDisplayName: crew.displayName,
          fullInstructions,
          promptSource,
          model: resolvedModel,
          modelSource, // 'session_override' or 'crew_default'
          defaultModel: crew.model, // Original hardcoded model for comparison
          maxTokens: crew.maxTokens,
          tools: crew.getToolSchemas(),
          knowledgeBase: resolvedKB,
          processedMessage,
          transitionSystemPrompt: resolvedTransitionPrompt,
          transitionPromptInjected: isNewCrewTransition,
          transitionLogic,
        }
      };
    }

    // Stream response from LLM using inline prompt
    const stream = llmService.sendMessageStreamWithPrompt(
      processedMessage,
      conversationId,
      llmConfig
    );

    for await (const chunk of stream) {
      yield chunk;
    }

    // Update metadata after successful streaming if transition prompt was injected
    if (isNewCrewTransition) {
      try {
        await conversationService.updateConversationMetadata(conversationId, {
          lastCrewWithTransitionPrompt: crew.name
        });
        console.log(`✅ Updated lastCrewWithTransitionPrompt to ${crew.name}`);
      } catch (err) {
        console.warn('⚠️ Could not update transition prompt metadata:', err.message);
      }
    }

    // ========== MARK ONE-SHOT AS DELIVERED ==========
    // If this is a oneShot crew, mark it as delivered so next message transitions
    if (crew.oneShot && crew.transitionTo) {
      try {
        const existingMetadata = conversation?.metadata || {};
        const oneShotDelivered = existingMetadata.oneShotDelivered || {};
        oneShotDelivered[crew.name] = true;

        await conversationService.updateConversationMetadata(conversationId, {
          oneShotDelivered
        });
        console.log(`✅ Marked oneShot crew ${crew.name} as delivered`);
      } catch (err) {
        console.warn('⚠️ Could not update oneShot metadata:', err.message);
      }
    }

    // ========== POST-MESSAGE TRANSFER CHECK ==========
    // For crews that use tools/context instead of fieldsToCollect,
    // check postMessageTransfer after streaming completes
    if (crew.transitionTo && typeof crew.postMessageTransfer === 'function') {
      const shouldTransfer = await crew.postMessageTransfer(collectedFields);

      if (shouldTransfer) {
        console.log(`🔄 postMessageTransfer triggered: ${crew.name} → ${crew.transitionTo}`);

        // Update conversation's current crew member BEFORE yielding (prevents race condition)
        await conversationService.updateCurrentCrewMember(conversationId, crew.transitionTo);

        // Yield transition event
        yield {
          type: 'crew_transition',
          transition: {
            from: crew.name,
            to: crew.transitionTo,
            reason: 'Post-message transfer condition met',
            timestamp: new Date().toISOString()
          }
        };

        // Get target crew and stream its response
        const targetCrew = await crewService.getCrewMember(agentName, crew.transitionTo);
        if (targetCrew) {
          console.log(`🎯 Streaming response from target crew: ${targetCrew.name}`);
          yield { type: 'crew_info', crew: targetCrew.toJSON() };
          yield* this._streamCrew(targetCrew, params);
        }
      }
    }
  }

  /**
   * Run the fields extractor micro-agent
   *
   * @param {Object} crew - CrewMember instance (with fieldsToCollect)
   * @param {Object} params - Dispatch parameters
   * @returns {Promise<Object>} - { newFields: {}, allCollected: {}, remainingFields: [] }
   * @private
   */
  async _runExtractor(crew, params) {
    const { message, conversationId } = params;

    // Get already collected fields
    const collectedFields = await agentContextService.getCollectedFields(conversationId);

    // Check if all fields already collected (skip extraction - but not in form mode, which supports corrections)
    const isFormMode = crew.extractionMode === 'form';
    const missingFields = await agentContextService.getMissingFields(conversationId, crew.fieldsToCollect);
    if (missingFields.length === 0 && !isFormMode) {
      console.log('✅ All fields already collected, skipping extraction');
      return { newFields: {}, allCollected: collectedFields, remainingFields: [] };
    }

    // Get recent messages for context (last 10 messages)
    let recentMessages = [];
    try {
      const history = await conversationService.getConversationHistory(conversationId, 10);
      recentMessages = history.map(m => ({ role: m.role, content: m.content }));
    } catch (err) {
      console.warn('⚠️ Could not load message history for extractor:', err.message);
    }

    // Add the current message (not yet in DB history)
    recentMessages.push({ role: 'user', content: message });

    // Use getFieldsForExtraction to let crews control which fields are active
    // In form mode, send all active fields (supports corrections like rejected→approved)
    // In conversational mode, only send missing active fields (prevents re-extraction)
    const activeFields = crew.getFieldsForExtraction(collectedFields);
    const fieldsStillNeeded = isFormMode
      ? activeFields
      : activeFields.filter(f => !collectedFields[f.name]);

    // Run extractor
    console.log(`🔍 Running fields extractor for ${fieldsStillNeeded.length} fields (mode: ${crew.extractionMode || 'conversational'})`);
    const result = await fieldsExtractor.extract({
      recentMessages,
      fieldsToCollect: fieldsStillNeeded,
      collectedFields,
      extractionMode: crew.extractionMode
    });

    // Identify newly extracted fields (not previously collected)
    // Filter out empty/null/undefined values - these are not real extractions
    const newFields = {};
    for (const [field, value] of Object.entries(result.extractedFields)) {
      if (value !== null && value !== undefined && value !== '' && !collectedFields[field]) {
        newFields[field] = value;
      }
    }

    // Handle corrections (form mode only - fields user explicitly corrected)
    // Also filter out empty values from corrections
    const corrections = {};
    for (const [field, value] of Object.entries(result.corrections || {})) {
      if (value !== null && value !== undefined && value !== '') {
        corrections[field] = value;
      }
    }
    if (Object.keys(corrections).length > 0) {
      console.log(`✏️ User corrected ${Object.keys(corrections).length} fields:`, Object.keys(corrections).join(', '));
    }

    // Merge new fields and corrections
    const fieldsToUpdate = { ...newFields, ...corrections };

    // Update collected fields in context service
    let allCollected = collectedFields;
    if (Object.keys(fieldsToUpdate).length > 0) {
      allCollected = await agentContextService.updateCollectedFields(conversationId, fieldsToUpdate);
      if (Object.keys(newFields).length > 0) {
        console.log(`📝 Extracted ${Object.keys(newFields).length} new fields:`, Object.keys(newFields).join(', '));
      }
    }

    return {
      newFields: fieldsToUpdate,
      allCollected,
      remainingFields: result.remainingFields
    };
  }

  /**
   * Handle post-response processing (transitions, field updates)
   *
   * @param {Object} params - Post-response parameters
   * @param {string} params.agentName - Name of the agent
   * @param {string} params.conversationId - External conversation ID
   * @param {string} params.message - Original user message
   * @param {string} params.response - LLM's response
   * @param {Object} params.collectedData - Any collected data
   * @param {string} params.currentCrewName - Current crew member name
   * @returns {Promise<Object|null>} - Transition info if transition occurred
   */
  async handlePostResponse(params) {
    const {
      agentName,
      conversationId,
      message,
      response,
      collectedData = {},
      currentCrewName
    } = params;

    // Get current crew member
    const crew = await crewService.getCrewMember(agentName, currentCrewName);
    if (!crew) {
      return null;
    }

    // Check postMessageTransfer if crew has fields
    if (crew.fieldsToCollect && crew.fieldsToCollect.length > 0 && crew.transitionTo) {
      const collectedFields = await agentContextService.getCollectedFields(conversationId);
      const shouldTransfer = await crew.postMessageTransfer(collectedFields);

      if (shouldTransfer) {
        console.log(`🔄 postMessageTransfer triggered: ${crew.name} → ${crew.transitionTo}`);

        const targetCrew = await crewService.getCrewMember(agentName, crew.transitionTo);
        if (!targetCrew) {
          console.warn(`⚠️ Target crew not found: ${crew.transitionTo}`);
          return null;
        }

        await conversationService.updateCurrentCrewMember(conversationId, crew.transitionTo);

        return {
          from: crew.name,
          to: crew.transitionTo,
          reason: 'Post-message transfer: required fields collected',
          timestamp: new Date().toISOString()
        };
      }
    }

    // Check legacy transition mechanism
    const transition = await crew.checkTransition({
      message,
      response,
      conversation: await conversationService.getConversationByExternalId(conversationId),
      collectedData
    });

    if (transition && transition.targetCrew) {
      console.log(`🔄 Transitioning from ${crew.name} to ${transition.targetCrew}: ${transition.reason}`);

      // Verify target crew exists
      const targetCrew = await crewService.getCrewMember(agentName, transition.targetCrew);
      if (!targetCrew) {
        console.warn(`⚠️ Target crew not found: ${transition.targetCrew}`);
        return null;
      }

      // Update conversation's current crew member
      await conversationService.updateCurrentCrewMember(conversationId, transition.targetCrew);

      return {
        from: crew.name,
        to: transition.targetCrew,
        reason: transition.reason,
        timestamp: new Date().toISOString()
      };
    }

    return null;
  }

  /**
   * Get crew info for sending to client
   *
   * @param {string} agentName - Name of the agent
   * @param {string} conversationId - External conversation ID
   * @param {string} overrideCrewMember - Optional override
   * @returns {Promise<Object>} - Crew info for client
   */
  async getCrewInfo(agentName, conversationId, overrideCrewMember = null) {
    const crew = await this.getCurrentCrew(agentName, conversationId, overrideCrewMember);
    return crew ? crew.toJSON() : null;
  }

  /**
   * Build transition logic debug data for a crew member.
   * If crew has transitionRules, evaluates them and returns structured results.
   * Otherwise, extracts raw function code as fallback.
   *
   * @param {Object} crew - CrewMember instance
   * @param {Object} collectedFields - Current collected fields
   * @returns {Object|null} - Transition debug data or null if no transition logic
   * @private
   */
  _buildTransitionDebugData(crew, collectedFields) {
    // Check if crew has custom transfer methods (not the base class defaults)
    const hasCustomPre = crew.preMessageTransfer !== CrewMember.prototype.preMessageTransfer;
    const hasCustomPost = crew.postMessageTransfer !== CrewMember.prototype.postMessageTransfer;

    // No transition logic at all
    if (!hasCustomPre && !hasCustomPost && !crew.oneShot && !crew.transitionTo) {
      return null;
    }

    const hasStructuredRules = crew.transitionRules && crew.transitionRules.length > 0;

    // Build structured rules evaluation if available
    let evaluatedRules = null;
    if (hasStructuredRules) {
      evaluatedRules = {
        pre: this._evaluateTransitionRules(crew, 'pre', collectedFields),
        post: this._evaluateTransitionRules(crew, 'post', collectedFields),
      };
    }

    // Extract raw function code as fallback
    let rawCode = null;
    if (!hasStructuredRules) {
      rawCode = {
        pre: hasCustomPre ? crew.preMessageTransfer.toString() : null,
        post: hasCustomPost ? crew.postMessageTransfer.toString() : null,
      };
    }

    return {
      transitionTo: crew.transitionTo,
      oneShot: crew.oneShot,
      hasPreTransfer: hasCustomPre,
      hasPostTransfer: hasCustomPost,
      hasStructuredRules,
      evaluatedRules,
      rawCode,
      collectedFields: collectedFields || {},
    };
  }

  /**
   * Evaluate transition rules of a specific type for a crew member.
   *
   * @param {Object} crew - CrewMember instance
   * @param {string} type - Rule type: 'pre' or 'post'
   * @param {Object} fields - Current collected fields
   * @returns {Array} - Evaluated rule results [{id, description, fields, passed, result}]
   * @private
   */
  _evaluateTransitionRules(crew, type, fields) {
    if (!crew.transitionRules) return [];

    const rules = crew.transitionRules
      .filter(r => r.type === type)
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));

    return rules.map(rule => {
      let passed = false;
      try {
        passed = !!rule.condition.evaluate(fields || {}, {});
      } catch (err) {
        console.warn(`⚠️ Error evaluating transition rule ${rule.id}:`, err.message);
      }
      return {
        id: rule.id,
        description: rule.condition.description,
        fields: rule.condition.fields || [],
        passed,
        result: rule.result,
      };
    });
  }
}

// Export singleton instance
module.exports = new DispatcherService();
