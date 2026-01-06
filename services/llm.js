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
   * Clear conversation history for a given conversation ID
   * @param {string} conversationId - The conversation to clear
   */
  clearConversation(conversationId) {
    return this.provider.clearConversation(conversationId);
  }
}

module.exports = new LLMService();
