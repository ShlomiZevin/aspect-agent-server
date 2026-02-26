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
 * - oneShot: If true, delivers one response then auto-transitions on next message
 * - persona: Shared character/voice text injected into context for all crews of an agent
 * - isDefault: Whether this is the default crew member for the agent
 *
 * Context methods (available after dispatcher sets _userId):
 * - getContext(namespace): Read context data from DB
 * - writeContext(namespace, data): Write context data to DB
 * - mergeContext(namespace, data): Merge data into existing context
 */
const contextService = require('../../services/context.service');

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
   * @param {string} options.transitionSystemPrompt - System prompt injected once when transitioning to this crew
   * @param {boolean} options.oneShot - If true, crew delivers one response then auto-transitions on next user message
   * @param {string} options.persona - Shared character/voice text for the agent (injected into context automatically by buildContext)
   * @param {Array} options.transitionRules - Optional structured rules for debug visualization [{id, type, condition: {description, fields, evaluate}, result, priority}]
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

    // System prompt injected once when transitioning to this crew member
    // Used to override historical conversation patterns when switching personas
    this.transitionSystemPrompt = options.transitionSystemPrompt || null;

    // One-shot crews deliver one response then auto-transition on next user message
    this.oneShot = options.oneShot || false;

    // Shared character/voice text for the agent
    // When set, buildContext() automatically includes it as `characterGuidance` in the context.
    // All crews of an agent can share the same persona by importing a shared module.
    this.persona = options.persona || null;

    // Transition rules for debug visualization (optional)
    // If defined, debug panel shows structured pass/fail evaluation
    // If not defined, debug panel shows raw function code as fallback
    this.transitionRules = options.transitionRules || [];

    // Context service state (set by dispatcher before use)
    this._userId = null;
    this._conversationId = null; // Internal database conversation ID
    this._externalConversationId = null; // External conversation ID (UUID)
  }

  /**
   * Set the user context for context service operations.
   * Called by dispatcher before buildContext.
   *
   * @param {number} userId - User ID
   * @param {number|null} conversationId - Conversation ID (for conversation-level context)
   * @param {string|null} externalConversationId - External conversation ID (UUID)
   */
  setContextUser(userId, conversationId = null, externalConversationId = null) {
    this._userId = userId;
    this._conversationId = conversationId;
    this._externalConversationId = externalConversationId;
  }

  /**
   * Get context data from the database by namespace.
   * Use in buildContext() to load persisted context.
   *
   * @param {string} namespace - Context namespace (e.g., 'journey', 'preferences')
   * @param {boolean} conversationLevel - If true, get conversation-level context instead of user-level
   * @returns {Promise<Object|null>} - Context data or null
   */
  async getContext(namespace, conversationLevel = false) {
    if (!this._userId) {
      console.warn(`⚠️ getContext called without userId set for crew: ${this.name}`);
      return null;
    }
    const convId = conversationLevel ? this._conversationId : null;
    return await contextService.getContext(this._userId, namespace, convId);
  }

  /**
   * Write context data to the database.
   * Use to persist data that should be available across sessions.
   *
   * @param {string} namespace - Context namespace (e.g., 'journey', 'preferences')
   * @param {Object} data - Data to save
   * @param {boolean} conversationLevel - If true, save as conversation-level context
   * @returns {Promise<boolean>} - Success status
   */
  async writeContext(namespace, data, conversationLevel = false) {
    if (!this._userId) {
      console.warn(`⚠️ writeContext called without userId set for crew: ${this.name}`);
      return false;
    }
    const convId = conversationLevel ? this._conversationId : null;
    return await contextService.saveContext(this._userId, namespace, data, convId);
  }

  /**
   * Merge data into existing context (shallow merge).
   * Useful for updating specific fields without overwriting the entire context.
   *
   * @param {string} namespace - Context namespace
   * @param {Object} data - Data to merge
   * @param {boolean} conversationLevel - If true, merge into conversation-level context
   * @returns {Promise<boolean>} - Success status
   */
  async mergeContext(namespace, data, conversationLevel = false) {
    if (!this._userId) {
      console.warn(`⚠️ mergeContext called without userId set for crew: ${this.name}`);
      return false;
    }
    const convId = conversationLevel ? this._conversationId : null;
    return await contextService.mergeContext(this._userId, namespace, data, convId);
  }

  /**
   * Get the fields that should be sent to the extractor for the current message.
   * Override in subclasses to control which fields are active at any point in the conversation.
   * For example, a consent crew can expose only the currently presented consent field.
   *
   * @param {Object} collectedFields - Already collected fields {name: value, ...}
   * @returns {Array} - Fields to extract [{name, description}, ...]
   */
  getFieldsForExtraction(collectedFields) {
    return this.fieldsToCollect;
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
    const context = {
      collectedData: params.collectedData || {},
      timestamp: new Date().toISOString()
    };

    // Auto-inject persona as characterGuidance when set
    if (this.persona) {
      context.characterGuidance = this.persona;
    }

    return context;
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
      model: this.model,
      collectFields: this.collectFields,
      fieldsToCollect: this.fieldsToCollect,
      extractionMode: this.extractionMode,
      transitionTo: this.transitionTo,
      oneShot: this.oneShot,
      toolCount: this.tools.length,
      hasKnowledgeBase: this.knowledgeBase?.enabled || false,
      knowledgeBase: this.knowledgeBase ? {
        enabled: this.knowledgeBase.enabled || false,
        sources: this.knowledgeBase.sources || [],
      } : null,
      hasTransitionPrompt: !!this.transitionSystemPrompt,
      persona: this.persona || null,
      source: this.source || 'file'
    };
  }
}

module.exports = CrewMember;
