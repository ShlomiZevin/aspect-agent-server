const openaiService = require('./llm.openai');
const claudeService = require('./llm.claude');
const googleService = require('./llm.google');
const functionRegistry = require('./function-registry');
const { logUsage } = require('./usageLogger');
const modelsService = require('./models.service');

/**
 * Main LLM service that routes requests to specific providers
 * Supports OpenAI (primary for chat), Claude (for generation), and Google Gemini
 *
 * Function calls are handled at this layer (provider-agnostic)
 */
const errorCenter = require('../builder/services/errorCenter');
const errorRules = require('../builder/services/errorRules');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A model call failed: record it in the error center (task #903) with the
 * provider kind, and say whether to try again. Returns the wait in ms
 * before the next try, or null to give up (rethrow). Never throws itself.
 */
function noteModelError(err, model, call, attempt, canRetry) {
  try {
    let kind = errorCenter.classify(err);
    if (!kind.startsWith('model_')) kind = 'model_other';
    const retry = errorRules.ruleFor(kind).retry;
    const willRetry = !!(canRetry && retry && attempt < retry.times);
    errorCenter.record(err, {
      area: 'model',
      kind,
      code: String(call || 'call').slice(0, 60),
      group: model || 'unknown-model',
      detail: { model: model || null, attempt: attempt + 1, ...(willRetry ? { retried: true } : {}) },
    });
    return willRetry ? (retry.waitMs[attempt] ?? retry.waitMs[retry.waitMs.length - 1]) : null;
  } catch {
    return null;
  }
}

class LLMService {
  constructor() {
    this.provider = openaiService;  // Default provider for chat
    this.claude = claudeService;     // Claude provider for generation tasks
    this.google = googleService;     // Google Gemini provider
    this.functionRegistry = functionRegistry;
  }

  /**
   * Register a function that can be called by LLM
   * @param {string} name - Function name (e.g., "getWeather")
   * @param {Function} handler - Async function that receives params object
   * @param {Object} schema - Optional JSON schema for parameters
   */
  registerFunction(name, handler, schema = null) {
    this.functionRegistry.register(name, handler, schema);
  }

  /**
   * Unregister a function
   * @param {string} name - Function name to remove
   */
  unregisterFunction(name) {
    return this.functionRegistry.unregister(name);
  }

  /**
   * Get all registered function schemas for LLM tool definitions
   * @returns {Object[]}
   */
  getFunctionSchemas() {
    return this.functionRegistry.getSchemas();
  }

  /**
   * Send a message and get a response
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {Object} agentConfig - Agent configuration (promptId, vectorStoreId, etc.)
   * @returns {Promise<Object>} - Object with { reply: string, functionCalls: array }
   */
  async sendMessage(message, conversationId, agentConfig = {}) {
    return this.provider.sendMessage(message, conversationId, agentConfig);
  }

  /**
   * Send a message and get just the reply text (backward compatible)
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {Object} agentConfig - Agent configuration (promptId, vectorStoreId, etc.)
   * @returns {Promise<string>} - The assistant's reply text only
   */
  async sendMessageSimple(message, conversationId, agentConfig = {}) {
    const result = await this.provider.sendMessage(message, conversationId, agentConfig);
    return result.reply;
  }

  /**
   * Send a message and get a streaming response
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {boolean} useKnowledgeBase - Whether to use file_search tool
   * @param {Object} agentConfig - Agent configuration (promptId, vectorStoreId, etc.)
   * @returns {AsyncGenerator} - Stream of text chunks
   */
  async *sendMessageStream(message, conversationId, useKnowledgeBase, agentConfig = {}) {
    yield* this.provider.sendMessageStream(message, conversationId, useKnowledgeBase, agentConfig);
  }

  /**
   * Send a message with an inline prompt (for crew members) and get a streaming response
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {Object} config - Crew member config (prompt, model, maxTokens, tools, context)
   * @returns {AsyncGenerator} - Stream of text chunks
   */
  async *sendMessageStreamWithPrompt(message, conversationId, config = {}) {
    // Detect provider from model name
    const provider = this._getProviderForModel(config.model, 'crew');
    // Error center (#903): record a failed call with its kind; retry a rate
    // limit per builder/services/errorRules.js — only while nothing has
    // reached the caller yet, so a reply is never sent twice.
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const chunk of provider.sendMessageStreamWithPrompt(message, conversationId, config)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        const waitMs = noteModelError(err, config.model, 'stream', attempt, !yielded);
        if (waitMs == null) throw err;
        await sleep(waitMs);
      }
    }
  }

  /**
   * Determine which provider to use for a model.
   *
   * Reads from the central models registry (services/models.service.js)
   * — the single source of truth. Unknown models log a warning and
   * fall back to OpenAI rather than throwing, so a typo in a config
   * doesn't crash a live conversation; the fallback will likely 404
   * loudly enough that the bad config is obvious.
   *
   * @param {string} model — model id (e.g. 'gpt-4o', 'claude-sonnet-4-6')
   * @param {string} context — for logging (e.g. 'crew', 'one-shot')
   * @returns {Object} provider service
   * @private
   */
  _getProviderForModel(model, context = 'one-shot') {
    const contextLabel = context ? `[${context}] ` : '';

    if (!model) {
      console.log(`🤖 ${contextLabel}No model specified — defaulting to OpenAI`);
      return this.provider;
    }

    const providerId = modelsService.tryProviderOf(model);
    if (!providerId) {
      console.warn(`⚠️ ${contextLabel}Unknown model "${model}" — defaulting to OpenAI. Register it in services/models.service.js.`);
      return this.provider;
    }

    switch (providerId) {
      case 'anthropic':
        console.log(`🤖 ${contextLabel}Using Claude provider for model: ${model}`);
        return this.claude;
      case 'google':
        console.log(`🤖 ${contextLabel}Using Google provider for model: ${model}`);
        return this.google;
      case 'openai':
      default:
        console.log(`🤖 ${contextLabel}Using OpenAI provider for model: ${model}`);
        return this.provider;
    }
  }

  /**
   * Send a stateless, non-streaming one-shot request.
   * Used by micro-agents that need a simple request/response without
   * conversation state, streaming, or tool handling.
   *
   * @param {string} instructions - System instructions/prompt
   * @param {string} message - The user message content
   * @param {Object} options - { model, maxTokens, jsonOutput, context }
   * @returns {Promise<string>} - The response text
   */
  async sendOneShot(instructions, message, options = {}) {
    // Detect provider from model name (use context from options for logging)
    const provider = this._getProviderForModel(options.model, options.context || 'one-shot');
    let start;
    let result;
    // Error center (#903): record a failed call with its kind; retry a rate
    // limit per builder/services/errorRules.js.
    for (let attempt = 0; ; attempt++) {
      start = Date.now();
      try {
        result = await provider.sendOneShot(instructions, message, options);
        break;
      } catch (err) {
        const waitMs = noteModelError(err, options.model, options.context || 'one-shot', attempt, true);
        if (waitMs == null) throw err;
        await sleep(waitMs);
      }
    }
    const durationMs = Date.now() - start;

    // Providers return { text, usage, stopReason } — log usage and return just
    // the text for backward compat. `withMeta: true` returns { text,
    // stopReason, usage } instead, for callers that must tell a complete
    // answer from one cut off at the output limit (stopReason 'max_tokens',
    // in every provider's case — task #920).
    if (result && typeof result === 'object' && 'text' in result) {
      if (result.usage) {
        logUsage({
          process: options.context || 'one-shot',
          model: options.model || 'unknown',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          durationMs,
          agentName: options.agentName,
          crewMember: options.crewMember,
          conversationId: options.conversationId,
          userId: options.userId,
        });
      }
      if (options.withMeta) {
        return { text: result.text, stopReason: result.stopReason || null, usage: result.usage || null };
      }
      return result.text;
    }
    if (options.withMeta && typeof result === 'string') {
      return { text: result, stopReason: null, usage: null };
    }
    return result; // fallback if provider returns raw string
  }

  /**
   * Clear conversation history for a given conversation ID
   * @param {string} conversationId - The conversation to clear
   */
  clearConversation(conversationId) {
    return this.provider.clearConversation(conversationId);
  }

  // ============================================
  // Claude-specific methods (for crew generation)
  // ============================================

  /**
   * Generate a crew member configuration from a natural language description.
   * Uses Claude to interpret the description and generate a valid crew config.
   *
   * @param {string} description - Natural language description of the crew member
   * @param {string} agentName - The agent this crew will belong to
   * @param {Object} options - Additional options (existingCrews, availableTools, knowledgeBases)
   * @returns {Promise<Object>} - The generated crew configuration object
   */
  async generateCrewFromDescription(description, agentName, options = {}) {
    return this.claude.generateCrewFromDescription(description, agentName, options);
  }

  /**
   * Generate the .crew.js file code from a config object.
   * Used for "Export to File" feature.
   *
   * @param {Object} config - The crew configuration object
   * @param {string} agentName - The agent name (for class naming)
   * @returns {string} - The generated JavaScript code
   */
  generateCrewFileCode(config, agentName) {
    return this.claude.generateCrewFileCode(config, agentName);
  }

  /**
   * Send a one-shot request to Claude (for custom generation tasks)
   *
   * @param {string} systemPrompt - System instructions
   * @param {string} message - User message
   * @param {Object} options - { model, maxTokens, jsonOutput }
   * @returns {Promise<string>} - The response text
   */
  async claudeOneShot(systemPrompt, message, options = {}) {
    const result = await this.claude.sendOneShot(systemPrompt, message, options);
    if (result && typeof result === 'object' && 'text' in result) {
      if (result.usage) {
        logUsage({
          process: options.context || 'claude-one-shot',
          model: options.model || 'claude-sonnet-4-6',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          agentName: options.agentName,
          conversationId: options.conversationId,
          userId: options.userId,
        });
      }
      return result.text;
    }
    return result;
  }

}

module.exports = new LLMService();
