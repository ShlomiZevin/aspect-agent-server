const openaiService = require('./llm.openai');

/**
 * Main LLM service that routes requests to specific providers
 * Currently only supports OpenAI, but designed for future extensibility
 */
class LLMService {
  constructor() {
    this.provider = openaiService;
  }

  /**
   * Send a message and get a response
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @returns {Promise<string>} - The assistant's reply
   */
  async sendMessage(message, conversationId) {
    return this.provider.sendMessage(message, conversationId);
  }

  /**
   * Send a message and get a streaming response
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @returns {AsyncGenerator} - Stream of text chunks
   */
  async *sendMessageStream(message, conversationId, useKnowledgeBase) {
    yield* this.provider.sendMessageStream(message, conversationId, useKnowledgeBase);
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
}

module.exports = new LLMService();
