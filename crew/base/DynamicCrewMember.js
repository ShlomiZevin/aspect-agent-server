/**
 * Dynamic Crew Member
 *
 * A crew member that is instantiated from database configuration.
 * Used for crews created via the dashboard (not file-based) and
 * by the Playground for ephemeral crew testing.
 *
 * Supports thinker mode: when usesThinker is true, buildContext()
 * calls ThinkingAdvisorAgent to get strategic advice before the
 * talker responds.
 *
 * For advanced logic, export the crew to a file and customize there.
 */
const CrewMember = require('./CrewMember');
const thinkingAdvisor = require('../micro-agents/ThinkingAdvisorAgent');
const conversationService = require('../../services/conversation.service');

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
   * Override buildContext to support thinker mode.
   * When usesThinker is enabled, fetches conversation history,
   * calls ThinkingAdvisorAgent, and injects advice into context.
   */
  async buildContext(params) {
    const baseContext = await super.buildContext(params);

    if (!this.usesThinker || !this.thinkingPrompt) {
      return baseContext;
    }

    // Build conversation context string for the thinker
    let historyText = '(no history yet)';
    try {
      const externalId = params.conversation?.externalId;
      if (externalId) {
        const history = await conversationService.getConversationHistory(externalId, 20);
        if (history && history.length > 0) {
          historyText = history
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');
        }
      }
    } catch (err) {
      console.warn('   ⚠️ [DynamicCrewMember] Could not fetch history for thinker:', err.message);
    }

    const contextStr = `## Conversation History\n${historyText}`;

    // Auto-inject _thinkingDescription instruction if not already present
    let enhancedPrompt = this.thinkingPrompt;
    if (!enhancedPrompt.includes('_thinkingDescription')) {
      enhancedPrompt += `\n\nIMPORTANT: Your JSON response MUST include a "_thinkingDescription" field as the first key. This is a short English summary (5-15 words) of your decision for this turn, shown in the UI. Use present tense and be specific. Example: "Recommending savings plan based on income" or "Asking about employment status".`;
    }

    // Run the thinking advisor
    let thinkingAdvice = { fallback: true };
    try {
      console.log(`   🧠 [DynamicCrewMember] Running thinker with model: ${this.thinkingModel || 'claude-sonnet-4-20250514'}`);
      thinkingAdvice = await thinkingAdvisor.think(
        { thinkingPrompt: enhancedPrompt, context: contextStr },
        { model: this.thinkingModel || 'claude-sonnet-4-20250514' }
      );
    } catch (err) {
      console.error('   ❌ [DynamicCrewMember] Thinker error:', err.message);
    }

    // Provide fallback if thinker errored
    if (thinkingAdvice.fallback || thinkingAdvice.error) {
      thinkingAdvice = {
        _thinkingDescription: 'Analysis complete (fallback)',
        approach: 'Respond naturally to the user message'
      };
    }

    return {
      ...baseContext,
      thinkingAdvice
    };
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
