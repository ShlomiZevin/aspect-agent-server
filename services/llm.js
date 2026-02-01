const openaiService = require('./llm.openai');
const functionRegistry = require('./function-registry');

/**
 * Main LLM service that routes requests to specific providers
 * Currently only supports OpenAI, but designed for future extensibility
 *
 * Function calls are handled at this layer (provider-agnostic)
 */
class LLMService {
  constructor() {
    this.provider = openaiService;
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
    yield* this.provider.sendMessageStreamWithPrompt(message, conversationId, config);
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
    return this.provider.sendOneShot(instructions, message, options);
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
