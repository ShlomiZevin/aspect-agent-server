const { OpenAI } = require('openai');

/**
 * OpenAI service using Chat Completions API
 * Migrated from Assistants API (deprecated August 2026)
 * Using Chat Completions as recommended alternative - simple and well-supported
 */
class OpenAIService {
  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // You can configure these in .env if needed
    this.model = process.env.OPENAI_MODEL || 'gpt-4';
    
    // Store conversation history: conversationId -> array of messages
    this.conversations = new Map();
  }

  /**
   * Send a message and get a response using Chat Completions API
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @returns {Promise<string>} - The assistant's reply
   */
  async sendMessage(message, conversationId) {
    try {
      // Get or initialize conversation history
      let messages = this.conversations.get(conversationId);

      if (!messages) {
        // Start new conversation (no system prompt - using OpenAI platform prompt)
        messages = [];
        this.conversations.set(conversationId, messages);
      }

      // Add user message to history
      messages.push({ role: 'user', content: message });

      // Get response from OpenAI
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: messages
      });

      // Extract assistant reply
      const reply = response.choices[0].message.content;

      // Add assistant reply to history
      messages.push({ role: 'assistant', content: reply });

      return reply;
    } catch (error) {
      console.error('❌ OpenAI Service Error:', error.message);
      throw new Error(`Failed to get response: ${error.message}`);
    }
  }

  /**
   * Clear conversation history for a given conversation ID
   * @param {string} conversationId - The conversation to clear
   */
  clearConversation(conversationId) {
    if (this.conversations.has(conversationId)) {
      this.conversations.delete(conversationId);
      return true;
    }
    return false;
  }
}

module.exports = new OpenAIService();
