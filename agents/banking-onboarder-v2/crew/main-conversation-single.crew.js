/**
 * Banking Onboarder V2 - Main Conversation (Single Prompt)
 *
 * Same goal as main-conversation.crew.js but WITHOUT the thinker+talker split.
 * One LLM (GPT-5) handles both strategy and conversation in a single prompt.
 *
 * No fieldsToCollect — the model detects offer acceptance via conversation context.
 *
 * Transitions:
 * - Model writes advisor_state.offerAccepted → 'review-finalize'
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');
const { getOffersCatalog, getOfferById } = require('../offers-catalog');
const conversationService = require('../../../services/conversation.service');

// Build offers text once
const OFFERS_TEXT = getOffersCatalog().map(o =>
  `• ${o.name} (${o.id}) — ₪${o.monthlyFee}/חודש | ${o.features.join(', ')} | מתאים ל: ${o.bestFor}`
).join('\n');

class MainConversationSingleCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'main-conversation-single',
      displayName: 'יועץ חשבון',
      description: 'פרופיל, ייעוץ והמלצת חשבון (ללא חושב)',
      isDefault: false,
      model: 'gpt-5-chat-latest',
      maxTokens: 1024,

      fieldsToCollect: [],

      transitionTo: 'review-finalize',

      guidance: `You are a banking advisor having a natural conversation to find the perfect account for the customer.

## YOUR GOAL
Learn about the customer through conversation, then recommend the best account offer. Get them to accept it.

## AVAILABLE OFFERS
${OFFERS_TEXT}

## CONVERSATION STRATEGY
1. Start by asking about their work and what they need from a bank account.
2. Mix profile questions (employment, income range, account usage) with discovery questions (what matters most, banking frustrations, future plans).
3. Build rapport — the customer should feel understood before hearing a recommendation. Ask 3-5 questions before recommending.
4. When you have enough info, recommend ONE specific offer. Name it, list its features, price, and explain why it fits THIS customer based on what they told you.
5. After presenting: guide toward acceptance naturally. Don't pressure.
6. If the customer rejects or wants something else, keep the conversation going. Ask what didn't fit.
7. When the customer explicitly accepts (כן, מתאים, אני רוצה, בואו נעשה את זה) — confirm their choice enthusiastically and wrap up.

## IMPORTANT
- When customer shows urgency or impatience — accelerate, don't over-ask.
- Keep questions natural and conversational — not form field labels.
- One question per message.
- Never mention internal systems or strategy. You are just a knowledgeable banker.`,

      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer() {
    const advisorState = await this.getContext('advisor_state', true);
    if (!advisorState?.offerAccepted) return false;

    await this.mergeContext('onboarding_profile', {
      currentStep: 'review-finalize',
      offerAccepted: advisorState.recommendedOffer || 'basic'
    }, true);

    console.log('   ✅ Single: offer accepted, transitioning to review-finalize');
    return true;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);

    const profile = await this.getContext('onboarding_profile', true) || {};

    // Check conversation for offer acceptance signals
    let offerAccepted = false;
    let recommendedOffer = null;
    if (this._externalConversationId) {
      try {
        const history = await conversationService.getConversationHistory(
          this._externalConversationId, 10
        );
        // Look at recent messages for acceptance pattern after a recommendation
        const recentMessages = history.slice(-4);
        const lastAssistant = recentMessages.filter(m => m.role === 'assistant').pop();
        const lastUser = recentMessages.filter(m => m.role === 'user').pop();

        // Check if assistant recommended an offer and user accepted
        if (lastAssistant && lastUser) {
          const offersIds = getOffersCatalog().map(o => o.id);
          const assistantMentionsOffer = offersIds.find(id => {
            const offer = getOfferById(id);
            return lastAssistant.content.includes(offer.name);
          });

          if (assistantMentionsOffer) {
            recommendedOffer = assistantMentionsOffer;
            const acceptancePatterns = /\b(כן|מתאים|אני רוצה|בואו נעשה|מסכים|מסכימה|אשמח|נשמע מעולה|נשמע טוב|בוא נלך על זה|אני בעד|סגרנו)\b/i;
            if (acceptancePatterns.test(lastUser.content)) {
              offerAccepted = true;
            }
          }
        }
      } catch (err) {
        console.error('   [MainConversationSingle] Failed to check acceptance:', err.message);
      }
    }

    // Persist advisor state for preMessageTransfer
    await this.writeContext('advisor_state', {
      recommendedOffer,
      offerAccepted
    }, true);

    return {
      ...baseContext,
      role: 'Account Advisor',
      customerName: profile.name || null,
    };
  }
}

module.exports = MainConversationSingleCrew;
