/**
 * Google Gemini LLM Service (New SDK: @google/genai)
 *
 * Uses dynamic import() because @google/genai is ESM-only.
 *
 * Provides Google Gemini API integration for:
 * - One-shot completions (for micro-agents, field extraction)
 * - Streaming responses with prompt (for crew members)
 * - Tool/function calling support
 * - System instructions support
 *
 * Environment variable: GEMINI_API_KEY
 */

// Cached SDK module and client
let GoogleGenAI = null;
let client = null;
let clientApiKey = null;

const providerConfigService = require('./provider-config.service');

/**
 * Lazily initialize the Google GenAI client
 * Uses dynamic import() for ESM compatibility
 * Recreates client if API key has changed.
 */
async function getClient() {
  const currentKey = providerConfigService.getCached('gemini_api_key') || process.env.GEMINI_API_KEY;
  if (client && clientApiKey === currentKey) return client;

  // Dynamic import for ESM module
  const genai = await import('@google/genai');
  GoogleGenAI = genai.GoogleGenAI;

  client = new GoogleGenAI({ apiKey: currentKey });
  clientApiKey = currentKey;
  console.log('✅ Google GenAI client initialized');
  return client;
}

class GoogleService {
  constructor() {
    // Default model - can be overridden per request
    this.model = process.env.GOOGLE_MODEL || 'gemini-2.0-flash';
  }

  /**
   * Convert tools from OpenAI format to Google Gemini format.
   * OpenAI: { type: "function", name: "call_X", description, parameters }
   * Gemini: { name: "X", description, parameters } with Type constants
   *
   * @param {Array} crewTools - Tools in OpenAI format
   * @returns {Array} - Tools in Gemini format (functionDeclarations)
   * @private
   */
  _convertToolsToGeminiFormat(crewTools) {
    if (!crewTools || crewTools.length === 0) {
      return [];
    }

    const functionDeclarations = crewTools
      .filter(tool => tool.type === 'function' || tool.name)
      .map(tool => {
        const name = tool.name?.replace(/^call_/, '') || tool.name;
        return {
          name: name,
          description: tool.description || '',
          parameters: this._convertParametersToGemini(tool.parameters),
        };
      });

    if (functionDeclarations.length === 0) {
      return [];
    }

    return [{ functionDeclarations }];
  }

  /**
   * Convert OpenAI JSON Schema parameters to Gemini format.
   * Removes unsupported fields and keeps schema clean.
   *
   * @param {Object} parameters - OpenAI format parameters
   * @returns {Object} - Gemini format parameters
   * @private
   */
  _convertParametersToGemini(parameters) {
    if (!parameters) {
      return { type: 'OBJECT', properties: {} };
    }

    // Deep clone to avoid mutating original
    const geminiParams = JSON.parse(JSON.stringify(parameters));

    // Recursively clean and convert schema
    this._cleanSchemaForGemini(geminiParams);

    return geminiParams;
  }

  /**
   * Recursively clean JSON Schema to remove fields unsupported by Gemini.
   *
   * @param {Object} schema - JSON Schema object to clean (mutates in place)
   * @private
   */
  _cleanSchemaForGemini(schema) {
    if (!schema || typeof schema !== 'object') {
      return;
    }

    // Fields not supported by Gemini's function calling schema
    const unsupportedFields = [
      'additionalProperties',
      '$schema',
      'definitions',
      '$ref',
      '$id',
      'default',
      'examples',
      'title',
      '$comment',
    ];

    for (const field of unsupportedFields) {
      delete schema[field];
    }

    // Recursively clean nested properties
    if (schema.properties && typeof schema.properties === 'object') {
      for (const key of Object.keys(schema.properties)) {
        this._cleanSchemaForGemini(schema.properties[key]);
      }
    }

    // Clean items in arrays
    if (schema.items) {
      this._cleanSchemaForGemini(schema.items);
    }

    // Clean anyOf, oneOf, allOf
    for (const combiner of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(schema[combiner])) {
        for (const subSchema of schema[combiner]) {
          this._cleanSchemaForGemini(subSchema);
        }
      }
    }
  }

  /**
   * Convert conversation history to Gemini format.
   * Gemini uses 'user' and 'model' roles (not 'assistant').
   *
   * @param {Array} history - Message history from DB
   * @returns {Array} - Gemini-formatted history
   * @private
   */
  _convertHistoryToGemini(history) {
    return history
      .map(msg => {
        if (!msg || !msg.role || !msg.content) {
          return null;
        }

        // Skip system/developer messages (they go in systemInstruction)
        if (msg.role === 'system' || msg.role === 'developer') {
          return null;
        }

        // Map roles: assistant -> model, user stays user
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        return {
          role,
          parts: [{ text: content }],
        };
      })
      .filter(msg => msg !== null);
  }

  /**
   * Get available Google Gemini models.
   * @returns {Array<string>} - List of available model names
   */
  getAvailableModels() {
    return [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ];
  }

  /**
   * Send a stateless, non-streaming one-shot request.
   * Used by micro-agents for quick completions.
   *
   * @param {string} systemPrompt - System instructions
   * @param {string} message - The user message
   * @param {Object} options - { model, maxTokens, jsonOutput }
   * @returns {Promise<string>} - The response text
   */
  async sendOneShot(systemPrompt, message, options = {}) {
    const {
      model = this.model,
      maxTokens = 4096,
      jsonOutput = false,
    } = options;

    try {
      const ai = await getClient();

      let finalSystemPrompt = systemPrompt || '';
      if (jsonOutput) {
        finalSystemPrompt += '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no code blocks, no explanation - just the raw JSON object.';
      }

      const response = await ai.models.generateContent({
        model,
        contents: message,
        config: {
          systemInstruction: finalSystemPrompt,
          maxOutputTokens: maxTokens,
          temperature: 0.7,
        },
      });

      return response.text || '';
    } catch (error) {
      console.error('❌ Google OneShot Error:', error.message);
      throw new Error(`Failed to get Google response: ${error.message}`);
    }
  }

  /**
   * Send a message with conversation history and get a streaming response.
   * Supports tool/function calling with automatic execution loop.
   *
   * @param {string} message - The user message
   * @param {string} conversationId - Conversation ID to fetch history from
   * @param {Object} config - Configuration object
   * @returns {AsyncGenerator} - Stream of text chunks or tool events
   */
  async *sendMessageStreamWithPrompt(message, conversationId, config = {}) {
    const {
      prompt: systemPrompt = '',
      model = this.model,
      maxTokens = 4096,
      tools: crewTools = [],
      toolHandlers = {},
      knowledgeBase = null,
    } = config;

    // Gemini 2.5 "thinking" models use part of maxOutputTokens for internal
    // reasoning. Boost the limit so visible output isn't starved.
    // Note: flash-lite is NOT a thinking model despite the 2.5 prefix.
    const isThinkingModel = (model.includes('2.5-pro') || model.includes('2.5-flash')) && !model.includes('lite');
    const effectiveMaxTokens = isThinkingModel
      ? Math.max(maxTokens * 8, 8192)
      : maxTokens;
    if (isThinkingModel) {
      console.log(`🧠 Thinking model detected (${model}): boosting maxOutputTokens from ${maxTokens} to ${effectiveMaxTokens}`);
    }

    let apiCallCount = 0; // Track API calls for debugging

    try {
      const ai = await getClient();

      // Convert tools to Gemini format
      const geminiTools = this._convertToolsToGeminiFormat(crewTools);

      // Add file_search tool if KB is configured with Google corpus IDs
      // Supports corpusIds array (new) or googleCorpusId (legacy fallback)
      const corpusIds = knowledgeBase?.corpusIds?.length > 0
        ? knowledgeBase.corpusIds
        : (knowledgeBase?.googleCorpusId ? [knowledgeBase.googleCorpusId] : []);

      if (knowledgeBase?.enabled && corpusIds.length > 0) {
        geminiTools.push({
          fileSearch: {
            fileSearchStoreNames: corpusIds,
          },
        });
        console.log(`🔍 Google file_search tool added for stores: ${corpusIds.join(', ')}`);
      }

      // Ensure message is a string
      const messageText = typeof message === 'string' ? message : String(message);

      // Fetch conversation history from DB
      // Drop the last message if it's from the user — it's the current turn,
      // which will be sent separately via sendMessageStream()
      const conversationService = require('./conversation.service');
      let historyMessages = [];
      try {
        const history = await conversationService.getConversationHistory(conversationId, 50);
        if (history.length > 0 && history[history.length - 1].role === 'user') {
          history.pop();
        }
        historyMessages = this._convertHistoryToGemini(history);
      } catch (err) {
        console.warn('⚠️ Could not load conversation history from DB:', err.message);
      }

      const funcDeclCount = geminiTools.reduce((n, t) => n + (t.functionDeclarations?.length || 0), 0);
      const hasFileSearch = geminiTools.some(t => t.fileSearch);
      console.log(`🤖 Google streaming with prompt (${systemPrompt.length} chars), ${funcDeclCount} function tools, fileSearch: ${hasFileSearch}, ${historyMessages.length} history messages`);
      if (hasFileSearch) {
        console.log(`🔍 Google tools payload:`, JSON.stringify(geminiTools, null, 2));
      }



      // Create chat session with the new SDK
      const chat = ai.chats.create({
        model,
        history: historyMessages,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: effectiveMaxTokens,
          temperature: 0.7,
          tools: geminiTools.length > 0 ? geminiTools : undefined,
          // Thinking models: let the model reason properly for better instruction following
          thinkingConfig: isThinkingModel ? { thinkingBudget: 8192 } : undefined,
        },
      });

      let fullReply = '';
      let maxIterations = 10;

      // FIRST API CALL: Send user message
      apiCallCount++;
      console.log(`📤 Google API call #${apiCallCount}: Sending user message`);
      const stream = await chat.sendMessageStream({ message: messageText });

      let functionCalls = [];

      // Process initial stream
      // Gemini 2.5 sometimes outputs "THOUGHT:..." as plain text — buffer and strip it
      let fileSearchResultsEmitted = false;
      let chunkCount = 0;
      let thoughtBuffer = '';        // buffer to detect THOUGHT prefix
      let thoughtStripped = false;   // once determined, stop buffering
      for await (const chunk of stream) {
        chunkCount++;

        // Diagnostic logging for debugging stream cutoff issues (especially Pro models)
        const finishReason = chunk.candidates?.[0]?.finishReason;
        const safetyRatings = chunk.candidates?.[0]?.safetyRatings;
        const usage = chunk.usageMetadata;
        if (finishReason && finishReason !== 'STOP') {
          console.warn(`⚠️ Google chunk #${chunkCount} finishReason: ${finishReason}`);
          if (safetyRatings) {
            const blocked = safetyRatings.filter(r => r.blocked);
            if (blocked.length > 0) console.warn(`⚠️ Safety blocked:`, JSON.stringify(blocked));
          }
        }
        if (usage) {
          console.log(`📊 Google usage: prompt=${usage.promptTokenCount}, output=${usage.candidatesTokenCount}, thoughts=${usage.thoughtsTokenCount || 0}, total=${usage.totalTokenCount}`);
        }

        // Extract text from chunk (filter SDK thought parts if present)
        let chunkText = '';
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        if (parts.length > 0) {
          for (const part of parts) {
            if (part.thought) continue;
            if (part.text) chunkText += part.text;
          }
        } else if (chunk.text) {
          chunkText = chunk.text;
        }

        if (chunkText) {
          // Strip "THOUGHT:..." prefix that Gemini 2.5 sometimes outputs as plain text
          if (!thoughtStripped) {
            thoughtBuffer += chunkText;
            // Wait until we have enough text to check (or stream is ending)
            if (thoughtBuffer.length >= 8 || finishReason) {
              const trimmed = thoughtBuffer.trimStart();
              if (/^THOUGHT[\s:]/i.test(trimmed)) {
                // Find where the actual response starts (after double newline)
                const splitIdx = trimmed.search(/\n[^\n\s*THOUGHT]/);
                if (splitIdx !== -1) {
                  const cleanText = trimmed.substring(splitIdx + 1);
                  console.log(`🧹 Stripped THOUGHT prefix (${splitIdx} chars)`);
                  fullReply += cleanText;
                  yield cleanText;
                  thoughtStripped = true;
                }
                // else: still buffering, haven't found end of thought section yet
              } else {
                // No THOUGHT prefix — flush buffer normally
                fullReply += thoughtBuffer;
                yield thoughtBuffer;
                thoughtStripped = true;
              }
            }
          } else {
            fullReply += chunkText;
            yield chunkText;
          }
        }

        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          functionCalls.push(...chunk.functionCalls);
        }
        // Emit file search results from grounding metadata (typically in final chunk)
        const groundingChunks = chunk.groundingMetadata?.groundingChunks
          || chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
        if (groundingChunks?.length > 0) {
          const files = groundingChunks
            .filter(c => c.retrievedContext)
            .map(c => ({
              name: c.retrievedContext.title || c.retrievedContext.documentName || 'Unknown',
              uri: c.retrievedContext.uri || '',
              text: c.retrievedContext.text || '',
            }));
          if (files.length > 0) {
            console.log(`📄 Google file search found ${files.length} file(s): ${files.map(f => f.name).join(', ')}`);
            yield { type: 'file_search_results', files };
            fileSearchResultsEmitted = true;
          }
        }
      }

      // Flush any remaining buffered text (thought section that never ended)
      if (!thoughtStripped && thoughtBuffer.length > 0) {
        const trimmed = thoughtBuffer.trimStart();
        if (/^THOUGHT[\s:]/i.test(trimmed)) {
          // Best effort: find last paragraph as the actual response
          const lastPara = trimmed.lastIndexOf('\n\n');
          if (lastPara !== -1) {
            const cleanText = trimmed.substring(lastPara + 2);
            console.log(`🧹 Stripped THOUGHT prefix from final buffer`);
            fullReply += cleanText;
            yield cleanText;
          } else {
            // Can't find response — yield everything as fallback
            fullReply += thoughtBuffer;
            yield thoughtBuffer;
          }
        } else {
          fullReply += thoughtBuffer;
          yield thoughtBuffer;
        }
      }

      console.log(`📊 Google stream ended after ${chunkCount} chunks, reply: ${fullReply.length} chars`);

      // If no grounding data came through streaming chunks, log it for debugging
      if (corpusIds.length > 0 && !fileSearchResultsEmitted) {
        console.log(`ℹ️ Google file search: KB was configured but no grounding metadata returned in stream`);
      }

      // Function call loop - only for handling function responses
      while (functionCalls.length > 0 && maxIterations > 0) {
        maxIterations--;

        console.log(`🔧 Processing ${functionCalls.length} function call(s)`);

        const functionResponseParts = [];

        for (const funcCall of functionCalls) {
          // Yield function call event for thinking process
          console.log(`📣 Yielding function_call event: ${funcCall.name}`);
          yield {
            type: 'function_call',
            name: funcCall.name,
            params: funcCall.args,
          };

          console.log(`🧠 [function_call] Calling function: ${funcCall.name}`);

          try {
            // Try with call_ prefix first (matches dispatcher convention), then without
            const handler = toolHandlers[`call_${funcCall.name}`] || toolHandlers[funcCall.name];
            if (!handler) {
              throw new Error(`No handler for tool: ${funcCall.name}`);
            }

            const result = await handler(funcCall.args);

            yield {
              type: 'function_result',
              name: funcCall.name,
              result,
            };

            functionResponseParts.push({
              functionResponse: {
                name: funcCall.name,
                response: { result },
              },
            });
          } catch (error) {
            console.error(`❌ Tool call failed: ${funcCall.name}`, error.message);

            yield {
              type: 'function_error',
              name: funcCall.name,
              error: error.message,
            };

            functionResponseParts.push({
              functionResponse: {
                name: funcCall.name,
                response: { error: error.message },
              },
            });
          }
        }

        // Reset for next iteration
        functionCalls = [];

        // API CALL: Send function responses back to model
        apiCallCount++;
        console.log(`📤 Google API call #${apiCallCount}: Sending function responses`);
        const responseStream = await chat.sendMessageStream({
          message: functionResponseParts
        });

        // Process response to function results
        for await (const chunk of responseStream) {
          const parts = chunk.candidates?.[0]?.content?.parts || [];
          if (parts.length > 0) {
            for (const part of parts) {
              if (part.thought) continue;
              if (part.text) {
                fullReply += part.text;
                yield part.text;
              }
            }
          } else if (chunk.text) {
            fullReply += chunk.text;
            yield chunk.text;
          }
          if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            functionCalls.push(...chunk.functionCalls);
          }
        }

        // If more function calls, loop will continue
      }

      console.log(`✅ Google streaming complete. Total reply: ${fullReply.length} chars, API calls: ${apiCallCount}`);
    } catch (error) {
      console.error('❌ Google Streaming Error:', error.message);
      throw new Error(`Failed to stream Google response: ${error.message}`);
    }
  }
}

module.exports = new GoogleService();
