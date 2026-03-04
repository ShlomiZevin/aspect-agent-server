/**
 * Banking Onboarder V2 - Main Conversation Crew (Thinker+Talker)
 *
 * The core selling crew. Uses a ThinkingAdvisorAgent (Claude) to reason
 * about the customer and advise the talker (GPT-5) on what to ask and
 * when to recommend.
 *
 * Flow per message:
 * 1. buildContext() calls ThinkingAdvisorAgent with conversation + profile + offers
 * 2. Thinker returns structured advice (next question, selling strategy, recommendation)
 * 3. If thinker says offerAccepted → transition before talker responds
 * 4. Otherwise talker (GPT-5) sees advice in context and responds naturally
 *
 * No fieldsToCollect — the thinker handles everything via conversation analysis.
 *
 * Transitions:
 * - Thinker detects customer accepted offer → 'review-finalize'
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');
const thinkingAdvisor = require('../../../crew/micro-agents/ThinkingAdvisorAgent');
const { getOffersCatalog, getOfferById } = require('../offers-catalog');
const conversationService = require('../../../services/conversation.service');

// ── Thinker Prompt (Claude) ──────────────────────────────────────────
const THINKING_PROMPT = `You are a strategic advisor for a banking onboarding agent. You analyze the customer and guide the talker on what to do next.

You receive: conversation history, customer profile, and available account offers.

Return JSON:
{
  "nextQuestion": "The single question to ask next, in Hebrew. null if ready to recommend or offer was accepted.",
  "sellingStrategy": "Brief note on current approach for the talker.",
  "readyToRecommend": false,
  "recommendedOffer": null,
  "recommendationPitch": "How to present this offer when recommending.",
  "offerAccepted": false,
  "toneNotes": "Any tone adjustment based on conversation signals."
}

Rules:
- Even if you know the right offer early, keep asking to build rapport. The customer should feel understood before hearing a recommendation.
- Mix profile questions (employment, income, account usage) with discovery questions (what matters most, banking frustrations, future plans).
- When customer shows urgency or impatience — accelerate, don't over-cook.
- The recommendation should feel earned. Connect it to what they told you.
- Keep nextQuestion natural and conversational — not a form field label.
- Set offerAccepted to true ONLY when the customer explicitly agrees to the recommended offer (כן, מתאים, אני רוצה, בואו נעשה את זה, etc.). Asking questions or showing interest is NOT acceptance.
- If the customer rejects or wants something else, reset: readyToRecommend back to false, keep the conversation going.`;

class MainConversationCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'main-conversation',
      displayName: 'יועץ חשבון',
      description: 'פרופיל, ייעוץ והמלצת חשבון',
      isDefault: false,
      model: 'gpt-5-chat-latest',
      maxTokens: 1024,

      // No fieldsToCollect — thinker handles everything
      fieldsToCollect: [],

      transitionTo: 'review-finalize',

      guidance: `You are a banking advisor having a natural conversation to find the perfect account.

You receive "thinkingAdvice" in your context. Follow it:
- Ask the question it suggests, in your own natural words
- Follow its selling strategy and tone notes
- When it says ready to recommend: present the offer warmly — name, features, price, and why it fits this specific customer
- After presenting: guide toward acceptance naturally

Never mention internal systems, advice, or thinking. You are just a knowledgeable banker.`,

      tools: [],
      knowledgeBase: null
    });

    this.usesThinker = true;
  }

  async preMessageTransfer() {
    // Check if thinker flagged offer as accepted (stored in buildContext)
    const advisorState = await this.getContext('advisor_state', true);
    if (!advisorState?.offerAccepted) return false;

    await this.mergeContext('onboarding_profile', {
      currentStep: 'review-finalize',
      offerAccepted: advisorState.recommendedOffer || 'basic'
    }, true);

    console.log('   ✅ Thinker: offer accepted, transitioning to review-finalize');
    return true;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);

    // Load profile from welcome crew
    const profile = await this.getContext('onboarding_profile', true) || {};

    // Load conversation history for the thinker
    let historyText = '(no history)';
    if (this._externalConversationId) {
      try {
        const history = await conversationService.getConversationHistory(
          this._externalConversationId, 20
        );
        historyText = history
          .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
          .join('\n\n');
      } catch (err) {
        console.error('   [MainConversation] Failed to load history:', err.message);
      }
    }

    // Build context for the thinker
    const thinkerContext = `## Customer
Name: ${profile.name || 'Unknown'}
Age: ${profile.age || 'Unknown'}

## Available Offers
${JSON.stringify(getOffersCatalog(), null, 2)}

## Conversation
${historyText}`;

    // Run the thinker (Claude)
    let thinkingAdvice = { fallback: true };
    try {
      thinkingAdvice = await thinkingAdvisor.think({
        thinkingPrompt: THINKING_PROMPT,
        context: thinkerContext
      });
    } catch (err) {
      console.error('   [MainConversation] Thinker error:', err.message);
    }

    // Fallback if thinker failed
    if (thinkingAdvice.fallback || thinkingAdvice.error) {
      thinkingAdvice = {
        nextQuestion: 'Ask about their employment and what they need from a bank account.',
        readyToRecommend: false,
        recommendedOffer: null,
        offerAccepted: false,
        sellingStrategy: 'Keep it simple and warm.',
        recommendationPitch: '',
        toneNotes: ''
      };
    }

    // Persist advisor state — thinker's recommendation + acceptance flag
    await this.writeContext('advisor_state', {
      recommendedOffer: thinkingAdvice.recommendedOffer || null,
      recommendationPitch: thinkingAdvice.recommendationPitch || '',
      offerAccepted: thinkingAdvice.offerAccepted === true
    }, true);

    // Resolve offer details for the talker
    let offerDetails = null;
    if (thinkingAdvice.readyToRecommend && thinkingAdvice.recommendedOffer) {
      offerDetails = getOfferById(thinkingAdvice.recommendedOffer);
    }

    return {
      ...baseContext,
      role: 'Account Advisor',
      customerName: profile.name || null,
      thinkingAdvice,
      recommendedOfferDetails: offerDetails
    };
  }
}

module.exports = MainConversationCrew;
