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

    // Store OpenAI conversation objects: conversationId -> OpenAI conversation ID
    this.conversations = new Map();
  }

  /**
   * Get or create OpenAI conversation object
   * @param {string} conversationId - Unique conversation identifier
   * @returns {Promise<string>} - OpenAI conversation ID
   */
  async getOrCreateConversation(conversationId) {
    // Check if we already have this conversation
    let openaiConversationId = this.conversations.get(conversationId);

    if (!openaiConversationId) {
      // Create a new conversation object in OpenAI
      const conversation = await this.client.conversations.create();
      openaiConversationId = conversation.id;
      this.conversations.set(conversationId, openaiConversationId);
      console.log(`✅ Created new OpenAI conversation: ${openaiConversationId}`);
    }

    return openaiConversationId;
  }

  /**
   * Send a message and get a response using Responses API with Conversation object
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {Object} agentConfig - Agent configuration (promptId, vectorStoreId, etc.)
   * @returns {Promise<string>} - The assistant's reply
   */
  async sendMessage(message, conversationId, agentConfig = {}) {
    try {
      // Get or create OpenAI conversation
      const openaiConversationId = await this.getOrCreateConversation(conversationId);

      // Use agent-specific config or fallback to defaults
      const promptId = agentConfig.promptId || this.promptId;
      const promptVersion = agentConfig.promptVersion || '1';
      const vectorStoreId = agentConfig.vectorStoreId || 'vs_695e750fc75481918e3d76851ce30cae';

      // Build tools array conditionally
      const tools = vectorStoreId ? [
        {
          "type": "file_search",
          "vector_store_ids": [vectorStoreId]
        }
      ] : [];

      // Create response with conversation object for automatic state management
      const response = await this.client.responses.create({
        prompt: {
          "id": promptId,
          "version": promptVersion
        },
        conversation: openaiConversationId,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: message
          }]
        }],
        text: {
          "format": {
            "type": "text"
          }
        },
        reasoning: {},
        tools: tools,
        max_output_tokens: 2048,
        store: true,
        include: ["web_search_call.action.sources"]
      });

      // Extract assistant reply from output
      const outputItem = response.output.find(item => item.role === 'assistant' && item.type === 'message');
      const reply = outputItem?.content.find(c => c.type === 'output_text')?.text || '';

      return reply;
    } catch (error) {
      console.error('❌ OpenAI Service Error:', error.message);
      throw new Error(`Failed to get response: ${error.message}`);
    }
  }

  /**
   * Send a message and get a streaming response using Conversation object
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {boolean} useKnowledgeBase - Whether to use file_search tool
   * @param {Object} agentConfig - Agent configuration (promptId, vectorStoreId, etc.)
   * @returns {AsyncGenerator} - Stream of text chunks
   */
  async *sendMessageStream(message, conversationId, useKnowledgeBase = true, agentConfig = {}) {
    try {
      // Get or create OpenAI conversation
      const openaiConversationId = await this.getOrCreateConversation(conversationId);

      console.log(agentConfig);
      // Use agent-specific config or fallback to defaults
      const promptId = agentConfig.promptId || this.promptId;
      const promptVersion = agentConfig.promptVersion || '1';
      const vectorStoreId = agentConfig.vectorStoreId || 'vs_695e750fc75481918e3d76851ce30cae';

      // Build tools array conditionally based on useKnowledgeBase flag and vectorStoreId
      const tools = (useKnowledgeBase && vectorStoreId) ? [
        {
          "type": "file_search",
          "vector_store_ids": [vectorStoreId]
        }
      ] : [];

      // Use Responses API with stored prompt and conversation object
      const stream = await this.client.responses.create({
        prompt: {
          "id": promptId,
          "version": promptVersion
        },
        conversation: openaiConversationId,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: message
          }]
        }],
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

      // Yield each chunk as it arrives
      for await (const chunk of stream) {
        console.log(chunk);
        // Handle different event types
        if (chunk.type === 'response.output_text.delta') {
          const delta = chunk.delta;
          if (delta) {
            fullReply += delta;
            yield delta;
          }
        }
      }
      console.log(`✅ Streaming complete. Total reply length: ${fullReply.length}`);
    } catch (error) {
      console.error('❌ OpenAI Streaming Error:', error.message);
      console.error('Error details:', error);
      throw new Error(`Failed to stream response: ${error.message}`);
    }
  }

  /**
   * Clear conversation history for a given conversation ID
   * Note: This only removes the local reference. The OpenAI conversation object persists.
   * @param {string} conversationId - The conversation to clear
   */
  clearConversation(conversationId) {
    if (this.conversations.has(conversationId)) {
      this.conversations.delete(conversationId);
      console.log(`✅ Cleared local conversation reference: ${conversationId}`);
      return true;
    }
    return false;
  }

  /**
   * Get conversation history from OpenAI
   * @param {string} conversationId - The conversation to retrieve
   * @returns {Promise<Object>} - The conversation object with items
   */
  async getConversationHistory(conversationId) {
    try {
      const openaiConversationId = this.conversations.get(conversationId);

      if (!openaiConversationId) {
        throw new Error(`No conversation found for ID: ${conversationId}`);
      }

      // Retrieve the conversation from OpenAI
      const conversation = await this.client.conversations.retrieve(openaiConversationId);
      return conversation;
    } catch (error) {
      console.error('❌ Error retrieving conversation:', error.message);
      throw new Error(`Failed to retrieve conversation: ${error.message}`);
    }
  }

  /**
   * Create a new vector store
   * @param {string} name - The name of the vector store
   * @param {string} description - Optional description
   * @returns {Promise<Object>} - The created vector store
   */
  async createVectorStore(name, description = null) {
    try {
      const params = { name };
      if (description) {
        params.description = description;
      }

      const vectorStore = await this.client.vectorStores.create(params);
      console.log(`✅ Vector store created: ${vectorStore.id}`);

      return {
        id: vectorStore.id,
        name: vectorStore.name,
        description: vectorStore.description,
        createdAt: vectorStore.created_at,
        fileCount: vectorStore.file_counts.total,
        bytes: vectorStore.bytes
      };
    } catch (error) {
      console.error('❌ Error creating vector store:', error.message);
      throw new Error(`Failed to create vector store: ${error.message}`);
    }
  }

  /**
   * List all vector stores
   * @returns {Promise<Array>} - Array of vector stores
   */
  async listVectorStores() {
    try {
      const response = await this.client.vectorStores.list();

      return response.data.map(vs => ({
        id: vs.id,
        name: vs.name,
        description: vs.description,
        createdAt: vs.created_at,
        fileCount: vs.file_counts.total,
        bytes: vs.bytes,
        fileCounts: vs.file_counts
      }));
    } catch (error) {
      console.error('❌ Error listing vector stores:', error.message);
      throw new Error(`Failed to list vector stores: ${error.message}`);
    }
  }

  /**
   * Get vector store by ID
   * @param {string} vectorStoreId - The vector store ID
   * @returns {Promise<Object>} - The vector store details
   */
  async getVectorStore(vectorStoreId) {
    try {
      const vectorStore = await this.client.vectorStores.retrieve(vectorStoreId);

      return {
        id: vectorStore.id,
        name: vectorStore.name,
        description: vectorStore.description,
        createdAt: vectorStore.created_at,
        fileCount: vectorStore.file_counts.total,
        bytes: vectorStore.bytes,
        fileCounts: vectorStore.file_counts
      };
    } catch (error) {
      console.error('❌ Error retrieving vector store:', error.message);
      throw new Error(`Failed to retrieve vector store: ${error.message}`);
    }
  }

  /**
   * List files in a vector store
   * @param {string} vectorStoreId - The vector store ID
   * @returns {Promise<Array>} - Array of files with metadata
   */
  async listVectorStoreFiles(vectorStoreId) {
    try {
      const response = await this.client.vectorStores.files.list(vectorStoreId);

      // Get file details for each file
      const filesWithDetails = await Promise.all(
        response.data.map(async (vsFile) => {
          try {
            const fileDetails = await this.client.files.retrieve(vsFile.id);
            return {
              id: vsFile.id,
              vectorStoreId: vsFile.vector_store_id,
              createdAt: vsFile.created_at,
              fileName: fileDetails.filename,
              fileSize: fileDetails.bytes,
              purpose: fileDetails.purpose,
              status: fileDetails.status
            };
          } catch (err) {
            console.warn(`⚠️ Could not retrieve details for file ${vsFile.id}:`, err.message);
            return {
              id: vsFile.id,
              vectorStoreId: vsFile.vector_store_id,
              createdAt: vsFile.created_at,
              fileName: 'Unknown',
              fileSize: 0,
              status: 'unknown'
            };
          }
        })
      );

      return filesWithDetails;
    } catch (error) {
      console.error('❌ Error listing vector store files:', error.message);
      throw new Error(`Failed to list vector store files: ${error.message}`);
    }
  }

  /**
   * Delete a file from a vector store
   * @param {string} vectorStoreId - The vector store ID
   * @param {string} fileId - The file ID
   * @returns {Promise<Object>} - Deletion result
   */
  async deleteVectorStoreFile(vectorStoreId, fileId) {
    try {
      const result = await this.client.vectorStores.files.del(vectorStoreId, fileId);
      console.log(`✅ File ${fileId} deleted from vector store ${vectorStoreId}`);

      return {
        success: true,
        fileId: fileId,
        deleted: result.deleted
      };
    } catch (error) {
      console.error('❌ Error deleting file from vector store:', error.message);
      throw new Error(`Failed to delete file from vector store: ${error.message}`);
    }
  }

  /**
   * Add a file to a specific knowledge base vector store
   * @param {Buffer} fileBuffer - The file content as Buffer
   * @param {string} fileName - The name of the file
   * @param {string} vectorStoreId - The vector store ID to add the file to
   * @returns {Promise<Object>} - The file upload result
   */
  async addFileToVectorStore(fileBuffer, fileName, vectorStoreId) {
    try {
      console.log(`📤 Starting file upload: ${fileName} to vector store: ${vectorStoreId}`);

      // Step 1: Upload the file to OpenAI
      const fileObject = await toFile(fileBuffer, fileName);

      const file = await this.client.files.create({
        file: fileObject,
        purpose: 'assistants'
      });

      console.log(`✅ File uploaded to OpenAI with ID: ${file.id}`);

      // Step 2: Add the file to the vector store using the file_id
      console.log(`🔗 Adding file ${file.id} to vector store ${vectorStoreId}...`);
      const vectorStoreFile = await this.client.vectorStores.files.create(
        vectorStoreId,
        {
          file_id: file.id
        }
      );

      console.log(`✅ File added to vector store. Vector Store File ID: ${vectorStoreFile.id}, Status: ${vectorStoreFile.status}`);

      return {
        success: true,
        fileId: file.id,
        vectorStoreFileId: vectorStoreFile.id,
        fileName: fileName,
        fileSize: file.bytes,
        status: vectorStoreFile.status
      };
    } catch (error) {
      console.error('❌ Error adding file to vector store:', error.message);
      console.error('Full error:', error);
      throw new Error(`Failed to add file to vector store: ${error.message}`);
    }
  }

  /**
   * Add a file to the knowledge base vector store (legacy method for backward compatibility)
   * @param {Buffer} fileBuffer - The file content as Buffer
   * @param {string} fileName - The name of the file
   * @returns {Promise<Object>} - The file upload result
   */
  async addFileToKnowledgeBase(fileBuffer, fileName) {
    const VECTOR_STORE_ID = 'vs_695e750fc75481918e3d76851ce30cae'; // menopause KB
    return this.addFileToVectorStore(fileBuffer, fileName, VECTOR_STORE_ID);
  }
}

module.exports = new OpenAIService();
