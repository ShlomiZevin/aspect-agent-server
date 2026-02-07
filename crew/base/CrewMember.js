/**
 * Base CrewMember Class
 *
 * All crew members inherit from this class. Each crew member represents
 * a specialized role within an agent (e.g., Receptionist, Profiler, Specialist).
 *
 * Crew members define:
 * - guidance: The prompt text that defines behavior
 * - model: Which LLM model to use
 * - tools: Available function tools
 * - knowledgeBase: Knowledge base configuration (provider-agnostic)
 * - collectFields: Fields to gather from the user
 * - fieldsToCollect: Structured field definitions for micro-agent extraction
 * - transitionTo: Target crew member for automatic transitions
 * - isDefault: Whether this is the default crew member for the agent
 */
class CrewMember {
  /**
   * @param {Object} options - Crew member configuration
   * @param {string} options.name - Unique identifier (e.g., "receptionist")
   * @param {string} options.displayName - Human-readable name
   * @param {string} options.description - Description of this crew member's role
   * @param {string} options.guidance - The prompt text defining behavior
   * @param {string} options.model - LLM model to use (default: "gpt-4")
   * @param {number} options.maxTokens - Max tokens for response (default: 2048)
   * @param {Array} options.tools - Array of tool definitions { name, description, parameters, handler? }
   * @param {Object} options.knowledgeBase - Knowledge base config { enabled: boolean, storeId?: string }
   * @param {Array} options.collectFields - Fields to collect from user (legacy, string array)
   * @param {Array} options.fieldsToCollect - Structured fields for extraction [{name, description}]
   * @param {string} options.extractionMode - Field extraction mode: 'conversational' (default) or 'form' (strict, last message only)
   * @param {string} options.transitionTo - Target crew member name for automatic transitions
   * @param {boolean} options.isDefault - Whether this is the default crew member
   */
  constructor(options = {}) {
    // Identity
    this.name = options.name || 'unnamed';
    this.displayName = options.displayName || this.name;
    this.description = options.description || '';

    // Guidance (the prompt that defines this crew member's behavior)
    this.guidance = options.guidance || '';

    // Model configuration
    this.model = options.model || 'gpt-4';
    this.maxTokens = options.maxTokens || 2048;

    // Tools this crew member can use
    this.tools = options.tools || [];

    // Knowledge base configuration
    // { enabled: boolean, storeId?: string }
    // enabled: whether this crew member uses a knowledge base
    // storeId: the KB store identifier for this crew member
    this.knowledgeBase = options.knowledgeBase || null;

    // Fields to collect from user during conversation (legacy, string array)
    this.collectFields = options.collectFields || [];

    // Structured fields for micro-agent extraction
    // Each entry: { name: string, description: string }
    this.fieldsToCollect = options.fieldsToCollect || [];

    // Field extraction mode:
    // - 'conversational' (default): Uses recent messages, contextual extraction
    // - 'form': Strict mode, only extracts from last user message, better for form-like data collection
    this.extractionMode = options.extractionMode || 'conversational';

    // Target crew member for automatic transitions
    this.transitionTo = options.transitionTo || null;

    // Whether this is the default crew member for the agent
    this.isDefault = options.isDefault || false;
  }

  /**
   * Build context for the LLM call
   * Override in subclasses for custom context building
   *
   * @param {Object} params - Context parameters
   * @param {Object} params.conversation - Conversation data
   * @param {Object} params.user - User data
   * @param {Object} params.collectedData - Data collected so far
   * @param {Object} params.metadata - Additional metadata
   * @returns {Object} - Additional context to include in prompt
   */
  async buildContext(params) {
    return {
      collectedData: params.collectedData || {},
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Determine if transition to another crew member should occur
   * Called after each LLM response
   *
   * @param {Object} params - Transition check parameters
   * @param {string} params.message - User's message
   * @param {string} params.response - LLM's response
   * @param {Object} params.conversation - Conversation data
   * @param {Object} params.collectedData - Collected fields data
   * @returns {Object|null} - { targetCrew: string, reason: string } or null for no transition
   */
  async checkTransition(params) {
    // Default: no transition
    return null;
  }

  /**
   * Pre-process user message before sending to LLM
   * Override for custom preprocessing
   *
   * @param {string} message - User's message
   * @param {Object} context - Current context
   * @returns {string} - Processed message
   */
  async preProcess(message, context) {
    return message;
  }

  /**
   * Post-process LLM response before sending to user
   * Override for custom postprocessing
   *
   * @param {string} response - LLM's response
   * @param {Object} context - Current context
   * @returns {string} - Processed response
   */
  async postProcess(response, context) {
    return response;
  }

  /**
   * Determine if a transfer should occur BEFORE the crew response is sent.
   * Called after the fields extractor completes, while crew response is buffered.
   * If returns true, the buffered crew response is discarded and the conversation
   * transitions to the crew member specified by this.transitionTo.
   *
   * @param {Object} collectedFields - All collected fields for this conversation
   * @returns {Promise<boolean>} - true to transfer (using this.transitionTo), false to continue
   */
  async preMessageTransfer(collectedFields) {
    return false;
  }

  /**
   * Determine if a transfer should occur AFTER the crew response is sent.
   * Called after the crew response has been fully streamed to the client.
   * If returns true, the conversation transitions to this.transitionTo for the next message.
   *
   * @param {Object} collectedFields - All collected fields for this conversation
   * @returns {Promise<boolean>} - true to transfer (using this.transitionTo), false to stay
   */
  async postMessageTransfer(collectedFields) {
    return false;
  }

  /**
   * Get tool definitions formatted for the LLM provider
   *
   * @returns {Array} - Tool schemas
   */
  getToolSchemas() {
    return this.tools.map(tool => ({
      type: 'function',
      name: `call_${tool.name}`,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} }
    }));
  }

  /**
   * Serialize crew member for API responses
   *
   * @returns {Object} - JSON representation
   */
  toJSON() {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      isDefault: this.isDefault,
      collectFields: this.collectFields,
      fieldsToCollect: this.fieldsToCollect,
      extractionMode: this.extractionMode,
      transitionTo: this.transitionTo,
      toolCount: this.tools.length,
      hasKnowledgeBase: this.knowledgeBase?.enabled || false
    };
  }
}

module.exports = CrewMember;
