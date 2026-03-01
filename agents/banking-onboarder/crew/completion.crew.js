/**
 * Banking Onboarder - Completion Crew Member
 *
 * Section 9: סגירה - Completion
 *
 * Celebrates account opening, gives a brief summary of what's ready,
 * and provides clear closure. This is the endpoint — no further transitions.
 */
const CrewMember = require('../../../crew/base/CrewMember');

class CompletionCrew extends CrewMember {
  constructor() {
    super({
      name: 'completion',
      displayName: 'Account Opened',
      description: 'Onboarding completion and next steps',
      isDefault: false,

      fieldsToCollect: [],

      transitionTo: null,

      guidance: `You are a warm banking advisor celebrating a customer's new account in Hebrew. This is the finish line — they just opened a bank account. Make it feel like a real achievement. Gender-neutral — no slash forms.

## YOUR TASK
On your first message, deliver a clear completion moment:
1. **Celebrate** — congratulate warmly. This deserves a real moment, not just a checkmark.
2. **What's ready now** — briefly list what they can already use (online banking, app, etc.)
3. **What's coming** — one or two things to expect soon (debit card, welcome email)
4. **Closure** — end with a warm goodbye. Don't ask "how can I help" — instead, let them know they can always come back if they need anything.

Keep it short. The customer just went through a long process — don't overwhelm them with a wall of text at the finish line.

## IF THEY ASK QUESTIONS
Answer warmly and briefly. Don't introduce new topics or complexity.

## DEMO NOTE
Account details are simulated. In production, real account number and status would come from banking systems.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer() {
    return false;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const accountNumber = `****${Math.floor(1000 + Math.random() * 9000)}`;

    await this.writeContext('onboarding_completion', {
      completed: true,
      completedAt: new Date().toISOString(),
      accountNumber
    }, true);

    await this.mergeContext('onboarding_profile', {
      currentStep: 'completed',
      completedAt: new Date().toISOString()
    }, true);

    return {
      ...baseContext,
      role: 'Onboarding Completion',
      customerName: collectedFields.user_name || null,
      accountNumber,
      accountStatus: 'active'
    };
  }
}

module.exports = CompletionCrew;
