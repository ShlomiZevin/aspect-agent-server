/**
 * Banking Onboarder V2 - Welcome Crew
 *
 * Quick entry point. Greet, collect name + age, check eligibility (>= 16).
 * 2 messages max, then transition to main-conversation.
 *
 * Transitions:
 * - Name + age collected, age >= 16 → 'main-conversation'
 * - Age < 16 → End journey
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');

class WelcomeCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'welcome',
      displayName: 'Welcome',
      description: 'ברכת שלום ובדיקת זכאות',
      isDefault: true,
      model: 'gpt-5-chat-latest',
      maxTokens: 1024,

      fieldsToCollect: [
        {
          name: 'user_name',
          description: "The user's name or preferred name"
        },
        {
          name: 'age',
          description: "The user's age as a number"
        }
      ],

      transitionTo: 'main-conversation-single',

      guidance: `Welcome the customer and check eligibility (age >= 16).

## FLOW
1. Greet warmly. Explain you'll help them find the perfect account. Ask their name.
2. After name — ask age.
3. Age >= 16: confirm eligibility briefly, move on.
4. Age < 16: explain respectfully, end journey.

Keep it short. 2-3 sentences per message.`,

      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    if (!collectedFields.user_name || !collectedFields.age) return false;

    const age = parseInt(collectedFields.age, 10);
    if (isNaN(age) || age < 16) return false;

    await this.writeContext('onboarding_profile', {
      name: collectedFields.user_name,
      age,
      startedAt: new Date().toISOString()
    }, true);

    console.log(`   ✅ Welcome complete: ${collectedFields.user_name}, age ${age}`);
    return true;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const cf = params.collectedFields || {};
    const age = cf.age ? parseInt(cf.age, 10) : null;

    return {
      ...baseContext,
      role: 'Welcome & Eligibility',
      customerName: cf.user_name || null,
      age: age,
      eligible: age !== null ? age >= 16 : null
    };
  }
}

module.exports = WelcomeCrew;
