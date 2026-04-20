const openaiService = require('./llm.openai');
const claudeService = require('./llm.claude');
const googleService = require('./llm.google');
const functionRegistry = require('./function-registry');
const { logUsage } = require('./usageLogger');

/**
 * Main LLM service that routes requests to specific providers
 * Supports OpenAI (primary for chat), Claude (for generation), and Google Gemini
 *
 * Function calls are handled at this layer (provider-agnostic)
 */
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
    yield* provider.sendMessageStreamWithPrompt(message, conversationId, config);
  }

  /**
   * Determine which provider to use based on model name
   * @param {string} model - Model name (e.g., 'gpt-4o', 'claude-sonnet-4-5-20250929', 'gemini-2.0-flash')
   * @param {string} context - Context for logging (e.g., 'crew', 'field-extractor', 'one-shot')
   * @returns {Object} - Provider service (openaiService, claudeService, or googleService)
   * @private
   */
  _getProviderForModel(model, context = 'one-shot') {
    const contextLabel = context ? `[${context}] ` : '';

    if (!model) {
      return this.provider; // Default to OpenAI
    }

    const modelLower = model.toLowerCase();

    // Claude models start with "claude-"
    if (modelLower.startsWith('claude-')) {
      console.log(`🤖 ${contextLabel}Using Claude provider for model: ${model}`);
      return this.claude;
    }

    // Google Gemini models start with "gemini-"
    if (modelLower.startsWith('gemini-')) {
      console.log(`🤖 ${contextLabel}Using Google provider for model: ${model}`);
      return this.google;
    }

    // Otherwise use OpenAI (for gpt-*, o1-*, o3-*, o4-*, etc.)
    console.log(`🤖 ${contextLabel}Using OpenAI provider for model: ${model}`);
    return this.provider;
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
    const start = Date.now();
    const result = await provider.sendOneShot(instructions, message, options);
    const durationMs = Date.now() - start;

    // Providers return { text, usage } — log usage and return just text for backward compat
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
      return result.text;
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
