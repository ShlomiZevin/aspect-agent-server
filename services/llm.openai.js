const { OpenAI } = require('openai');

/**
 * OpenAI service using Responses API with Prompt ID
 * Migrated from Assistants API (deprecated August 2026)
 * Using Responses API with stored prompts for configuration and versioning
 */
class OpenAIService {
  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // You can configure these in .env if needed
    this.model = process.env.OPENAI_MODEL || 'gpt-4';
    this.promptId = process.env.OPENAI_PROMPT_ID || null;

    // Store conversation history: conversationId -> array of messages
    this.conversations = new Map();
  }

  /**
   * Send a message and get a response using Responses API with prompt ID
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @returns {Promise<string>} - The assistant's reply
   */
  async sendMessage(message, conversationId) {
    try {
      // Get or initialize conversation history
      let input = this.conversations.get(conversationId);

      if (!input) {
        // Start new conversation - input is an array of items
        input = [];
        this.conversations.set(conversationId, input);
      }

      // Add user message to input
      input.push({
        role: 'user',
        content: [{
          type: 'input_text',
          text: message
        }]
      });

      // Use Responses API with stored prompt
      const response = await this.client.responses.create({
        prompt: {
          id: this.promptId,
          version: '1'
        },
        input: input,
        text: {
          format: {
            type: 'text'
          }
        },
        max_output_tokens: 2048,
        store: true
      });

      // Extract assistant reply from output
      const outputItem = response.output.find(item => item.role === 'assistant' && item.type === 'message');
      const reply = outputItem?.content.find(c => c.type === 'output_text')?.text || '';

      // Add assistant reply to conversation history
      if (reply && outputItem?.id) {
        input.push({
          id: outputItem.id,
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: reply
          }]
        });
      }

      return reply;
    } catch (error) {
      console.error('❌ OpenAI Service Error:', error.message);
      throw new Error(`Failed to get response: ${error.message}`);
    }
  }

  /**
   * Send a message and get a streaming response
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @returns {AsyncGenerator} - Stream of text chunks
   */
  async *sendMessageStream(message, conversationId) {
    try {
      // Get or initialize conversation history
      let input = this.conversations.get(conversationId);

      if (!input) {
        // Start new conversation - input is an array of items
        input = [];
        this.conversations.set(conversationId, input);
      }

      // Add user message to input
      input.push({
        role: 'user',
        content: [{
          type: 'input_text',
          text: message
        }]
      });

      // Use Responses API with stored prompt
      const stream = await this.client.responses.create({
        prompt: {
          id: this.promptId,
          version: '1'
        },
        input: input,
        text: {
          format: {
            type: 'text'
          }
        },
        max_output_tokens: 2048,
        stream: true,
        store: true
      });

      let fullReply = '';
      let assistantMessageId = null;

      // Yield each chunk as it arrives
      for await (const chunk of stream) {
        // Handle different event types
        if (chunk.type === 'response.output_item.done') {
          const item = chunk.item;
          if (item.role === 'assistant' && item.type === 'message') {
            assistantMessageId = item.id;
            // Full reply is already built from deltas
          }
        } else if (chunk.type === 'response.output_item.delta') {
          const delta = chunk.delta;
          if (delta.type === 'output_text' && delta.text) {
            fullReply += delta.text;
            yield delta.text;
          }
        }
      }

      // Add assistant reply to conversation history
      if (fullReply && assistantMessageId) {
        input.push({
          id: assistantMessageId,
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: fullReply
          }]
        });
      }
    } catch (error) {
      console.error('❌ OpenAI Streaming Error:', error.message);
      console.error('Error details:', error);
      throw new Error(`Failed to stream response: ${error.message}`);
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
