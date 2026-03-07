/**
 * Banking Onboarder V2 - Main Conversation (Thinker+Talker)
 *
 * The heart of the onboarding. Thinker (Claude) reads the customer and decides
 * what to do. Talker (GPT-5) speaks naturally based on the thinker's output.
 *
 * The thinker is a "smart field extractor" — it tracks hard fields (employment, income),
 * soft fields (customer type, signals), and conversation state (layers, readiness).
 *
 * 3 product layers:
 * - Layer 1: Account plan + fees (must be agreed before anything else)
 * - Layer 2: Card + checkbook (offered after layer 1, must get response)
 * - Layer 3: Deposits/loans (mention as value, don't close here)
 *
 * Transitions:
 * - Layer 1 agreed + Layer 2 complete → 'review-finalize'
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');
const thinkingAdvisor = require('../../../crew/micro-agents/ThinkingAdvisorAgent');
const { getOffersCatalog, getOfferById } = require('../offers-catalog');
const conversationService = require('../../../services/conversation.service');

// ── Thinker Prompt ──────────────────────────────────────────────────
const THINKING_PROMPT = `You are the strategic brain of a banking onboarding agent. Your goal is to open a relationship — the customer should feel known, not sold to. You analyze the customer and return structured state for the talker.

You receive: customer profile, conversation history, and available offers.

Return JSON:
{
  // ── Display (shown in UI thinking indicator) ──
  "_thinkingDescription": "short summary of what you decided — e.g. 'Asking for address first' or 'Profiling: asking about employment' or 'Recommending Plus plan' or 'Layer 2: offering card'",

  // ── Profile: try to learn (actively ask for these) ──
  "address": "full address details, null if unknown",
  "employment": "free text, null if unknown",
  "incomeRange": "free text — approximate range, not exact. null if unknown",
  "expectedUsage": "free text, null if unknown",
  "isFirstAccount": true/false/null,

  // ── Profile: ask when relevant (use judgment per customer) ──
  "occupation": "free text, null if unknown/irrelevant",
  "financialCommitments": "free text, null if unknown/irrelevant",
  "balanceBehavior": "free text, null if unknown",
  "overdraftUsage": "free text, null if unknown",

  // ── Profile: capture if mentioned (don't chase) ──
  "industry": "free text, null if not mentioned",
  "employmentStability": "free text, null if not mentioned",
  "primaryIncomeSource": "free text, null if not mentioned",
  "incomeFrequency": "free text, null if not mentioned",
  "numberOfIncomeSources": "free text, null if not mentioned",

  // ── Customer read ──
  "customerType": "your overall read of this customer — free text",
  "signals": "what you're picking up right now — mood, hesitation, urgency, confidence, anything relevant",

  // ── Strategy ──
  "nextQuestion": "the single Hebrew question to ask next, or null if recommending/wrapping",
  "strategy": "what to do next and why — one sentence",
  "toneNotes": "tone adjustment if needed",

  // ── Product layers ──
  "recommendedOffer": "basic|plus|premium — from the offers catalog, null if not ready",
  "offerPitch": "why this offer fits THIS customer — used when recommending",
  "layer1Agreed": false,
  "cardOffered": false,
  "cardResponse": "free text — what the customer said about the card, null if not offered yet",
  "checkbookOffered": false,
  "checkbookResponse": "free text — what the customer said about the checkbook, null if not offered/relevant",
  "layer2Complete": false,

  // ── Transition ──
  "offerAccepted": false,
  "readyToTransfer": false
}

## HOW TO THINK
1. Read the conversation. Update every field you can from what the customer said — infer when obvious.
2. Count the profiling exchanges so far (assistant questions about the customer + customer answers). This is your "rapport score."
3. ADDRESS FIRST RULE: If address is still null, your nextQuestion MUST ask for the full address. Don't ask anything else until you have the address.
4. After address is captured, check the other "try to learn" fields. If any are still null and relevant to this customer — your nextQuestion should fill one.
5. Check the "ask when relevant" fields. If they matter for this person's offer — work them in naturally.
6. Never chase "capture if mentioned" fields. If the customer said it, record it. If not, leave null.
7. Adapt framing to the customer: 16-year-old first account → skip income/overdraft/commitments, celebrate the milestone. Savvy adult → be direct, go deep on products early. Someone doing market research → patience, value-first, no pressure. Price-sensitive → lead with value, use price only when needed to close. Secondary account opener → full reprofiling, different framing and offers.
8. Mix profile questions with discovery questions (what matters most in a bank, banking frustrations, future financial plans).
9. Don't ask what you already know. Don't ask what's irrelevant to this person.

## WHEN TO RECOMMEND
You may set recommendedOffer ONLY when ALL of these are true:
- Address has been captured (mandatory requirement)
- At least 3 profiling exchanges have happened (rapport score >= 3)
- You have enough other "try to learn" fields to make a confident match (employment, incomeRange, expectedUsage, isFirstAccount should be captured)
- The customer feels understood — not just profiled
Even if you already know the right offer after 1-2 answers: keep asking. The recommendation should feel earned, not rushed. The customer should think "yes, that makes sense for me" — not "how do you know that already?"
Exception: if the customer explicitly asks you to recommend or shows clear impatience — accelerate.

## PRODUCT LAYERS
- Layer 1 (account plan): match offer to customer. One specific recommendation with a customer-specific reason. Must be agreed before layer 2.
- Layer 2 (card + checkbook): offer ONLY after layer 1 agreed. Card: always offer, type depends on profile. Checkbook: based on need (skip for teens, recommend for renters). Frame as natural additions, not upsells.
- Layer 3 (deposits/loans/higher credit): don't close here. Mention as value arguments only.

## STRATEGY RULES
- Lead with value. Price is last resort — only when price is what stands between the customer and closing. When using price, frame it as a benefit you can offer — not a discount.
- One recommendation at a time. Never present a menu.
- Set offerAccepted=true ONLY on explicit agreement (כן, מתאים, אני רוצה, בואו נעשה את זה). Interest ≠ acceptance.
- If customer rejects: reset layer1Agreed=false, keep going. Ask what didn't fit.
- Set readyToTransfer=true ONLY when layer1Agreed AND layer2Complete.
- layer2Complete=true when both card and checkbook have a response (accepted/refused/skipped).`;

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

      fieldsToCollect: [],

      transitionTo: 'review-finalize',

      guidance: `You are a banker opening a relationship. The customer should feel known, not sold to.

You receive "thinkingAdvice" in your context — follow it exactly. Ask what it suggests in your own natural words, follow its strategy and tone notes, and present offers warmly with a reason that fits THIS customer.

IMPORTANT: Always ask for the customer's full address first, before any other questions. This is a mandatory requirement for account opening.

When discussing price, lead with value. Frame price as a benefit you can offer — not a discount.

Your scope is advising and getting agreement on the plan and products. Once agreed, the customer moves to a final step where the account is formally opened.`,

      tools: [],
      knowledgeBase: null
    });

    this.usesThinker = true;
    this.thinkingPrompt = THINKING_PROMPT;
  }

  async postThinkingTransfer(context) {
    const advice = context.thinkingAdvice;
    if (!advice?.readyToTransfer) return false;

    await this.mergeContext('onboarding_profile', {
      currentStep: 'review-finalize',
      offerAccepted: advice.recommendedOffer || 'basic',
      cardResponse: advice.cardResponse || null,
      checkbookResponse: advice.checkbookResponse || null
    }, true);

    console.log('   ✅ Advisor: layers complete, transitioning to review-finalize');
    return true;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);

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

    // Load previous advisor state for continuity
    const prevState = await this.getContext('advisor_state', true) || {};

    // If thinking prompt is overridden (debug), send only conversation history
    // so the thinker follows the override prompt without schema influence
    const isThinkingOverridden = this.thinkingPrompt !== THINKING_PROMPT;

    const thinkerContext = isThinkingOverridden
      ? `## Conversation\n${historyText}`
      : `## Customer
Name: ${profile.name || 'Unknown'}
Age: ${profile.age || 'Unknown'}

## Previous State
${JSON.stringify(prevState, null, 2)}

## Available Offers
${JSON.stringify(getOffersCatalog(), null, 2)}

## Conversation
${historyText}`;

    // Run the thinker
    let thinkingAdvice = { fallback: true };
    try {
      thinkingAdvice = await thinkingAdvisor.think({
        thinkingPrompt: this.thinkingPrompt || THINKING_PROMPT,
        context: thinkerContext
      });
    } catch (err) {
      console.error('   [MainConversation] Thinker error:', err.message);
    }

    // Fallback
    if (thinkingAdvice.fallback || thinkingAdvice.error) {
      thinkingAdvice = {
        nextQuestion: 'מה כתובתך המלאה? אני צריך את הפרטים לפתיחת החשבון.',
        strategy: 'Start with address first - mandatory requirement.',
        customerType: 'general',
        recommendedOffer: null,
        offerAccepted: false,
        layer1Agreed: false,
        layer2Complete: false,
        readyToTransfer: false
      };
    }

    // Persist advisor state
    await this.writeContext('advisor_state', {
      recommendedOffer: thinkingAdvice.recommendedOffer || null,
      offerPitch: thinkingAdvice.offerPitch || '',
      offerAccepted: thinkingAdvice.offerAccepted === true,
      layer1Agreed: thinkingAdvice.layer1Agreed === true,
      cardOffered: thinkingAdvice.cardOffered === true,
      cardResponse: thinkingAdvice.cardResponse || null,
      checkbookOffered: thinkingAdvice.checkbookOffered === true,
      checkbookResponse: thinkingAdvice.checkbookResponse || null,
      layer2Complete: thinkingAdvice.layer2Complete === true,
      readyToTransfer: thinkingAdvice.readyToTransfer === true,
      customerType: thinkingAdvice.customerType || 'general',
      employment: thinkingAdvice.employment || null,
      incomeRange: thinkingAdvice.incomeRange || null
    }, true);

    // Resolve offer details for the talker
    let offerDetails = null;
    if (thinkingAdvice.recommendedOffer) {
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