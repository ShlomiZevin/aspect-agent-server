const { OpenAI } = require('openai');
const { toFile } = require('openai/uploads');
const { File } = require('node:buffer');
const functionRegistry = require('./function-registry');

// Polyfill for File in Node.js < 20
if (typeof globalThis.File === 'undefined') {
  globalThis.File = File;
}

/**
 * OpenAI service using Responses API with Prompt ID
 * Migrated from Assistants API (deprecated August 2026)
 * Using Responses API with stored prompts for configuration and versioning
 *
 * Function call handling:
 * - Detects function_call in response output
 * - Uses function-registry to execute functions (provider-agnostic)
 * - Supports both regular and streaming responses
 */
class OpenAIService {
  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // You can configure these in .env if needed
    this.model = process.env.OPENAI_MODEL || 'gpt-4';
    this.promptId = process.env.OPENAI_PROMPT_ID || null;

    // Store OpenAI conversation objects: conversationId -> OpenAI conversation ID
    this.conversations = new Map();

    // Reference to function registry for executing function calls
    this.functionRegistry = functionRegistry;
  }

  /**
   * Build tools array including registered functions
   * @param {boolean} useKnowledgeBase - Whether to include file_search
   * @param {string} vectorStoreId - Vector store ID for file_search
   * @returns {Array} - Tools array for OpenAI API
   */
  buildToolsArray(useKnowledgeBase, vectorStoreId) {
    const tools = [];

    // Add file_search if needed
    if (useKnowledgeBase && vectorStoreId) {
      tools.push({
        type: 'file_search',
        vector_store_ids: [vectorStoreId]
      });
    }

    // Add registered functions as tools
    // Function names use snake_case format: report_symptom -> call_report_symptom
    // Responses API format: { type: 'function', name: '...', description: '...', parameters: {...} }
    const functionSchemas = this.functionRegistry.getSchemas();
    for (const schema of functionSchemas) {
      tools.push({
        type: 'function',
        name: `call_${schema.name}`,
        description: schema.description || '',
        parameters: schema.parameters || { type: 'object', properties: {} }
      });
    }

    return tools;
  }

  /**
   * Handle function call from OpenAI response
   * @param {Object} functionCall - The function call object from OpenAI
   * @returns {Promise<Object>} - Result of function execution
   */
  async handleFunctionCall(functionCall) {
    const { name, arguments: argsString } = functionCall;

    // Parse arguments from JSON string
    let params = {};
    try {
      params = JSON.parse(argsString || '{}');
    } catch (e) {
      console.error(`❌ Failed to parse function arguments: ${argsString}`);
      throw new Error(`Invalid function arguments: ${e.message}`);
    }

    // Execute via function registry (provider-agnostic)
    return this.functionRegistry.execute(name, params);
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
   * Handles function calls automatically - will execute functions and continue conversation
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {Object} agentConfig - Agent configuration (promptId, vectorStoreId, etc.)
   * @returns {Promise<Object>} - Object with reply text and any function call results
   */
  async sendMessage(message, conversationId, agentConfig = {}) {
    try {
      // Get or create OpenAI conversation
      const openaiConversationId = await this.getOrCreateConversation(conversationId);

      // Use agent-specific config or fallback to defaults
      const promptId = agentConfig.promptId || this.promptId;
      const promptVersion = agentConfig.promptVersion || '1';
      const vectorStoreId = agentConfig.vectorStoreId || 'vs_695e750fc75481918e3d76851ce30cae';
      const useKnowledgeBase = agentConfig.useKnowledgeBase !== false;

      // Build tools array including registered functions
      const tools = this.buildToolsArray(useKnowledgeBase, vectorStoreId);

      // Track function call results
      const functionResults = [];

      // Loop to handle multiple function calls (tool use loop)
      let currentInput = [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: message
        }]
      }];

      let finalReply = '';
      let maxIterations = 10; // Prevent infinite loops

      while (maxIterations > 0) {
        maxIterations--;

        // Create response with conversation object for automatic state management
        const response = await this.client.responses.create({
          prompt: {
            id: promptId,
            version: promptVersion
          },
          conversation: openaiConversationId,
          input: currentInput,
          text: {
            format: {
              type: 'text'
            }
          },
          reasoning: {},
          tools: tools,
          max_output_tokens: 2048,
          store: true,
          include: ['web_search_call.action.sources']
        });

        // Check for function calls in output
        const functionCallItems = response.output.filter(
          item => item.type === 'function_call'
        );

        if (functionCallItems.length > 0) {
          // Process all function calls
          const toolResults = [];

          for (const funcItem of functionCallItems) {
            try {
              const result = await this.handleFunctionCall({
                name: funcItem.name,
                arguments: funcItem.arguments
              });

              functionResults.push({
                name: funcItem.name,
                params: JSON.parse(funcItem.arguments || '{}'),
                result
              });

              toolResults.push({
                type: 'function_call_output',
                call_id: funcItem.call_id,
                output: JSON.stringify(result)
              });
            } catch (error) {
              console.error(`❌ Function call failed: ${funcItem.name}`, error.message);

              toolResults.push({
                type: 'function_call_output',
                call_id: funcItem.call_id,
                output: JSON.stringify({ error: error.message })
              });
            }
          }

          // Continue conversation with function results
          currentInput = toolResults;
        } else {
          // No function calls - extract final reply
          const outputItem = response.output.find(
            item => item.role === 'assistant' && item.type === 'message'
          );
          finalReply = outputItem?.content.find(c => c.type === 'output_text')?.text || '';
          break;
        }
      }

      // Return structured response
      return {
        reply: finalReply,
        functionCalls: functionResults
      };
    } catch (error) {
      console.error('❌ OpenAI Service Error:', error.message);
      throw new Error(`Failed to get response: ${error.message}`);
    }
  }

  /**
   * Send a message and get a streaming response using Conversation object
   * Handles function calls automatically - yields special events for function calls
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {boolean} useKnowledgeBase - Whether to use file_search tool
   * @param {Object} agentConfig - Agent configuration (promptId, vectorStoreId, etc.)
   * @returns {AsyncGenerator} - Stream of text chunks or function call events
   *   Yields: { type: 'text', content: string } for text
   *           { type: 'function_call', name: string, params: object } for function calls
   *           { type: 'function_result', name: string, result: any } for function results
   */
  async *sendMessageStream(message, conversationId, useKnowledgeBase = true, agentConfig = {}) {
    try {
      // Get or create OpenAI conversation
      const openaiConversationId = await this.getOrCreateConversation(conversationId);

      // Use agent-specific config or fallback to defaults
      const promptId = agentConfig.promptId || this.promptId;
      const promptVersion = agentConfig.promptVersion || '1';
      const vectorStoreId = agentConfig.vectorStoreId || 'vs_695e750fc75481918e3d76851ce30cae';

      // Build tools array including registered functions
      const tools = this.buildToolsArray(useKnowledgeBase, vectorStoreId);
      console.log(tools);

      let maxIterations = 10; // Prevent infinite loops
      let currentInput = [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: message
        }]
      }];

      while (maxIterations > 0) {
        maxIterations--;

        // Use Responses API with stored prompt and conversation object
        const stream = await this.client.responses.create({
          prompt: {
            id: promptId,
            version: promptVersion
          },
          conversation: openaiConversationId,
          input: currentInput,
          text: {
            format: {
              type: 'text'
            }
          },
          reasoning: {},
          tools: tools,
          max_output_tokens: 2048,
          store: true,
          include: ['web_search_call.action.sources'],
          stream: true
        });

        let fullReply = '';
        const pendingFunctionCalls = [];
        let currentFunctionCall = null;

        // Yield each chunk as it arrives
        for await (const chunk of stream) {
          // Handle text delta events
          if (chunk.type === 'response.output_text.delta') {
            const delta = chunk.delta;
            if (delta) {
              fullReply += delta;
              yield delta; // Keep backward compatible - just yield string for text
            }
          }

          // Handle function call events
          if (chunk.type === 'response.function_call_arguments.start') {
            currentFunctionCall = {
              name: chunk.name,
              call_id: chunk.call_id,
              arguments: ''
            };
          }

          if (chunk.type === 'response.function_call_arguments.delta' && currentFunctionCall) {
            currentFunctionCall.arguments += chunk.delta || '';
          }

          if (chunk.type === 'response.function_call_arguments.done' && currentFunctionCall) {
            pendingFunctionCalls.push({ ...currentFunctionCall });
            currentFunctionCall = null;
          }

          // Alternative: handle complete function_call in output
          if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
            pendingFunctionCalls.push({
              name: chunk.item.name,
              call_id: chunk.item.call_id,
              arguments: chunk.item.arguments
            });
          }
        }

        // If we have function calls, execute them and continue
        if (pendingFunctionCalls.length > 0) {
          const toolResults = [];

          for (const funcCall of pendingFunctionCalls) {
            // Yield function call event
            const params = JSON.parse(funcCall.arguments || '{}');
            yield {
              type: 'function_call',
              name: funcCall.name,
              params
            };

            try {
              const result = await this.handleFunctionCall({
                name: funcCall.name,
                arguments: funcCall.arguments
              });

              // Yield function result event
              yield {
                type: 'function_result',
                name: funcCall.name,
                result
              };

              toolResults.push({
                type: 'function_call_output',
                call_id: funcCall.call_id,
                output: JSON.stringify(result)
              });
            } catch (error) {
              console.error(`❌ Function call failed: ${funcCall.name}`, error.message);

              yield {
                type: 'function_error',
                name: funcCall.name,
                error: error.message
              };

              toolResults.push({
                type: 'function_call_output',
                call_id: funcCall.call_id,
                output: JSON.stringify({ error: error.message })
              });
            }
          }

          // Continue conversation with function results
          currentInput = toolResults;
        } else {
          // No function calls - we're done
          console.log(`✅ Streaming complete. Total reply length: ${fullReply.length}`);
          break;
        }
      }
    } catch (error) {
      console.error('❌ OpenAI Streaming Error:', error.message);
      console.error('Error details:', error);
      throw new Error(`Failed to stream response: ${error.message}`);
    }
  }

  /**
   * Send a message with inline prompt text (for crew members)
   * Uses instructions parameter instead of stored prompt ID
   *
   * @param {string} message - The user message
   * @param {string} conversationId - Unique conversation identifier
   * @param {Object} config - Configuration object
   * @param {string} config.prompt - The prompt/instructions text
   * @param {string} config.model - Model to use (optional, defaults to gpt-4)
   * @param {number} config.maxTokens - Max tokens (optional, defaults to 2048)
   * @param {Array} config.tools - Tools array for OpenAI (optional)
   * @param {boolean} config.useKnowledgeBase - Whether to include file_search
   * @param {string} config.vectorStoreId - Vector store ID for file_search
   * @param {Object} config.context - Additional context to inject into prompt
   * @returns {AsyncGenerator} - Stream of text chunks or function call events
   */
  async *sendMessageStreamWithPrompt(message, conversationId, config = {}) {
    try {
      // Get or create OpenAI conversation
      const openaiConversationId = await this.getOrCreateConversation(conversationId);

      // Extract config
      const {
        prompt = '',
        model = this.model,
        maxTokens = 2048,
        tools: crewTools = [],
        toolHandlers = {},
        knowledgeBase = null,
        context = {}
      } = config;

      // Build full instructions with context
      let fullInstructions = prompt;
      if (Object.keys(context).length > 0) {
        fullInstructions += `\n\n## Current Context\n${JSON.stringify(context, null, 2)}`;
      }

      // Build tools array
      const tools = [];

      // Resolve knowledge base: crew's knowledgeBase.storeId → OpenAI file_search
      // storeId is configured directly in the crew member file
      if (knowledgeBase?.enabled && knowledgeBase.storeId) {
        tools.push({
          type: 'file_search',
          vector_store_ids: [knowledgeBase.storeId]
        });
      }

      // Add crew-specific tools (crew members define their own tools)
      // No global function registry injection - crew tools are self-contained
      if (crewTools && crewTools.length > 0) {
        tools.push(...crewTools);
      }

      console.log(`🤖 Crew streaming with inline prompt (${fullInstructions.length} chars), ${tools.length} tools`);

      let maxIterations = 10;
      let currentInput = [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: message
        }]
      }];

      while (maxIterations > 0) {
        maxIterations--;

        // Use Responses API with inline instructions instead of stored prompt
        const stream = await this.client.responses.create({
          model: model,
          instructions: fullInstructions,
          conversation: openaiConversationId,
          input: currentInput,
          text: {
            format: {
              type: 'text'
            }
          },
          reasoning: {},
          tools: tools.length > 0 ? tools : undefined,
          max_output_tokens: maxTokens,
          store: true,
          include: ['file_search_call.results'],
          stream: true
        });

        let fullReply = '';
        const pendingFunctionCalls = [];
        let currentFunctionCall = null;

        // Yield each chunk as it arrives
        for await (const chunk of stream) {
          // Handle text delta events
          if (chunk.type === 'response.output_text.delta') {
            const delta = chunk.delta;
            if (delta) {
              fullReply += delta;
              yield delta;
            }
          }

          // Handle function call events
          if (chunk.type === 'response.function_call_arguments.start') {
            currentFunctionCall = {
              name: chunk.name,
              call_id: chunk.call_id,
              arguments: ''
            };
          }

          if (chunk.type === 'response.function_call_arguments.delta' && currentFunctionCall) {
            currentFunctionCall.arguments += chunk.delta || '';
          }

          if (chunk.type === 'response.function_call_arguments.done' && currentFunctionCall) {
            pendingFunctionCalls.push({ ...currentFunctionCall });
            currentFunctionCall = null;
          }

          if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
            pendingFunctionCalls.push({
              name: chunk.item.name,
              call_id: chunk.item.call_id,
              arguments: chunk.item.arguments
            });
          }

          // Handle file_search_call results - yield file names found in KB
          if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'file_search_call') {
            const results = chunk.item.results || [];
            const files = results
              .filter(r => r.score > 0.3)
              .map(r => ({
                name: r.file_name || r.filename || 'Unknown',
                score: r.score
              }));

            if (files.length > 0) {
              yield {
                type: 'file_search_results',
                files: files.slice(0, 8)
              };
            }
          }
        }

        // Handle function calls
        if (pendingFunctionCalls.length > 0) {
          const toolResults = [];

          for (const funcCall of pendingFunctionCalls) {
            const params = JSON.parse(funcCall.arguments || '{}');
            yield {
              type: 'function_call',
              name: funcCall.name,
              params
            };

            try {
              let result;

              // Use crew tool handler if available, otherwise fall back to global registry
              const crewHandler = toolHandlers[funcCall.name];
              if (crewHandler) {
                console.log(`🔧 Executing crew tool handler: ${funcCall.name}`);
                result = await crewHandler(params);
              } else {
                result = await this.handleFunctionCall({
                  name: funcCall.name,
                  arguments: funcCall.arguments
                });
              }

              yield {
                type: 'function_result',
                name: funcCall.name,
                result
              };

              toolResults.push({
                type: 'function_call_output',
                call_id: funcCall.call_id,
                output: JSON.stringify(result)
              });
            } catch (error) {
              console.error(`❌ Function call failed: ${funcCall.name}`, error.message);

              yield {
                type: 'function_error',
                name: funcCall.name,
                error: error.message
              };

              toolResults.push({
                type: 'function_call_output',
                call_id: funcCall.call_id,
                output: JSON.stringify({ error: error.message })
              });
            }
          }

          currentInput = toolResults;
        } else {
          console.log(`✅ Crew streaming complete. Total reply length: ${fullReply.length}`);
          break;
        }
      }
    } catch (error) {
      console.error('❌ OpenAI Crew Streaming Error:', error.message);
      console.error('Error details:', error);
      throw new Error(`Failed to stream crew response: ${error.message}`);
    }
  }

  /**
   * Send a stateless, non-streaming one-shot request.
   * Used by micro-agents (e.g., fields extractor) that don't need conversation
   * state, streaming, or tool handling.
   *
   * @param {string} instructions - System instructions/prompt
   * @param {string} message - The user message content
   * @param {Object} options - Configuration options
   * @param {string} options.model - Model to use (default: 'gpt-4o-mini')
   * @param {number} options.maxTokens - Max output tokens (default: 1024)
   * @param {boolean} options.jsonOutput - Request JSON output format (default: false)
   * @returns {Promise<string>} - The response text
   */
  async sendOneShot(instructions, message, options = {}) {
    const { model = 'gpt-4o-mini', maxTokens = 1024, jsonOutput = false } = options;

    try {
      const requestParams = {
        model,
        instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }],
        max_output_tokens: maxTokens,
        store: false
      };

      if (jsonOutput) {
        requestParams.text = { format: { type: 'json_object' } };
      }

      const response = await this.client.responses.create(requestParams);

      const outputItem = response.output.find(item => item.type === 'message');
      return outputItem?.content.find(c => c.type === 'output_text')?.text || '';
    } catch (error) {
      console.error('❌ OpenAI OneShot Error:', error.message);
      throw new Error(`Failed to get one-shot response: ${error.message}`);
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
