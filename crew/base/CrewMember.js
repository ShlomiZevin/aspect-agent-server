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
   * @param {Array} options.collectFields - Fields to collect from user
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

    // Fields to collect from user during conversation
    this.collectFields = options.collectFields || [];

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
      toolCount: this.tools.length,
      hasKnowledgeBase: this.knowledgeBase?.enabled || false
    };
  }
}

module.exports = CrewMember;
