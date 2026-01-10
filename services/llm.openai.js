const { OpenAI } = require('openai');
const { toFile } = require('openai/uploads');
const { File } = require('node:buffer');

// Polyfill for File in Node.js < 20
if (typeof globalThis.File === 'undefined') {
  globalThis.File = File;
}

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

      const response = await openai.responses.create({
        prompt: {
          "id": this.promptId,
          "version": "2"
        },
        input: input,
        text: {
          "format": {
            "type": "text"
          }
        },
        reasoning: {},
        tools: [
          {
            "type": "file_search",
            "vector_store_ids": [
              "vs_695e750fc75481918e3d76851ce30cae"
            ]
          }
        ],
        max_output_tokens: 2048,
        store: true,
        include: ["web_search_call.action.sources"]
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
  async *sendMessageStream(message, conversationId, useKnowledgeBase = true) {
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

      // Build tools array conditionally based on useKnowledgeBase flag
      const tools = useKnowledgeBase ? [
        {
          "type": "file_search",
          "vector_store_ids": [
            "vs_695e750fc75481918e3d76851ce30cae"
          ]
        }
      ] : [];

      // Use Responses API with stored prompt
      const stream = await this.client.responses.create({
        prompt: {
          "id": this.promptId,
          "version": "2"
        },
        input: input,
        text: {
          "format": {
            "type": "text"
          }
        },
        reasoning: {},
        tools: tools,
        max_output_tokens: 2048,
        store: true,
        include: ["web_search_call.action.sources"],
        stream: true
      });

      let fullReply = '';
      let assistantMessageId = null;

      // Yield each chunk as it arrives
      for await (const chunk of stream) {
        console.log(chunk);
        // Handle different event types
        if (chunk.type === 'response.output_text.done') {
          assistantMessageId = chunk.item_id;
        } else if (chunk.type === 'response.output_text.delta') {
          const delta = chunk.delta;
          if (delta) {
            fullReply += delta;
            yield delta;
          }
        }
      }
      console.log(fullReply);

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

  /**
   * Add a file to the knowledge base vector store
   * @param {Buffer} fileBuffer - The file content as Buffer
   * @param {string} fileName - The name of the file
   * @returns {Promise<Object>} - The file upload result
   */
  async addFileToKnowledgeBase(fileBuffer, fileName) {
    try {
      const VECTOR_STORE_ID = 'vs_695e750fc75481918e3d76851ce30cae'; // meanapause KB

      // Check if file already exists
      const list = await this.client.files.list();

      for await (const file of list) {
        if (file.filename === fileName) {
          console.log(`❌ File already exists with ID: ${file.id}`);
          throw new Error(`File "${fileName}" already exists in the knowledge base with ID: ${file.id}`);
        }
      }

      // Step 1: Upload the file to OpenAI
      const fileObject = await toFile(fileBuffer, fileName);

      const file = await this.client.files.create({
        file: fileObject,
        purpose: 'assistants'
      });

      console.log(`✅ File uploaded with ID: ${file.id}`);

      // Step 2: Add the file to the vector store using the file_id
      const vectorStoreFile = await this.client.vectorStores.files.create(
        VECTOR_STORE_ID,
        {
          file_id: file.id
        }
      );

      console.log(`✅ File added to vector store: ${vectorStoreFile.id}`);

      return {
        success: true,
        fileId: file.id,
        vectorStoreFileId: vectorStoreFile.id,
        fileName: fileName,
        status: vectorStoreFile.status
      };
    } catch (error) {
      console.error('❌ Error adding file to knowledge base:', error.message);
      console.error('Full error:', error);
      throw new Error(`Failed to add file to knowledge base: ${error.message}`);
    }
  }
}

module.exports = new OpenAIService();
