/**
 * Freeda Welcome Crew Member
 *
 * The entry-point crew member for Freeda. Provides a warm welcome
 * and naturally collects the user's name and age through conversation.
 *
 * Uses the fields extractor micro-agent to automatically detect when
 * both fields are collected, then transitions to the General crew member.
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../freeda-persona');

class FreedaWelcomeCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'welcome',
      displayName: 'Welcome',
      description: 'Warm welcome and initial profile collection (legacy - not in active flow)',
      isDefault: false,

      fieldsToCollect: [
        { name: 'name', description: "The user's first name or preferred name" },
        { name: 'age', description: "The user's age, age range, or life stage (e.g., 48, late 40s, perimenopause)" }
      ],
      transitionTo: 'general',

      guidance: `You are Freeda, a warm and friendly British menopause wellness companion 🌼

## YOUR SINGLE PURPOSE
You are the welcome agent. Your ONLY job is to collect two pieces of information from the user:
1. Their **name** (first name or preferred name)
2. Their **age** (exact age, age range, or life stage like "perimenopause")

You MUST actively ask for these. Do not get sidetracked into other topics.

## HOW TO COLLECT
- On the FIRST message: Introduce yourself warmly and ask for their name
- Once you have their name: Thank them and ask about their age in a sensitive way. But get the actual age.
- If they give both in one message: Acknowledge both warmly
- If they try to discuss symptoms or treatments: Gently redirect - "I'd love to help with that! But first, let me get to know you a little..."

## RULES
- Keep responses to 2-3 sentences max
- CRITICAL: Respond in the user's language consistently
- Use 🌼 emoji (Freeda's signature)
- Do NOT discuss medical topics, symptoms, or treatments
- Do NOT go off-topic - stay focused on collecting name and age
- Once you have both pieces of info, the system will automatically transition to the main conversation

## FILE SEARCH
When the user asks about menopause, symptoms, treatments, HRT, or health — call file_search BEFORE answering. Never mention files or searching.`,

      model: 'gpt-4o',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: {
        enabled: true,
        sources: ['Freeda 2.0']
      }
    });
  }

  /**
   * Pre-message transfer check.
   * Returns true when both name and age have been collected,
   * triggering a transition to the 'general' crew member.
   *
   * @param {Object} collectedFields - All collected fields
   * @returns {Promise<boolean>} - true if both name and age are collected
   */
  async preMessageTransfer(collectedFields) {
    const hasName = !!collectedFields.name;
    const hasAge = !!collectedFields.age;
    return hasName && hasAge;
  }

  /**
   * Build context for the LLM call
   */
  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const missing = this.fieldsToCollect.filter(f => !collectedFields[f.name]);
    const collected = this.fieldsToCollect.filter(f => !!collectedFields[f.name]);

    return {
      ...baseContext,
      role: 'Welcome and profile collection',
      fieldsAlreadyCollected: collected.map(f => `${f.name}: ${collectedFields[f.name]}`),
      fieldsStillNeeded: missing.map(f => `${f.name} - ${f.description}`),
      instruction: missing.length > 0
        ? `You still need to ask for: ${missing.map(f => f.name).join(', ')}. Focus on getting these.`
        : 'All fields collected. The system will transition automatically.',
      note: 'The fields above reflect state from previous messages. The user\'s current message may contain new field values - check it directly and do not re-ask for information already provided in this message.'
    };
  }
}

module.exports = FreedaWelcomeCrew;
