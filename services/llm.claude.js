const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

/**
 * Claude/Anthropic LLM Service
 *
 * Provides Claude API integration for:
 * - One-shot completions (for crew generation)
 * - Streaming responses with prompt (for future chat use)
 * - Specialized crew generation from natural language descriptions
 */
class ClaudeService {
  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    // Default model - can be overridden per request
    this.model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
  }

  /**
   * Send a stateless, non-streaming one-shot request.
   * Similar to OpenAI's sendOneShot method.
   *
   * @param {string} systemPrompt - System instructions/prompt
   * @param {string} message - The user message content
   * @param {Object} options - Configuration options
   * @param {string} options.model - Model to use (default: claude-sonnet-4-20250514)
   * @param {number} options.maxTokens - Max output tokens (default: 4096)
   * @param {boolean} options.jsonOutput - Request JSON output (adds instruction to respond with JSON)
   * @returns {Promise<string>} - The response text
   */
  async sendOneShot(systemPrompt, message, options = {}) {
    const {
      model = this.model,
      maxTokens = 4096,
      jsonOutput = false
    } = options;

    try {
      // If JSON output requested, add instruction to system prompt
      let finalSystemPrompt = systemPrompt;
      if (jsonOutput) {
        finalSystemPrompt += '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no code blocks, no explanation - just the raw JSON object.';
      }

      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system: finalSystemPrompt,
        messages: [
          { role: 'user', content: message }
        ]
      });

      // Extract text from response
      const textContent = response.content.find(c => c.type === 'text');
      return textContent?.text || '';
    } catch (error) {
      console.error('❌ Claude OneShot Error:', error.message);
      throw new Error(`Failed to get Claude response: ${error.message}`);
    }
  }

  /**
   * Send a message with conversation history and get a streaming response.
   * Similar to OpenAI's sendMessageStreamWithPrompt.
   *
   * @param {string} message - The user message
   * @param {Array} history - Previous messages [{role, content}, ...]
   * @param {Object} config - Configuration object
   * @param {string} config.systemPrompt - System instructions
   * @param {string} config.model - Model to use
   * @param {number} config.maxTokens - Max tokens
   * @param {Array} config.tools - Tool definitions (Claude format)
   * @param {Object} config.toolHandlers - Map of tool name -> handler function
   * @returns {AsyncGenerator} - Stream of text chunks or tool events
   */
  async *sendMessageStreamWithPrompt(message, history = [], config = {}) {
    const {
      systemPrompt = '',
      model = this.model,
      maxTokens = 4096,
      tools = [],
      toolHandlers = {}
    } = config;

    try {
      // Build messages array: history + current message
      const messages = [
        ...history,
        { role: 'user', content: message }
      ];

      console.log(`🤖 Claude streaming with prompt (${systemPrompt.length} chars), ${tools.length} tools, ${history.length} history messages`);

      let maxIterations = 10;
      let currentMessages = messages;

      while (maxIterations > 0) {
        maxIterations--;

        const requestParams = {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: currentMessages,
          stream: true
        };

        // Add tools if provided
        if (tools.length > 0) {
          requestParams.tools = tools;
        }

        const stream = await this.client.messages.stream(requestParams);

        let fullReply = '';
        const pendingToolCalls = [];

        for await (const event of stream) {
          // Handle text delta
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text;
            if (text) {
              fullReply += text;
              yield text; // Yield string for backward compatibility
            }
          }

          // Handle tool use
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            pendingToolCalls.push({
              id: event.content_block.id,
              name: event.content_block.name,
              input: {}
            });
          }

          // Accumulate tool input
          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
            const lastTool = pendingToolCalls[pendingToolCalls.length - 1];
            if (lastTool) {
              // Parse incremental JSON (Claude streams JSON as partial strings)
              try {
                const partialInput = event.delta.partial_json || '';
                lastTool.inputStr = (lastTool.inputStr || '') + partialInput;
              } catch (e) {
                // Continue accumulating
              }
            }
          }

          // Tool use complete
          if (event.type === 'content_block_stop') {
            const lastTool = pendingToolCalls[pendingToolCalls.length - 1];
            if (lastTool && lastTool.inputStr) {
              try {
                lastTool.input = JSON.parse(lastTool.inputStr);
              } catch (e) {
                console.warn('⚠️ Failed to parse tool input:', e.message);
              }
            }
          }
        }

        // Handle tool calls
        if (pendingToolCalls.length > 0) {
          const toolResults = [];

          for (const toolCall of pendingToolCalls) {
            yield {
              type: 'function_call',
              name: toolCall.name,
              params: toolCall.input
            };

            try {
              const handler = toolHandlers[toolCall.name];
              if (!handler) {
                throw new Error(`No handler for tool: ${toolCall.name}`);
              }

              const result = await handler(toolCall.input);

              yield {
                type: 'function_result',
                name: toolCall.name,
                result
              };

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: JSON.stringify(result)
              });
            } catch (error) {
              console.error(`❌ Tool call failed: ${toolCall.name}`, error.message);

              yield {
                type: 'function_error',
                name: toolCall.name,
                error: error.message
              };

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: JSON.stringify({ error: error.message }),
                is_error: true
              });
            }
          }

          // Continue conversation with tool results
          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: pendingToolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })) },
            { role: 'user', content: toolResults }
          ];
        } else {
          // No tool calls - done
          console.log(`✅ Claude streaming complete. Total reply length: ${fullReply.length}`);
          break;
        }
      }
    } catch (error) {
      console.error('❌ Claude Streaming Error:', error.message);
      throw new Error(`Failed to stream Claude response: ${error.message}`);
    }
  }

  /**
   * Generate a crew member configuration from a natural language description.
   * Loads context files (guides, examples) and uses Claude to generate the config.
   *
   * @param {string} description - Natural language description of the crew member
   * @param {string} agentName - The agent this crew will belong to
   * @param {Object} options - Additional options
   * @param {Array<string>} options.existingCrews - Names of existing crews (for transition options)
   * @param {Array<string>} options.availableTools - Available tool names
   * @param {Array<{id: string, name: string}>} options.knowledgeBases - Available KB stores
   * @returns {Promise<Object>} - The generated crew configuration object
   */
  async generateCrewFromDescription(description, agentName, options = {}) {
    const {
      existingCrews = [],
      availableTools = [],
      knowledgeBases = []
    } = options;

    try {
      // Load context documents
      const guideContent = this._loadContextFile('AGENT_BUILDING_GUIDE.md');
      const architectureContent = this._loadContextFile('DYNAMIC_CREW_ARCHITECTURE.md');
      const exampleCrew = this._loadExampleCrew();

      // Build the system prompt
      const systemPrompt = this._buildGenerationSystemPrompt();

      // Build the user message with all context
      const userMessage = this._buildGenerationUserMessage({
        description,
        agentName,
        guideContent,
        architectureContent,
        exampleCrew,
        existingCrews,
        availableTools,
        knowledgeBases
      });

      console.log(`🤖 Generating crew config for agent "${agentName}" (description: ${description.length} chars)`);

      // Call Claude for generation
      const response = await this.sendOneShot(systemPrompt, userMessage, {
        maxTokens: 8192,
        jsonOutput: true
      });

      // Parse and validate the response
      const crewConfig = this._parseAndValidateCrewConfig(response);

      console.log(`✅ Generated crew config: ${crewConfig.name} (${crewConfig.displayName})`);

      return crewConfig;
    } catch (error) {
      console.error('❌ Crew generation failed:', error.message);
      throw new Error(`Failed to generate crew: ${error.message}`);
    }
  }

  /**
   * Load a context file from the server root
   * @private
   */
  _loadContextFile(filename) {
    try {
      const filePath = path.join(__dirname, '..', filename);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
      console.warn(`⚠️ Context file not found: ${filename}`);
      return '';
    } catch (error) {
      console.warn(`⚠️ Failed to load context file ${filename}:`, error.message);
      return '';
    }
  }

  /**
   * Load an example crew file for reference
   * @private
   */
  _loadExampleCrew() {
    try {
      // Try to load a simple example crew
      const examplePath = path.join(__dirname, '..', 'agents', 'sample', 'crew', 'default.crew.js');
      if (fs.existsSync(examplePath)) {
        return fs.readFileSync(examplePath, 'utf8');
      }

      // Fallback: try freeda general
      const freedaPath = path.join(__dirname, '..', 'agents', 'freeda', 'crew', 'general.crew.js');
      if (fs.existsSync(freedaPath)) {
        return fs.readFileSync(freedaPath, 'utf8');
      }

      return '';
    } catch (error) {
      console.warn('⚠️ Failed to load example crew:', error.message);
      return '';
    }
  }

  /**
   * Build the system prompt for crew generation
   * @private
   */
  _buildGenerationSystemPrompt() {
    return `You are an expert AI agent architect. Your task is to generate crew member configurations for a multi-agent chat platform.

A crew member is a specialized role within an AI agent. Each crew handles a specific part of a conversation flow.

You will be given:
1. Documentation about how crew members work (the architecture guide)
2. An example of an existing crew member
3. A natural language description of what the new crew should do
4. Context about the agent and its existing crews

Your job is to generate a complete, valid JSON configuration for the new crew member.

OUTPUT RULES:
- Output ONLY valid JSON - no markdown, no code blocks, no explanation
- The JSON must match the crew member schema exactly
- Generate appropriate field names (snake_case)
- Write detailed, professional guidance prompts
- Be conservative with tools - only include if clearly needed
- Only reference existing crews for transitions`;
  }

  /**
   * Build the user message with all context for generation
   * @private
   */
  _buildGenerationUserMessage(params) {
    const {
      description,
      agentName,
      guideContent,
      architectureContent,
      exampleCrew,
      existingCrews,
      availableTools,
      knowledgeBases
    } = params;

    return `## ARCHITECTURE GUIDE
${architectureContent || guideContent || 'No guide available - use best practices for conversational AI crews.'}

## EXAMPLE CREW MEMBER FILE
\`\`\`javascript
${exampleCrew || '// No example available'}
\`\`\`

## AGENT CONTEXT
- Agent Name: ${agentName}
- Existing Crews: ${existingCrews.length > 0 ? existingCrews.join(', ') : 'None yet (this may be the first crew)'}
- Available Tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'None available'}
- Knowledge Bases: ${knowledgeBases.length > 0 ? knowledgeBases.map(kb => `${kb.name} (${kb.id})`).join(', ') : 'None available'}

## USER DESCRIPTION
${description}

## OUTPUT SCHEMA
Generate a JSON object with these fields:
{
  "name": "string - unique identifier, snake_case (e.g., 'billing_support')",
  "displayName": "string - human readable name (e.g., 'Billing Support')",
  "description": "string - brief description of what this crew does",
  "isDefault": "boolean - true if this is the entry point crew",
  "guidance": "string - the full system prompt/instructions for this crew",
  "model": "string - LLM model to use (default: 'gpt-4o')",
  "maxTokens": "number - max response tokens (default: 2048)",
  "fieldsToCollect": "array - fields to extract from conversation, each: { name: string, description: string }",
  "transitionTo": "string | null - name of crew to transition to when done",
  "transitionSystemPrompt": "string | null - message injected when transitioning TO this crew",
  "tools": "array - tool names to enable (from available tools list)",
  "knowledgeBase": "object | null - { enabled: boolean, storeId: string } if using KB"
}

Now generate the crew configuration JSON:`;
  }

  /**
   * Parse and validate the generated crew config
   * @private
   */
  _parseAndValidateCrewConfig(response) {
    // Clean up response - remove any markdown code blocks if present
    let cleanResponse = response.trim();
    if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Parse JSON
    let config;
    try {
      config = JSON.parse(cleanResponse);
    } catch (error) {
      throw new Error(`Invalid JSON response from Claude: ${error.message}`);
    }

    // Validate required fields
    const required = ['name', 'displayName', 'guidance'];
    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Apply defaults
    const defaults = {
      description: '',
      isDefault: false,
      model: 'gpt-4o',
      maxTokens: 2048,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,
      tools: [],
      knowledgeBase: null
    };

    return { ...defaults, ...config };
  }

  /**
   * Generate the .crew.js file code from a config object.
   * Used for "Export to File" feature.
   *
   * @param {Object} config - The crew configuration object
   * @param {string} agentName - The agent name (for class naming)
   * @returns {string} - The generated JavaScript code
   */
  generateCrewFileCode(config, agentName) {
    // Convert name to PascalCase for class name (no agent prefix)
    const className = config.name
      .split('_')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('') + 'Crew';

    // Build the file content
    const code = `/**
 * ${config.displayName}
 *
 * ${config.description || 'Auto-generated crew member'}
 * Generated by Crew Builder
 */
const CrewMember = require('../../../crew/base/CrewMember');

class ${className} extends CrewMember {
  constructor() {
    super({
      name: '${config.name}',
      displayName: '${config.displayName}',
      description: '${(config.description || '').replace(/'/g, "\\'")}',
      isDefault: ${config.isDefault},

      guidance: \`${config.guidance.replace(/`/g, '\\`')}\`,

      model: '${config.model}',
      maxTokens: ${config.maxTokens},

      fieldsToCollect: ${JSON.stringify(config.fieldsToCollect || [], null, 6).replace(/\n/g, '\n      ')},

      transitionTo: ${config.transitionTo ? `'${config.transitionTo}'` : 'null'},
      ${config.transitionSystemPrompt ? `transitionSystemPrompt: \`${config.transitionSystemPrompt.replace(/`/g, '\\`')}\`,` : '// transitionSystemPrompt: null,'}

      tools: [],  // TODO: Add tools if needed
      knowledgeBase: ${config.knowledgeBase ? JSON.stringify(config.knowledgeBase) : 'null'}
    });
  }

  // TODO: Override buildContext() if you need custom context
  // async buildContext(params) {
  //   const baseContext = await super.buildContext(params);
  //   return {
  //     ...baseContext,
  //     // Add custom context here
  //   };
  // }

  // TODO: Override preMessageTransfer() if you need custom transition logic
  // async preMessageTransfer(collectedFields) {
  //   // Return true to trigger transition to this.transitionTo
  //   return false;
  // }
}

module.exports = ${className};
`;

    return code;
  }
}

module.exports = new ClaudeService();
