/**
 * Dynamic Crew Member
 *
 * A crew member that is instantiated from database configuration.
 * Used for crews created via the dashboard (not file-based) and
 * by the Playground for ephemeral crew testing.
 *
 * Thinker mode is handled by the base CrewMember class.
 * For advanced logic, export the crew to a file and customize there.
 */
const CrewMember = require('./CrewMember');

class DynamicCrewMember extends CrewMember {
  /**
   * Create a DynamicCrewMember from a database config object
   *
   * @param {Object} config - Config from crew_members table
   * @param {string} config.name - Unique identifier
   * @param {string} config.displayName - Human-readable name
   * @param {string} config.description - Description
   * @param {boolean} config.isDefault - Whether default crew
   * @param {string} config.guidance - The prompt
   * @param {string} config.model - LLM model
   * @param {number} config.maxTokens - Max tokens
   * @param {Object} config.knowledgeBase - KB config
   * @param {Array} config.fieldsToCollect - Fields to extract
   * @param {string} config.transitionTo - Target crew
   * @param {string} config.transitionSystemPrompt - Transition prompt
   * @param {Array} config.tools - Tool names (resolved by registry)
   */
  constructor(config) {
    // Pass config directly to base class
    super({
      name: config.name,
      displayName: config.displayName,
      description: config.description || '',
      isDefault: config.isDefault || false,
      guidance: config.guidance,
      model: config.model || 'gpt-4o',
      maxTokens: config.maxTokens || 2048,
      knowledgeBase: config.knowledgeBase || null,
      fieldsToCollect: config.fieldsToCollect || [],
      transitionTo: config.transitionTo || null,
      transitionSystemPrompt: config.transitionSystemPrompt || null,
      // Note: tools are stored as names in DB, resolved at runtime by dispatcher
      tools: []
    });

    // Mark as DB-sourced
    this.source = 'database';

    // Store tool names for later resolution
    this._toolNames = config.tools || [];

    // Store DB record ID
    this._dbId = config.id || null;
  }

  /**
   * Get the tool names configured for this crew (for dispatcher to resolve)
   * @returns {Array<string>} - Array of tool names
   */
  getToolNames() {
    return this._toolNames;
  }

  /**
   * Default field-based transition: return true when all fieldsToCollect
   * are present. File-based crews override this with custom logic.
   */
  async preMessageTransfer(collectedFields) {
    if (!this.transitionTo || !this.fieldsToCollect || this.fieldsToCollect.length === 0) {
      return false;
    }
    const allCollected = this.fieldsToCollect.every(f => collectedFields[f.name] != null);
    return allCollected;
  }

  /**
   * Override toJSON to include source info
   */
  toJSON() {
    const base = super.toJSON();
    return {
      ...base,
      source: 'database',
      dbId: this._dbId,
      toolNames: this._toolNames
    };
  }
}

module.exports = DynamicCrewMember;
