/**
 * Banking Onboarder V2 - Advisor B (Recommender / ממליץ)
 *
 * Second advisor crew in the split flow. Receives the user's profile
 * from advisor-a and makes product recommendations (layers 1–3),
 * handles objections, and transitions to review-finalize.
 *
 * Uses thinker+talker pattern:
 * - Thinker (Claude): Analyzes conversation state, returns strategy JSON
 * - Talker (Gemini): Speaks naturally following thinker's advice
 *
 * Transitions to: review-finalize (when layer1 agreed + layer2 complete)
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');

const THINKING_PROMPT = `You are the strategy brain for LYBI's Advisor crew.
Your job: analyze the conversation and return a JSON object — thinkingAdvice — that the Guidance brain uses to formulate its next message. You decide what to do and why. You do not write the message.

## Output Format
Return valid JSON only. No preamble.

{
  "_summary": "one-line description of this turn's decision",
  "conversationState": "recommendation | objection | transition",
  "mandatoryFieldsComplete": false,
  "signals": null,
  "activeLayer": null,
  "pendingProduct": null,
  "layer1Agreed": false,
  "layer2Complete": false,
  "cardResponse": null,
  "checkbookResponse": null,
  "objectionStep": null,
  "readyToTransfer": false,
  "recommendedOffer": null,
  "offerPitch": null,
  "nextAction": "<what Guidance should do this turn — specific>",
  "strategy": "<why this approach fits this user>",
  "toneNote": null
}

## Decision Logic
You receive intent & context and user profile from the previous advisor stage.

### Phase 1 — Product Recommendations
Set conversationState = "recommendation".
One product per turn. Never present a menu.

Layer 1 (always first):
Account track, fee structure, credit limit (מסגרת)
Set layer1Agreed = true only on explicit agreement (כן / מתאים / אני רוצה / בואו נעשה את זה).
Interest ≠ acceptance. If user rejects: reset layer1Agreed = false, ask what didn't fit.

Layer 2 (only after layer1Agreed = true):
Credit card — always offer
Checkbook — only if there's a profile reason
Set layer2Complete = true when both have a response (accepted / declined / skipped).

Layer 3 (value proposition only):
Loans, deposits, investments — mention as future opportunity only. No active selling.

Set activeLayer to 1, 2, or 3.
Set pendingProduct to the product currently being offered.

### Phase 2 — Objection Handling
Set conversationState = "objection".

objectionStep progresses:
"value_response" — reinforce why this specific offer fits this specific user. Use something they shared.
"price_reframe" — only if value_response didn't resolve it. Frame cost as a net benefit: what they get relative to what they pay. Never lead with a discount.
"accept_decline" — clear no accepted. Move on. No re-offer ever.

### Transition
Set conversationState = "transition" and readyToTransfer = true only when:
layer1Agreed = true
layer2Complete = true

## Strategy Rules
signals: note hesitation, urgency, confidence — behavioral reads matter as much as stated intent
Lead with value. Price is a last resort — raise it only if the relevance argument failed.
recommendedOffer: "basic" | "plus" | "premium" — one specific match, not a comparison.
offerPitch: why this offer fits THIS customer — tied to something they actually shared.

כשאתה מציג מוצרים, תנאים, מחירים, עמלות, דמי ניהול או הטבות — חפש תמיד בקבצים. לא להמציא. הקבצים מכילים: מסלולי חשבון, כרטיסי אשראי, פיקדונות, הלוואות, מסגרות אשראי, צ\'קים, הטבות פתיחה ושוק הון.
אל תדבר על שירותים או נתונים שאין בקבצים`;

class AdvisorBCrew extends CrewMember {
  constructor() {
    super({
      name: 'advisor-b',
      displayName: 'ייעוץ — המלצה',
      description: 'Product recommendations and objection handling based on profiled user',
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
        { name: 'recommendedOffer', description: 'Selected account track (basic / plus / premium)' },
        { name: 'offerAccepted', description: 'Account track acceptance — explicit agreement only (כן / מתאים / אני רוצה)' },
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
   * Reads the full profile built by welcome + advisor-a.
   */
  async buildThinkerContext(params) {
    const profile = await this.getContext('onboarding_profile', true) || {};
    const prevState = await this.getContext('advisor_b_state', true) || {};

    return `## Customer
Name: ${profile.name || 'Unknown'}
Age: ${profile.age || 'Unknown'}
Gender: ${profile.gender || 'Unknown'}
Handling Principle: ${profile.handlingPrinciple || 'Unknown'}
Early Anchor: ${profile.earlyAnchor || 'None'}

## Financial Profile
Employment: ${profile.employment || 'Unknown'}
Income Range: ${profile.incomeRange || 'Unknown'}
Expense Range: ${profile.expenseRange || 'Unknown'}
Credit Usage: ${profile.creditUsage || 'Unknown'}
Main Expense Types: ${profile.mainExpenseTypes || 'Unknown'}
Financial Commitments: ${profile.financialCommitments || 'Unknown'}
Relevant Context: ${profile.relevantContext || 'None'}

## Previous State
${JSON.stringify(prevState, null, 2)}`;
  }

  /**
   * Inject domain context for the talker.
   */
  async getAdditionalContext(params) {
    const profile = await this.getContext('onboarding_profile', true) || {};
    return {
      role: 'Account Advisor — Recommendations',
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
      currentStep: 'review-finalize',
      recommendedOffer: advice.recommendedOffer || context.collectedFields?.recommendedOffer || null,
      offerAccepted: advice.layer1Agreed || false,
      cardResponse: advice.cardResponse || context.collectedFields?.cardResponse || null,
      checkbookResponse: advice.checkbookResponse || context.collectedFields?.checkbookResponse || null,
    }, true);

    console.log('   ✅ Advisor-B: readyToTransfer, transitioning to review-finalize');
    return true;
  }
}

module.exports = AdvisorBCrew;
