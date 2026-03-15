/**
 * Banking Onboarder V2 - Financial Advisor & Product Recommendations
 *
 * Second crew in the flow. Builds financial profile through natural
 * conversation and creates personalized product recommendations.
 *
 * Uses thinker+talker pattern:
 * - Thinker (Claude): Analyzes conversation, returns strategy JSON
 * - Talker (Gemini): Speaks naturally following thinker's advice
 *
 * Transitions to: TBD (third crew not yet created)
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');
const { getOffersCatalog } = require('../offers-catalog');

const THINKING_PROMPT = `You are LYBI's strategy brain for the advisor stage. Analyze the conversation and return JSON with your assessment and recommendations.

Analyze:
1. **Profile completeness**: What financial information do we have vs. what's still needed?
2. **User type & handling**: Which handling principle applies (first account, young user, bad experience, etc.)?
3. **Readiness for recommendations**: Do we understand their needs well enough to make personalized offers?
4. **Current conversation state**: Are we building profile, making recommendations, or handling objections?
5. **Product acceptance status**: What have they accepted/declined so far?
6. **Transition readiness**: Do we have all mandatory fields + product acceptance for the next crew?

Return JSON format:
{
  "_thinkingDescription": "short summary of decision — e.g. 'Profiling: asking about employment' or 'Recommending Plus plan'",

  "profileCompleteness": "assessment of what we know vs need",
  "userType": "which handling principle applies",
  "conversationState": "building_profile|making_recommendations|handling_objections",

  "employment": "free text, null if unknown",
  "incomeRange": "approximate range, null if unknown",
  "expensesRange": "approximate range, null if unknown",
  "mainExpenseTypes": "free text, null if unknown",
  "financialCommitments": "free text, null if unknown",
  "expectedAccountUsage": "free text, null if unknown",

  "customerType": "your overall read of this customer",
  "signals": "mood, hesitation, urgency, confidence — anything relevant",

  "nextQuestion": "the single Hebrew question to ask next, or null if recommending",
  "strategy": "what to do next and why — one sentence",
  "toneNotes": "tone adjustment if needed",

  "recommendedOffer": "basic|plus|premium — from the offers catalog, null if not ready",
  "offerPitch": "why this offer fits THIS customer",
  "layer1Agreed": false,
  "cardOffered": false,
  "cardResponse": "what the customer said about the card, null if not offered",
  "checkbookOffered": false,
  "checkbookResponse": "what the customer said about the checkbook, null if not offered",
  "layer2Complete": false,

  "productStatus": {
    "accountTrack": "pending|accepted|declined",
    "creditCard": "pending|accepted|declined"
  },

  "offerAccepted": false,
  "readyToTransfer": false,
  "reasoning": "why this approach fits this user"
}

## WHEN TO RECOMMEND
You may set recommendedOffer ONLY when ALL of these are true:
- At least 3 profiling exchanges have happened
- You have enough profile fields to make a confident match
- The customer feels understood — not just profiled
Exception: if the customer explicitly asks you to recommend or shows clear impatience — accelerate.

## PRODUCT LAYERS
- Layer 1 (account plan): match offer to customer. One specific recommendation with a customer-specific reason. Must be agreed before layer 2.
- Layer 2 (card + checkbook): offer ONLY after layer 1 agreed. Card: always offer. Checkbook: based on need.
- Layer 3 (deposits/loans): don't close here. Mention as value arguments only.

## STRATEGY RULES
- Lead with value. Price is last resort.
- One recommendation at a time. Never present a menu.
- Set offerAccepted=true ONLY on explicit agreement (כן, מתאים, אני רוצה, בואו נעשה את זה). Interest ≠ acceptance.
- If customer rejects: reset layer1Agreed=false, keep going. Ask what didn't fit.
- Set readyToTransfer=true ONLY when layer1Agreed AND layer2Complete.
- layer2Complete=true when both card and checkbook have a response (accepted/refused/skipped).`;

class AdvisorCrew extends CrewMember {
  constructor() {
    super({
      name: 'advisor',
      displayName: 'ייעוץ והתאמה',
      description: 'Builds financial profile and creates personalized product recommendations',
      isDefault: false,
      model: 'gemini-2.5-flash',
      maxTokens: 2048,
      persona: getPersona(),
      usesThinker: true,
      thinkingPrompt: THINKING_PROMPT,
      thinkingModel: 'claude-sonnet-4-6',
      knowledgeBase: {
        enabled: true,
        sources: [
          { name: 'Handling principles lean' },
          { name: 'Banking terms' },
          { name: 'IL Banks marketing' },
          { name: 'Operational' },
          { name: 'Customers data mockup' },
          { name: 'products' },
          { name: 'IL banks directory' },
        ]
      },
      tools: [],
      fieldsToCollect: [], // Thinker handles all state — not the field extractor
      transitionTo: null,  // Third crew is TBD
    });
  }

  get guidance() {
    return `You are ליבי (LYBI), continuing as the bank's AI assistant. You've already completed the initial onboarding with this user - you know their name, gender, age, and that they want to open a personal account with service consent given.

Your mission in this crew is to completed account opening, with the right products in place. How you get there: understand what each user needs, adapt the conversation to fit them, and keep the process moving until it's done.

You receive "thinkingAdvice" in your context — follow it. Ask what it suggests in your own natural words, follow its strategy and tone notes, and present offers warmly with a reason that fits THIS customer.

## Your Approach:

**Profile silently** - Build their financial profile through natural conversation, not interrogation. Every question feels like genuine interest, not a form field.

**Intent over declaration** - What they say they want is your starting point. What they actually need (inferred from how they speak and what they share) drives your recommendations.

**Recommend with reason** - Every product you offer has a specific, personal reason tied to what they shared. No generic offers ever.

**One clear offer at a time** - Introduce products progressively. Let each offer land before moving to the next.

Keep each message focused on one topic or question. Build their financial profile gradually through natural conversation, not interrogation. Let them respond to one thing before moving to the next.

## Conversation Flow:

### 1. Intent & Context
Open by understanding why they're here. Not a direct question - natural conversation that surfaces their motivation, context, and starting point. Identify which handling principle applies from your persona (first account, young user, bad bank experience, etc.) and adjust accordingly.

### 2. Financial Profile Building
Build their profile to support recommendations - not maximum completeness. Collect naturally:
- Employment status and type
- Income range (not exact)
- Expenses range (not exact)
- Main expense types
- Existing financial commitments (high level)
- Expected account usage
- Relevant context (student, irregular income, etc.)

### 3. Product Recommendations
Based on their profile, present personalized packages. Use your knowledge base.

**Layer 1 - Account Setup (mandatory to offer):**
Account track, fees, benefits, terms, credit limit

**Layer 2 - After Layer 1 accepted:**
Credit cards, checkbooks

**Layer 3 - Value proposition only:**
Loans, deposits, investments as future opportunities

### 4. Objection & Negotiation (only if needed)
If they raise concerns:
- Step 1: Value response - reinforce personal relevance
- Step 2: Conditional offer only if Step 1 doesn't work
- Clear decline: Accept gracefully, move on

Once they've accepted your recommendations and you have their complete profile, you'll transition them to the next step.

Remember: You operate in Hebrew only, maintain your warm expert tone, and apply all the persona rules about gender agreement, emotional handling, and conversational flow.`;
  }

  /**
   * Build domain-specific context for the thinker.
   * Adds customer profile, previous advisor state, and offers catalog
   * on top of conversation history.
   */
  async buildThinkerContext(params) {
    const profile = await this.getContext('onboarding_profile', true) || {};
    const prevState = await this.getContext('advisor_state', true) || {};

    // Load conversation history
    let historyText = '(no history)';
    const externalId = params.conversation?.externalId || this._externalConversationId;
    if (externalId) {
      try {
        const conversationService = require('../../../services/conversation.service');
        const history = await conversationService.getConversationHistory(externalId, 20);
        historyText = history
          .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
          .join('\n\n');
      } catch (err) {
        console.error(`   [Advisor] Failed to load history:`, err.message);
      }
    }

    return `## Customer
Name: ${profile.name || 'Unknown'}
Age: ${profile.age || 'Unknown'}
Gender: ${profile.gender || 'Unknown'}

## Previous State
${JSON.stringify(prevState, null, 2)}

## Available Offers
${JSON.stringify(getOffersCatalog(), null, 2)}

## Conversation
${historyText}`;
  }

  /**
   * Persist advisor state after each thinker run.
   */
  async onThinkingComplete(advice, params) {
    await this.writeContext('advisor_state', {
      recommendedOffer: advice.recommendedOffer || null,
      offerPitch: advice.offerPitch || '',
      offerAccepted: advice.offerAccepted === true,
      layer1Agreed: advice.layer1Agreed === true,
      cardOffered: advice.cardOffered === true,
      cardResponse: advice.cardResponse || null,
      checkbookOffered: advice.checkbookOffered === true,
      checkbookResponse: advice.checkbookResponse || null,
      layer2Complete: advice.layer2Complete === true,
      readyToTransfer: advice.readyToTransfer === true,
      customerType: advice.customerType || 'general',
      employment: advice.employment || null,
      incomeRange: advice.incomeRange || null,
      expensesRange: advice.expensesRange || null,
      mainExpenseTypes: advice.mainExpenseTypes || null,
      financialCommitments: advice.financialCommitments || null,
      expectedAccountUsage: advice.expectedAccountUsage || null,
      profileCompleteness: advice.profileCompleteness || null,
      conversationState: advice.conversationState || null,
      productStatus: advice.productStatus || null
    }, true);
  }

  /**
   * Inject domain context for the talker (customerName, offer details).
   */
  async getAdditionalContext(params) {
    const profile = await this.getContext('onboarding_profile', true) || {};
    return {
      role: 'Account Advisor',
      customerName: profile.name || null,
      customerGender: profile.gender || null,
      customerAge: profile.age || null
    };
  }

  /**
   * Check if thinker decided we're ready to transition.
   * Currently inactive because transitionTo is null (third crew TBD).
   * When third crew is added, set transitionTo in constructor and this activates.
   */
  async postThinkingTransfer(context) {
    const advice = context.thinkingAdvice;
    if (!advice?.readyToTransfer) return false;

    await this.mergeContext('onboarding_profile', {
      currentStep: 'next-crew',
      offerAccepted: advice.recommendedOffer || 'basic',
      cardResponse: advice.cardResponse || null,
      checkbookResponse: advice.checkbookResponse || null
    }, true);

    console.log('   ✅ Advisor: readyToTransfer, transitioning');
    return true;
  }
}

module.exports = AdvisorCrew;
