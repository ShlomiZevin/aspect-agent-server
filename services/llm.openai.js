const { OpenAI } = require('openai');
const functionRegistry = require('./function-registry');
const conversationService = require('./conversation.service');
const providerConfigService = require('./provider-config.service');

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
    this._client = null;
    this._clientApiKey = null;

    // You can configure these in .env if needed
    this.model = process.env.OPENAI_MODEL || 'gpt-4';
    this.promptId = process.env.OPENAI_PROMPT_ID || null;

    // Store OpenAI conversation objects: conversationId -> OpenAI conversation ID
    this.conversations = new Map();

    // Reference to function registry for executing function calls
    this.functionRegistry = functionRegistry;
  }

  get client() {
    const currentKey = providerConfigService.getCached('openai_api_key') || process.env.OPENAI_API_KEY;
    if (currentKey !== this._clientApiKey || !this._client) {
      this._clientApiKey = currentKey;
      this._client = new OpenAI({ apiKey: currentKey });
    }
    return this._client;
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
      // Extract config
      const {
        prompt: fullInstructions = '',
        model = this.model,
        maxTokens = 2048,
        tools: crewTools = [],
        toolHandlers = {},
        knowledgeBase = null,
        temperature,
        topK,
      } = config;

      // Build tools array
      const tools = [];

      // Resolve knowledge base: storeIds array (new) or storeId (legacy fallback)
      const storeIds = knowledgeBase?.storeIds?.length > 0
        ? knowledgeBase.storeIds
        : (knowledgeBase?.storeId ? [knowledgeBase.storeId] : []);

      if (knowledgeBase?.enabled && storeIds.length > 0) {
        tools.push({
          type: 'file_search',
          vector_store_ids: storeIds
        });
      }

      // Add crew-specific tools (crew members define their own tools)
      // No global function registry injection - crew tools are self-contained
      if (crewTools && crewTools.length > 0) {
        tools.push(...crewTools);
      }

      // Fetch conversation history from our DB (not OpenAI)
      // Drop the last message if it's from the user — it's the current turn,
      // which is appended separately as currentUserMessage
      let historyMessages = [];
      try {
        const history = await conversationService.getConversationHistory(conversationId, 50);
        if (history.length > 0 && history[history.length - 1].role === 'user') {
          history.pop();
        }
        historyMessages = history.map(m => ({
          role: m.role,
          // user and developer roles use input_text, assistant uses output_text
          content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }]
        }));
      } catch (err) {
        console.warn('⚠️ Could not load conversation history from DB:', err.message);
      }

      // Build input: history + current message
      const currentUserMessage = {
        role: 'user',
        content: [{ type: 'input_text', text: message }]
      };

      // Inject transition system prompt if this is a new crew transition
      // This signals to the model that the context has changed and it should follow new instructions
      if (config.transitionSystemPrompt && config.isNewCrewTransition) {
        historyMessages.push({
          role: 'developer',
          content: [{ type: 'input_text', text: config.transitionSystemPrompt }]
        });
        console.log(`🔄 Injected transition system prompt (${config.transitionSystemPrompt.length} chars) as developer message`);
      }


      console.log(`🤖 Crew streaming with inline prompt (${fullInstructions.length} chars), ${tools.length} tools, ${historyMessages.length} history messages`);

      let maxIterations = 10;
      let currentInput = [...historyMessages, currentUserMessage];

      while (maxIterations > 0) {
        maxIterations--;

        // Use Responses API with inline instructions - stateless (no conversation object)
        const stream = await this.client.responses.create({
          model: model,
          instructions: fullInstructions,
          input: currentInput,
          text: {
            format: {
              type: 'text'
            }
          },
          reasoning: {},
          tools: tools.length > 0 ? tools : undefined,
          max_output_tokens: maxTokens,
          temperature: temperature != null ? temperature : undefined,
          top_p: topK != null ? topK : undefined,
          store: false,
          include: ['file_search_call.results'],
          stream: true
        });

        let fullReply = '';
        const pendingFunctionCalls = [];
        let currentFunctionCall = null;
        let oaiInputTokens = 0;
        let oaiOutputTokens = 0;

        // Yield each chunk as it arrives
        for await (const chunk of stream) {
          // Track usage from completed response
          if (chunk.type === 'response.completed' && chunk.response?.usage) {
            const u = chunk.response.usage;
            oaiInputTokens = u.input_tokens || 0;
            oaiOutputTokens = u.output_tokens || 0;
          }

          // Handle error events from OpenAI stream
          if (chunk.type === 'error') {
            console.error(`❌ OpenAI stream error event:`, JSON.stringify(chunk));
            throw new Error(`OpenAI stream error: ${chunk.message || JSON.stringify(chunk)}`);
          }

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

          // output_item.done is the reliable completion event for function calls
          // deduplicate by call_id to avoid double-execution if both events fire
          if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
            const alreadyAdded = pendingFunctionCalls.some(f => f.call_id === chunk.item.call_id);
            if (!alreadyAdded) {
              pendingFunctionCalls.push({
                name: chunk.item.name,
                call_id: chunk.item.call_id,
                arguments: chunk.item.arguments
              });
            }
          }

          // Handle file_search_call results - yield file names found in KB
          if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'file_search_call') {
            const results = chunk.item.results || [];
            console.log(`🔍 file_search_call done: ${results.length} results, scores: ${results.map(r => r.score).join(', ')}`);
            const files = results
              .filter(r => r.score == null || r.score > 0.1)
              .map(r => ({
                name: r.file_name || r.filename || r.file_id || 'Unknown',
                score: r.score
              }));

            if (files.length > 0) {
              yield { type: 'file_search_results', files: files.slice(0, 8) };
            } else if (results.length > 0) {
              // results exist but all filtered — yield anyway
              yield {
                type: 'file_search_results',
                files: results.slice(0, 8).map(r => ({
                  name: r.file_name || r.filename || r.file_id || 'Unknown',
                  score: r.score
                }))
              };
            }
          }
        }

        // Handle function calls
        if (pendingFunctionCalls.length > 0) {
          // In stateless mode, we need to append function_call + function_call_output to the input
          // so OpenAI can match the outputs to their calls
          for (const funcCall of pendingFunctionCalls) {
            const params = JSON.parse(funcCall.arguments || '{}');
            yield {
              type: 'function_call',
              name: funcCall.name,
              params
            };

            // Add the function_call to input (required for stateless mode)
            currentInput.push({
              type: 'function_call',
              call_id: funcCall.call_id,
              name: funcCall.name,
              arguments: funcCall.arguments
            });

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

              // Add the function_call_output to input
              currentInput.push({
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

              // Add error result to input
              currentInput.push({
                type: 'function_call_output',
                call_id: funcCall.call_id,
                output: JSON.stringify({ error: error.message })
              });
            }
          }

          // currentInput now has history + user message + function_call + function_call_output
          // Continue to next iteration
        } else {
          console.log(`✅ Crew streaming complete. Total reply length: ${fullReply.length}`);
          if (oaiInputTokens || oaiOutputTokens) {
            yield { type: 'usage', inputTokens: oaiInputTokens, outputTokens: oaiOutputTokens };
          }
          break;
        }
      }
    } catch (error) {
      console.error('❌ OpenAI Crew Streaming Error:', error.message);
      console.error('Error details:', error);
      const err = new Error(`Failed to stream crew response: ${error.message}`);
      err.status = error.status || error.statusCode || null;
      throw err;
    }
  }

  async *sendMessageStreamWithPromptOldWithConvId(message, conversationId, config = {}) {
    try {
      // Get or create OpenAI conversation
      const openaiConversationId = await this.getOrCreateConversation(conversationId);

      // Extract config
      const {
        prompt: fullInstructions = '',
        model = this.model,
        maxTokens = 2048,
        tools: crewTools = [],
        toolHandlers = {},
        knowledgeBase = null,
      } = config;

      // Build tools array
      const tools = [];

      // Resolve knowledge base: storeIds array (new) or storeId (legacy fallback)
      const storeIdsLegacy = knowledgeBase?.storeIds?.length > 0
        ? knowledgeBase.storeIds
        : (knowledgeBase?.storeId ? [knowledgeBase.storeId] : []);

      if (knowledgeBase?.enabled && storeIdsLegacy.length > 0) {
        tools.push({
          type: 'file_search',
          vector_store_ids: storeIdsLegacy
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

          // output_item.done is the reliable completion event for function calls
          // deduplicate by call_id to avoid double-execution if both events fire
          if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'function_call') {
            const alreadyAdded = pendingFunctionCalls.some(f => f.call_id === chunk.item.call_id);
            if (!alreadyAdded) {
              pendingFunctionCalls.push({
                name: chunk.item.name,
                call_id: chunk.item.call_id,
                arguments: chunk.item.arguments
              });
            }
          }

          // Handle file_search_call results - yield file names found in KB
          if (chunk.type === 'response.output_item.done' && chunk.item?.type === 'file_search_call') {
            const results = chunk.item.results || [];
            console.log(`🔍 file_search_call done: ${results.length} results, scores: ${results.map(r => r.score).join(', ')}`);
            const files = results
              .filter(r => r.score == null || r.score > 0.1)
              .map(r => ({
                name: r.file_name || r.filename || r.file_id || 'Unknown',
                score: r.score
              }));

            if (files.length > 0) {
              yield { type: 'file_search_results', files: files.slice(0, 8) };
            } else if (results.length > 0) {
              // results exist but all filtered — yield anyway
              yield {
                type: 'file_search_results',
                files: results.slice(0, 8).map(r => ({
                  name: r.file_name || r.filename || r.file_id || 'Unknown',
                  score: r.score
                }))
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
    const { model = 'gpt-4o-mini', maxTokens = 8192, jsonOutput = false, knowledgeBase, historyMessages } = options;

    try {
      // Build instructions: prompt + context
      let fullInstructions = instructions;
      if (message) {
        fullInstructions += '\n\n## Context\n' + message;
      }
      if (jsonOutput && !fullInstructions.toLowerCase().includes('json')) {
        fullInstructions += '\n\nRespond in JSON.';
      }

      // Build input: conversation history as proper messages
      const input = [];
      if (historyMessages && historyMessages.length > 0) {
        for (const m of historyMessages) {
          const contentType = m.role === 'assistant' ? 'output_text' : 'input_text';
          input.push({ role: m.role, content: [{ type: contentType, text: m.content }] });
        }
        console.log(`📜 OpenAI OneShot: ${historyMessages.length} history messages`);
      }
      // Always add a final user message — OpenAI requires "json" in input for json_object format
      if (jsonOutput) {
        input.push({ role: 'user', content: [{ type: 'input_text', text: 'Analyze the conversation and respond in JSON.' }] });
      } else if (input.length === 0 || historyMessages?.[historyMessages.length - 1]?.role === 'assistant') {
        input.push({ role: 'user', content: [{ type: 'input_text', text: 'Analyze the conversation and respond.' }] });
      }

      const requestParams = {
        model,
        instructions: fullInstructions,
        input,
        max_output_tokens: maxTokens,
        store: false
      };

      if (jsonOutput) {
        requestParams.text = { format: { type: 'json_object' } };
      }

      // Add file_search tool if KB is configured (same as streaming path)
      const storeIds = knowledgeBase?.storeIds?.length > 0
        ? knowledgeBase.storeIds
        : (knowledgeBase?.storeId ? [knowledgeBase.storeId] : []);
      if (knowledgeBase?.enabled && storeIds.length > 0) {
        requestParams.tools = [{ type: 'file_search', vector_store_ids: storeIds }];
        requestParams.include = ['file_search_call.results'];
        console.log(`📚 OpenAI OneShot: file_search enabled with stores: ${storeIds.join(', ')}`);
      }

      const response = await this.client.responses.create(requestParams);

      const outputItem = response.output.find(item => item.type === 'message');
      const text = outputItem?.content.find(c => c.type === 'output_text')?.text || '';
      if (!text) {
        console.warn(`⚠️ OpenAI OneShot: empty response. Status: ${response.status}, output types: ${response.output.map(o => o.type).join(', ')}`);
      }
      const usage = response.usage ? {
        inputTokens: response.usage.input_tokens || 0,
        outputTokens: response.usage.output_tokens || 0,
      } : null;
      return { text, usage };
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

}

module.exports = new OpenAIService();
