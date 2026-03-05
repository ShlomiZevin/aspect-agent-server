/**
 * Banking Onboarder V2 - Review & Finalize Crew
 *
 * Final step. Summarize, get explicit authorization, open account, orient.
 * Terminal crew — no further transitions.
 *
 * Flow:
 * 1. Summarize: account plan, products agreed, key terms
 * 2. Require explicit authorization — deliberate moment
 * 3. On authorization: celebrate, show what's ready, provide next actions
 *
 * Runs only after advisor crew handed off a confirmed account agreement.
 * Hard gate: no account opens without explicit authorization.
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');
const { getOfferById } = require('../offers-catalog');

class ReviewFinalizeCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'review-finalize',
      displayName: 'סיכום ואישור',
      description: 'סיכום, אישור ופתיחת חשבון',
      isDefault: false,
      model: 'gpt-5-chat-latest',
      maxTokens: 1500,
      extractionMode: 'form',

      fieldsToCollect: [
        {
          name: 'authorized',
          type: 'boolean',
          description: "Explicit authorization to open the account. Set to true only on clear confirmation (מאשר/ת, כן, אני מסכים/ה, פתחו לי, בואו נעשה את זה). NOT on questions or hesitation."
        }
      ],

      transitionTo: null,

      guidance: `This is the final step before account opening. Make it feel deliberate, not rushed.

## BEFORE AUTHORIZATION
1. Signal clearly: "הגענו לשלב האחרון"
2. Summarize at a high level:
   - Account plan chosen (name, monthly fee)
   - Products added (card type, checkbook if any)
   - Key benefits relevant to this customer
3. Show review links: [תנאי שימוש](/banking/terms.html) | [מדיניות פרטיות](/banking/privacy.html) | [טבלת עמלות](/banking/fees.html)
4. Ask for explicit authorization — frame it as a deliberate digital signature moment
5. If customer pauses: allow it. No pressure. No account opens without explicit consent.

## AFTER AUTHORIZATION
1. Celebrate warmly — this is a milestone 🎉
2. Confirm what was opened: account name, masked account number
3. What's ready now: app access, online banking, transfers
4. What's coming soon: card delivery (7-10 business days), welcome email
5. 1-3 clear next actions (download app, set up standing orders, etc.)
6. Warm goodbye — let them know they can always come back

## RULES
- Don't introduce new information or decisions
- Don't reopen negotiation or offers
- Don't overload — cognitive load should be low
- Answer questions briefly without reopening discussion
- After confirmation: the tone shifts — onboarding is over, banking begins`,

      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer() {
    return false; // Terminal crew
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const cf = params.collectedFields || {};
    const authorized = cf.authorized === 'true';

    const profile = await this.getContext('onboarding_profile', true) || {};
    const advisorState = await this.getContext('advisor_state', true) || {};

    const acceptedOffer = getOfferById(advisorState.recommendedOffer || profile.offerAccepted) || null;

    if (authorized) {
      const accountNumber = `****${Math.floor(1000 + Math.random() * 9000)}`;
      await this.writeContext('onboarding_completion', {
        completed: true,
        completedAt: new Date().toISOString(),
        accountNumber,
        offer: acceptedOffer?.id || 'basic',
        card: advisorState.cardResponse || null,
        checkbook: advisorState.checkbookResponse || null
      }, true);

      await this.mergeContext('onboarding_profile', {
        currentStep: 'completed',
        completedAt: new Date().toISOString()
      }, true);
    }

    return {
      ...baseContext,
      role: 'Review & Finalize',
      customerName: profile.name || null,
      acceptedOffer,
      cardResponse: advisorState.cardResponse || profile.cardResponse || null,
      checkbookResponse: advisorState.checkbookResponse || profile.checkbookResponse || null,
      authorized
    };
  }
}

module.exports = ReviewFinalizeCrew;
