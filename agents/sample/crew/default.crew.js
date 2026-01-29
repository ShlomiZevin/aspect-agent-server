/**
 * Sample Default Crew Member
 *
 * This is the default crew member for the sample agent.
 * It demonstrates the basic structure of a crew member.
 */
const CrewMember = require('../../../crew/base/CrewMember');

class SampleDefaultCrew extends CrewMember {
  constructor() {
    super({
      name: 'default',
      displayName: 'Sample Assistant',
      description: 'A friendly assistant that helps with general questions',
      isDefault: true,

      guidance: `You are a helpful and friendly assistant.

Your role is to:
- Answer questions clearly and concisely
- Be polite and professional
- Ask clarifying questions when needed
- Provide accurate information

If you don't know something, be honest about it. Don't make up information.

When the user asks about technical topics or needs specialized help,
you can suggest that they might benefit from speaking with a specialist.`,

      model: 'gpt-4',
      maxTokens: 2048,

      tools: [],

      collectFields: []
    });
  }

  /**
   * Build context for the LLM call
   */
  async buildContext(params) {
    const baseContext = await super.buildContext(params);

    return {
      ...baseContext,
      greeting: 'Hello! I\'m your Sample Assistant.',
      capabilities: [
        'Answering general questions',
        'Providing helpful information',
        'Having friendly conversations'
      ]
    };
  }

  /**
   * Check if we should transition to another crew member
   */
  async checkTransition(params) {
    const { message, response } = params;
    const lowerMessage = message.toLowerCase();

    // Example: Transition to technical expert for coding questions
    const techKeywords = ['code', 'programming', 'debug', 'error', 'api', 'database'];
    const hasTechContent = techKeywords.some(kw => lowerMessage.includes(kw));

    if (hasTechContent) {
      // In a real implementation, you might have a 'technical-expert' crew
      // For now, we'll just log and not transition
      console.log('📝 Technical content detected, but no technical crew available');
    }

    // No transition for now
    return null;
  }
}

module.exports = SampleDefaultCrew;
