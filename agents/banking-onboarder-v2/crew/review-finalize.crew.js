/**
 * Banking Onboarder V2 - Review & Finalize Crew
 *
 * Summary, authorization, and account opening celebration.
 * Terminal crew — no further transitions.
 *
 * Flow:
 * 1. First message: summarize accepted offer, show review links, ask for authorization
 * 2. After authorization: celebrate, show what's ready, warm goodbye
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
          description: "Set to true when user gives explicit authorization to open the account (מאשר, כן, אני מסכים, פתחו לי, בואו נעשה את זה)"
        }
      ],

      transitionTo: null,

      guidance: `You are a banking advisor at the final step.

## BEFORE AUTHORIZATION
Summarize: the chosen offer (name, features, monthly fee), and why it fits them.
Include review links: [תנאי שימוש](https://example.com/terms) | [מדיניות פרטיות](https://example.com/privacy) | [טבלת עמלות](https://example.com/fees)
Briefly explain what happens after they confirm (account opens, card shipped, app access).
Ask for explicit authorization — frame it as a deliberate digital signature moment.

## AFTER AUTHORIZATION
Celebrate warmly. Account opened.
What's ready now: app, online banking, transfers.
What's coming soon: debit card, welcome email.
Warm goodbye — let them know they can always come back.

## QUESTIONS
Answer briefly. Don't reopen the offer discussion.`,

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

    // Load profile and advisor state
    const profile = await this.getContext('onboarding_profile', true) || {};
    const advisorState = await this.getContext('advisor_state', true) || {};

    // Get the accepted offer details
    const acceptedOffer = getOfferById(advisorState.recommendedOffer || profile.offerAccepted) || null;

    // On authorization — write completion
    if (authorized) {
      const accountNumber = `****${Math.floor(1000 + Math.random() * 9000)}`;
      await this.writeContext('onboarding_completion', {
        completed: true,
        completedAt: new Date().toISOString(),
        accountNumber,
        offer: acceptedOffer?.id || 'basic'
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
      authorized
    };
  }
}

module.exports = ReviewFinalizeCrew;
