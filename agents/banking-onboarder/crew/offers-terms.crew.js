/**
 * Banking Onboarder - Offers & Terms Crew Member
 *
 * Section 7: המלצות - Offers, Account Terms & Conditional Negotiation
 *
 * Presents account offer immediately on first message.
 * Briefly explains why this offer fits the customer's profile.
 * Handles questions and light negotiation if needed.
 *
 * Transitions:
 * - User accepts terms → 'final-confirmations'
 */
const CrewMember = require('../../../crew/base/CrewMember');

class OffersTermsCrew extends CrewMember {
  constructor() {
    super({
      name: 'offers-terms',
      displayName: 'Account Terms & Offers',
      description: 'Account terms presentation and conditional negotiation',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        {
          name: 'terms_accepted',
          type: 'boolean',
          description: "Set to true when user confirms they accept the offer and want to proceed. Any confirmation (כן, נמשיך, מתאים, בסדר, מקובל, ok) = true."
        }
      ],

      transitionTo: 'final-confirmations',

      guidance: `You are a warm, knowledgeable banking advisor having a conversation in Hebrew. You genuinely want to help the customer find the right account. You speak naturally, like a real person — not like a bot reading a script. Gender-neutral — no slash forms, no gendered self-reference.

## YOUR TASK
Present a personalized account offer on your first message. Connect it to what the customer shared about themselves. Make the offer clear and easy to understand — lay it out nicely with short sections so anyone can scan it quickly. Include the account type, features, benefits, fees, and terms.

## CONVERSATION
When the customer pushes back or says no, be curious — ask what bothered them, what they were hoping for. Have a real conversation about it. Try to find a solution that works. Only after several genuine back-and-forth attempts, suggest visiting a branch to explore more options together.

## DEMO NOTE
Account terms are simulated for demo. In production, these would come from real product data.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2000,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    return collectedFields.terms_accepted === 'true';
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    return {
      ...baseContext,
      role: 'Account Terms & Offers',
      customerName: collectedFields.user_name || null,
      customerProfile: {
        employment: collectedFields.employment_status || null,
        income: collectedFields.monthly_income_range || null,
        usage: collectedFields.expected_account_usage || null
      },
      accepted: collectedFields.terms_accepted === 'true'
    };
  }
}

module.exports = OffersTermsCrew;
