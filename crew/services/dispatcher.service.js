/**
 * Dispatcher Service
 *
 * Routes messages to the appropriate crew member and handles transitions.
 * The dispatcher determines which crew member should handle a message based on:
 * 1. Override provided in the request (for testing)
 * 2. Current crew member stored in conversation metadata
 * 3. Default crew member for the agent
 */
const crewService = require('./crew.service');
const conversationService = require('../../services/conversation.service');
const llmService = require('../../services/llm');

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
      message,
      conversationId,
      agentName,
      overrideCrewMember = null,
      useKnowledgeBase = false,
      agentConfig = {}
    } = params;

    // Get current crew member
    const crew = await this.getCurrentCrew(agentName, conversationId, overrideCrewMember);

    console.log(`🚀 Dispatching to crew: ${crew.name} (${crew.displayName})`);

    // Get conversation for context
    const conversation = await conversationService.getConversationByExternalId(conversationId);
    const collectedData = conversation?.metadata?.collectedData || {};

    // Build context from crew member
    const context = await crew.buildContext({
      conversation,
      user: {},
      collectedData,
      metadata: {}
    });

    // Pre-process message
    const processedMessage = await crew.preProcess(message, context);

    // Resolve knowledge base: crew config + client toggle
    // Crew member can explicitly disable KB (knowledgeBase.enabled = false)
    // storeId comes directly from crew member config (provider-specific)
    const crewKBEnabled = crew.knowledgeBase?.enabled !== false;
    const resolvedKB = (useKnowledgeBase && crewKBEnabled) ? {
      enabled: true,
      storeId: crew.knowledgeBase?.storeId || null
    } : null;

    // Build tool handler map from crew member tools
    // Maps call name (e.g., 'call_report_symptom') to handler function
    const toolHandlers = {};
    for (const tool of crew.tools) {
      if (tool.handler) {
        toolHandlers[`call_${tool.name}`] = tool.handler;
      }
    }

    // Build LLM config from crew member (provider-agnostic)
    const llmConfig = {
      prompt: crew.guidance,
      model: crew.model,
      maxTokens: crew.maxTokens,
      tools: crew.getToolSchemas(),
      toolHandlers,
      knowledgeBase: resolvedKB,
      agentConfig,
      context
    };

    // Stream response from LLM using inline prompt
    const stream = llmService.sendMessageStreamWithPrompt(
      processedMessage,
      conversationId,
      llmConfig
    );

    // Yield chunks from stream
    for await (const chunk of stream) {
      yield chunk;
    }
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

    // Check for transition
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
}

// Export singleton instance
module.exports = new DispatcherService();
