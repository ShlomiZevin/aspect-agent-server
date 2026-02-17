const openaiService = require('./llm.openai');
const claudeService = require('./llm.claude');
const functionRegistry = require('./function-registry');

/**
 * Main LLM service that routes requests to specific providers
 * Supports OpenAI (primary for chat) and Claude (for crew generation)
 *
 * Function calls are handled at this layer (provider-agnostic)
 */
class LLMService {
  constructor() {
    this.provider = openaiService;  // Default provider for chat
    this.claude = claudeService;     // Claude provider for generation tasks
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
    const provider = this._getProviderForModel(config.model);
    yield* provider.sendMessageStreamWithPrompt(message, conversationId, config);
  }

  /**
   * Determine which provider to use based on model name
   * @param {string} model - Model name (e.g., 'gpt-4o', 'claude-sonnet-4-5-20250929')
   * @returns {Object} - Provider service (openaiService or claudeService)
   * @private
   */
  _getProviderForModel(model) {
    if (!model) {
      return this.provider; // Default to OpenAI
    }

    // Claude models start with "claude-"
    if (model.toLowerCase().startsWith('claude-')) {
      console.log(`🤖 Using Claude provider for model: ${model}`);
      return this.claude;
    }

    // Otherwise use OpenAI (for gpt-*, o1-*, o3-*, etc.)
    console.log(`🤖 Using OpenAI provider for model: ${model}`);
    return this.provider;
  }

  /**
   * Send a stateless, non-streaming one-shot request.
   * Used by micro-agents that need a simple request/response without
   * conversation state, streaming, or tool handling.
   *
   * @param {string} instructions - System instructions/prompt
   * @param {string} message - The user message content
   * @param {Object} options - { model, maxTokens, jsonOutput }
   * @returns {Promise<string>} - The response text
   */
  async sendOneShot(instructions, message, options = {}) {
    // Detect provider from model name
    const provider = this._getProviderForModel(options.model);
    return provider.sendOneShot(instructions, message, options);
  }

  /**
   * Clear conversation history for a given conversation ID
   * @param {string} conversationId - The conversation to clear
   */
  clearConversation(conversationId) {
    return this.provider.clearConversation(conversationId);
  }

  /**
   * Add a file to the knowledge base vector store
   * @param {Buffer|string} fileContent - The file content (Buffer) or file path (string)
   * @param {string} fileName - The name of the file
   * @returns {Promise<Object>} - The file upload result
   */
  async addFileToKnowledgeBase(fileContent, fileName) {
    return this.provider.addFileToKnowledgeBase(fileContent, fileName);
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
    return this.claude.sendOneShot(systemPrompt, message, options);
  }

  /**
   * Create a new vector store
   * @param {string} name - The name of the vector store
   * @param {string} description - Optional description
   * @returns {Promise<Object>} - The created vector store
   */
  async createVectorStore(name, description) {
    return this.provider.createVectorStore(name, description);
  }

  /**
   * List all vector stores
   * @returns {Promise<Array>} - Array of vector stores
   */
  async listVectorStores() {
    return this.provider.listVectorStores();
  }

  /**
   * Get vector store by ID
   * @param {string} vectorStoreId - The vector store ID
   * @returns {Promise<Object>} - The vector store details
   */
  async getVectorStore(vectorStoreId) {
    return this.provider.getVectorStore(vectorStoreId);
  }

  /**
   * List files in a vector store
   * @param {string} vectorStoreId - The vector store ID
   * @returns {Promise<Array>} - Array of files with metadata
   */
  async listVectorStoreFiles(vectorStoreId) {
    return this.provider.listVectorStoreFiles(vectorStoreId);
  }

  /**
   * Delete a file from a vector store
   * @param {string} vectorStoreId - The vector store ID
   * @param {string} fileId - The file ID
   * @returns {Promise<Object>} - Deletion result
   */
  async deleteVectorStoreFile(vectorStoreId, fileId) {
    return this.provider.deleteVectorStoreFile(vectorStoreId, fileId);
  }

  /**
   * Add a file to a specific vector store
   * @param {Buffer} fileBuffer - The file content as Buffer
   * @param {string} fileName - The name of the file
   * @param {string} vectorStoreId - The vector store ID to add the file to
   * @returns {Promise<Object>} - The file upload result
   */
  async addFileToVectorStore(fileBuffer, fileName, vectorStoreId) {
    return this.provider.addFileToVectorStore(fileBuffer, fileName, vectorStoreId);
  }
}

module.exports = new LLMService();
