const conversationService = require('./conversation.service');
const crewService = require('../crew/services/crew.service');
const dispatcherService = require('../crew/services/dispatcher.service');
const llmService = require('./llm');
const thinkingService = require('./thinking.service');

/**
 * Run a single, non-streaming chat turn.
 *
 * Buffered alternative to the SSE /api/finance-assistant/stream endpoint.
 * Performs the same DB writes (user message + assistant message + transitions);
 * returns JSON instead of streaming.
 *
 * Used by:
 *  - POST /api/finance-assistant/turn  (HTTP entry point)
 *  - test-runner.service advanceConversationTurn (server-side scripts)
 */
async function runChatTurn({
  message,
  conversationId,
  agentName,
  userId = null,
  overrideCrewMember,
  promptOverrides,
  modelOverrides,
  fallbackOverrides,
  personaOverride,
  kbOverrides,
  thinkingPromptOverrides,
  thinkingModelOverrides,
  thinkerDisabled,
  temperatureOverrides,
  topKOverrides,
  restrictedMode = false,
}) {
  if (!message || !conversationId) {
    throw new Error('runChatTurn requires message and conversationId');
  }

  const agentNameToUse = agentName || 'Aspect';
  const agent = await conversationService.getAgentByName(agentNameToUse);

  thinkingService.startContext(conversationId, null, null);
  thinkingService.addMessageReceivedStep(conversationId, message);

  try {
    const { message: userMsg } = await conversationService.saveUserMessage(
      conversationId,
      agentNameToUse,
      message,
      userId || null
    );

    const agentConfig = agent.config || {};
    const hasCrew = await crewService.hasCrew(agentNameToUse);

    let fullReply = '';
    let currentCrewName = null;
    let currentCrewDisplayName = null;
    let modelUsedData = null;
    let usageData = null;
    const crewTransitions = [];

    if (hasCrew) {
      const crewInfo = await dispatcherService.getCrewInfo(agentNameToUse, conversationId, overrideCrewMember);
      if (crewInfo) {
        currentCrewName = crewInfo.name;
        currentCrewDisplayName = crewInfo.displayName;
      }

      let inlineTransition = null;

      for await (const chunk of dispatcherService.dispatch({
        message,
        conversationId,
        agentName: agentNameToUse,
        overrideCrewMember,
        agentConfig,
        debug: false,
        promptOverrides: promptOverrides || {},
        modelOverrides: modelOverrides || {},
        fallbackOverrides: fallbackOverrides || {},
        personaOverride: personaOverride || undefined,
        kbOverrides: kbOverrides || {},
        thinkingPromptOverrides: thinkingPromptOverrides || {},
        thinkingModelOverrides: thinkingModelOverrides || {},
        thinkerDisabled: thinkerDisabled || {},
        temperatureOverrides: temperatureOverrides || {},
        topKOverrides: topKOverrides || {},
        agentId: agent?.id || null,
        restrictedMode: !!restrictedMode,
      })) {
        if (typeof chunk === 'object' && chunk.type) {
          if (chunk.type === 'model_used') {
            modelUsedData = { model: chunk.model, modelUsed: chunk.modelUsed, fallbackUsed: chunk.fallbackUsed };
          } else if (chunk.type === 'usage') {
            usageData = { inputTokens: chunk.inputTokens || 0, outputTokens: chunk.outputTokens || 0, durationMs: chunk.durationMs || null };
          } else if (chunk.type === 'crew_transition' && chunk.transition) {
            if (fullReply) {
              const firstMeta = {
                crewMember: currentCrewDisplayName || currentCrewName,
                transitionTo: chunk.transition.to,
                transitionReason: chunk.transition.reason,
              };
              await conversationService.saveAssistantMessage(conversationId, fullReply, firstMeta);
              crewTransitions.push({
                from: currentCrewDisplayName || currentCrewName,
                to: chunk.transition.to,
                reason: chunk.transition.reason,
                stage: 'pre',
              });
            }
            inlineTransition = chunk.transition;
            fullReply = '';
          } else if (chunk.type === 'crew_info' && chunk.crew) {
            currentCrewName = chunk.crew.name;
            currentCrewDisplayName = chunk.crew.displayName;
          }
        } else {
          fullReply += chunk;
        }
      }

      let transition = inlineTransition;
      if (!inlineTransition) {
        transition = await dispatcherService.handlePostResponse({
          agentName: agentNameToUse,
          conversationId,
          message,
          response: fullReply,
          currentCrewName,
        });
        if (transition) {
          crewTransitions.push({
            from: currentCrewDisplayName || currentCrewName,
            to: transition.to,
            reason: transition.reason,
            stage: 'post',
          });
        }
      }

      let savedAssistantMessage = null;
      if (fullReply) {
        const messageMetadata = {
          crewMember: currentCrewDisplayName || currentCrewName,
          ...(transition && { transitionTo: transition.to, transitionReason: transition.reason }),
          ...(modelUsedData && {
            model: modelUsedData.model,
            modelUsed: modelUsedData.modelUsed,
            fallbackUsed: modelUsedData.fallbackUsed,
          }),
        };
        savedAssistantMessage = await conversationService.saveAssistantMessage(
          conversationId,
          fullReply,
          messageMetadata
        );
        thinkingService.setMessageId(conversationId, savedAssistantMessage.id);
      }

      await thinkingService.endContext(conversationId);

      if (usageData) {
        const usedModel = modelUsedData?.modelUsed || modelUsedData?.model || 'unknown';
        const { logUsage } = require('./usageLogger');
        logUsage({
          process: 'conversation',
          model: usedModel,
          inputTokens: usageData.inputTokens,
          outputTokens: usageData.outputTokens,
          durationMs: usageData.durationMs || null,
          agentName: agentNameToUse,
          crewMember: currentCrewName,
          conversationId,
          userId: userId || null,
        });
      }

      return {
        reply: fullReply,
        crewMember: currentCrewDisplayName || currentCrewName,
        crewTransitions,
        conversationId,
        modelUsed: modelUsedData?.modelUsed || modelUsedData?.model || null,
        userMessageId: userMsg.id,
        assistantMessageId: savedAssistantMessage?.id || null,
      };
    }

    // Legacy non-crew path
    const legacyUseKB = !!agentConfig.vectorStoreId;
    for await (const chunk of llmService.sendMessageStream(message, conversationId, legacyUseKB, agentConfig)) {
      if (typeof chunk === 'object' && chunk.type) continue;
      fullReply += chunk;
    }
    let savedAssistantMessage = null;
    if (fullReply) {
      savedAssistantMessage = await conversationService.saveAssistantMessage(conversationId, fullReply);
      thinkingService.setMessageId(conversationId, savedAssistantMessage.id);
    }
    await thinkingService.endContext(conversationId);
    return {
      reply: fullReply,
      crewMember: null,
      crewTransitions: [],
      conversationId,
      modelUsed: null,
      userMessageId: userMsg.id,
      assistantMessageId: savedAssistantMessage?.id || null,
    };
  } catch (err) {
    if (thinkingService.hasActiveContext(conversationId)) {
      await thinkingService.endContext(conversationId);
    }
    throw err;
  }
}

module.exports = { runChatTurn };
