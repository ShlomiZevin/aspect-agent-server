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


const THINKING_PROMPT = `You are LYBI's strategy brain for the advisor stage. Analyze the conversation and return JSON with your assessment and recommendations.

Analyze:
1. **User type & handling**: Which handling principle applies (first account, young user, bad experience, etc.)? The KB has a detailed playbook for each
2. **Profile completeness**: What financial information do we have vs. what's still needed?
3. **Readiness for recommendations**: Do we understand their needs well enough to make personalized offers?
4. **Current conversation state**: Are we building profile, making recommendations, or handling objections?
5. **Product acceptance status**: What have they accepted/declined so far?
6. **Transition readiness**: Do we have all mandatory fields + product acceptance for the next crew?

Return JSON format:
{
  "_thinkingDescription": "short summary of decision — e.g. 'Profiling: asking about employment' or 'Recommending Plus plan'",

  "contextGathered": false,
  "profileCompleteness": "assessment of what we know vs need",
  "conversationState": "building_profile|making_recommendations|handling_objections",

  "nextQuestion": "the single Hebrew question to ask next, or null if recommending",
  "strategy": "what to do next and why — one sentence",
  "toneNotes": "tone adjustment if needed",

  "offerPitch": "why this offer fits THIS customer",
  "layer1Agreed": false,
  "cardOffered": false,
  "checkbookOffered": false,
  "layer2Complete": false,

  "productStatus": {
    "accountTrack": "pending|accepted|declined",
    "creditCard": "pending|accepted|declined"
  },

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
- layer2Complete=true when both card and checkbook have a response (accepted/refused/skipped).
- If contextGathered is false → nextQuestion must be about their story or motivation, not financial data. Set contextGathered=true only after the user has shared what brought them here.`;

class AdvisorCrew extends CrewMember {
  constructor() {
    super({
      name: 'advisor',
      displayName: 'ייעוץ והתאמה',
      description: 'Builds financial profile and creates personalized product recommendations',
      isDefault: false,
      model: 'gemini-2.5-flash',
      fallbackModel: 'gpt-4o',
      maxTokens: 2048,
      persona: getPersona(),
      usesThinker: true,
      thinkingPrompt: THINKING_PROMPT,
      thinkingModel: 'claude-sonnet-4-6',
      knowledgeBase: {
        enabled: true,
        sources: [
          { name: 'Onboarding KB' },
        ]
      },
      tools: [],
      fieldsToCollect: [
        { name: 'userIntent', description: 'Reason for opening the account' },
        { name: 'userType', description: 'Identified handling principle (first account, young user, bad experience, etc.)' },
        { name: 'employment', description: 'Employment status and specific role when mentioned (e.g. "part-time waitress + student", not just "part-time")' },
        { name: 'incomeRange', description: 'Monthly income in NIS — number or range (e.g. 4000, 4000-5000). Not qualitative.' },
        { name: 'expensesRange', description: 'Monthly expenses in NIS — number or range (e.g. 3000, 3000-4000). Not qualitative.' },
        { name: 'mainExpenseTypes', description: 'Main expense types' },
        { name: 'financialCommitments', description: 'Existing financial commitments (high level)' },
        { name: 'expectedAccountUsage', description: 'Expected account usage' },
        { name: 'recommendedOffer', description: 'Selected account track (basic / plus / premium)' },
        { name: 'offerAccepted', description: 'Account track acceptance status' },
        { name: 'cardResponse', description: 'Credit card — offered / response' },
        { name: 'checkbookResponse', description: 'Checkbook — offered / response' },
        { name: 'customerType', description: 'Overall read of the customer' },
        { name: 'signals', description: 'Mood, hesitation, urgency, confidence' },
      ],
      transitionTo: 'review-finalize',
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

**Bank advocate** — You genuinely believe this is the right bank for them. When it fits naturally, let the bank's strengths surface within your recommendation — not as a pitch, but as part of why this is a good match.

**One clear offer at a time** - Introduce products progressively. Let each offer land before moving to the next.

Keep each message focused on one topic or question. Build their financial profile gradually through natural conversation, not interrogation. Let them respond to one thing before moving to the next.

## Conversation Flow:

### 1. Intent & Context
Always open with one warm question about their story — what brought them here, what prompted this now. This is not a financial question. Listen for handling principle signals (first account, young user, bad bank experience, browsing, specific purpose, adding account, offer-driven, life event) and let that shape everything that follows.

Once you identify the handling principle, consult your knowledge base for the detailed playbook. The KB contains handling principles for each user type, product catalog, banking terms, competitor info, and operational policies. Use it whenever you need accurate details — for product recommendations, banking concept explanations, competitor comparisons, or handling principle guidance. Only after they've shared their context, let financial profiling flow naturally from what they said.

### 2. Financial Profile Building
Build their profile to support recommendations - not maximum completeness. Collect naturally:
- Employment status and type
- Income range (not exact)
- Expenses range (not exact) - not before income
- Main expense types
- Existing financial commitments (high level)
- Expected account usage
- Relevant context (student, irregular income, etc.)

### 3. Product Recommendations
Based on their profile, present personalized packages. Use the KB — for product recommendations, banking concept explanations, and handling principle guidance.

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

## Conversation
${historyText}`;
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
   * Check if thinker decided we're ready to transition to review-finalize.
   */
  async postThinkingTransfer(context) {
    const advice = context.thinkingAdvice;
    if (!advice?.readyToTransfer) return false;

    await this.mergeContext('onboarding_profile', {
      currentStep: 'next-crew',
      offerAccepted: context.collectedFields?.recommendedOffer || advice.recommendedOffer || null,
      cardResponse: advice.cardResponse || null,
      checkbookResponse: advice.checkbookResponse || null
    }, true);

    console.log('   ✅ Advisor: readyToTransfer, transitioning');
    return true;
  }
}

module.exports = AdvisorCrew;
