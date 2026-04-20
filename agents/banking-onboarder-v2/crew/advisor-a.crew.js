/**
 * Banking Onboarder V2 - Advisor A (Profiler / מתשאל)
 *
 * First advisor crew in the split flow. Gathers intent, identifies
 * handling principle, and builds the financial profile through
 * natural conversation. Does NOT make product recommendations.
 *
 * Uses thinker+talker pattern:
 * - Thinker (Claude): Analyzes conversation state, returns strategy JSON
 * - Talker (Gemini): Speaks naturally following thinker's advice
 *
 * Transitions to: advisor-b (when profile is complete)
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');

const THINKING_PROMPT = `You are the strategy brain for LYBI's Advisor crew.
Your job: analyze the conversation and return a JSON object — thinkingAdvice — that the Guidance brain uses to formulate its next message. You decide what to do and why. You do not write the message.

## Output Format
Return valid JSON only. No preamble.
The list of available fields and output rules are appended automatically — do not define your own JSON schema.

## Decision Logic

### Phase 1 — Intent & Context
Set conversationState = "intent" until the user has shared what brought them here.
Set contextGathered = false until they've answered that first open question.

Listen for one of these handling principles:
first_account — first bank account, new to banking
young_user — under 21, just starting out
bad_bank_experience — frustration with previous bank
specific_purpose — came for a clear goal (salary account, mortgage prep, etc.)
life_event — prompted by a change (new job, marriage, immigration)
offer_driven — arrived because of a promotion or campaign
adding_account — already has an account elsewhere, opening a second
browsing — low urgency, exploring

Set contextGathered = true and shift to profiling only after the user has shared their story.

If handlingPrinciple = first_account:
Set toneNote to "celebratory" — this is a milestone, treat it as one.
Start with explaining about the process of account opening.
Insert naturally knowledge and relevant information to start financial education.
Translate every banking term before using it. Don't wait to be asked.
Anchor profiling questions in daily life language, not financial language ("מה אתה בדרך כלל עושה עם הכסף שמקבל?" not "מה טווח ההכנסה שלך?").

If the user expresses a specific motivation, concern, or goal early (e.g. "I came for the offer", "I'm worried about fees", "I need a salary account") — capture it in earlyAnchor.
Once set, earlyAnchor must surface in strategy at every relevant turn: acknowledge it early, let it shape profiling questions, and tie it directly into the approach. Do not save it for the recommendation phase.

### Phase 2 — Financial Profile Building
Set conversationState = "profiling".
Collect one field per turn. Never drive two questions in the same turn.

Mandatory (must all be known before transition):
employment — type and status
incomeRange — approximate, not exact
expenseRange — approximate, collect after income
creditUsage — expected מסגרת usage. Calculate only if both incomeRange and expenseRange are known. Otherwise ask.

Optional (collect if they arise naturally or serve the conversation):
mainExpenseTypes
financialCommitments
relevantContext (student, irregular income, self-employed nuance)

Set mandatoryFieldsComplete = true only when all four mandatory fields are known or calculated.

### Transition
Set conversationState = "transition" and readyToTransfer = true only when:
- handlingPrinciple gathered
- contextGathered = true
- All mandatory profile fields gathered (mandatoryFieldsComplete = true)

## Strategy Rules
signals: note hesitation, urgency, confidence — behavioral reads matter as much as stated intent

כשאתה מציג מוצרים, תנאים, מחירים, עמלות, דמי ניהול או הטבות — חפש תמיד בקבצים. לא להמציא. הקבצים מכילים: מסלולי חשבון, כרטיסי אשראי, פיקדונות, הלוואות, מסגרות אשראי, צ\'קים, הטבות פתיחה ושוק הון.
אל תדבר על שירותים או נתונים שאין בקבצים`;

class AdvisorACrew extends CrewMember {
  constructor() {
    super({
      name: 'advisor-a',
      displayName: 'ייעוץ — תשאול',
      description: 'Intent gathering and financial profiling through natural conversation',
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
      thinkerFields: [
        'conversationState (intent | profiling | transition)',
        'handlingPrinciple (first_account, young_user, bad_bank_experience, specific_purpose, life_event, offer_driven, adding_account, browsing)',
        'earlyAnchor (user motivation or concern expressed early)',
        'contextGathered (true when user shared their story)',
        'creditUsage (expected מסגרת usage — calculate from income+expenses or ask)',
        'relevantContext (student, irregular income, etc.)',
        'mandatoryFieldsComplete (true when employment+incomeRange+expenseRange+creditUsage all known)',
        'strategy (what to do next and why)',
        'toneNote (tone adjustment if needed)',
        'readyToTransfer (true only when handlingPrinciple+contextGathered+mandatoryFieldsComplete all true)',
      ],
      fieldsToCollect: [
        { name: 'userIntent', description: 'Reason for opening the account' },
        { name: 'userType', description: 'Identified handling principle (first account, young user, bad experience, etc.)' },
        { name: 'employment', description: 'Employment status and specific role when mentioned (e.g. "part-time waitress + student", not just "part-time")' },
        { name: 'incomeRange', description: 'Monthly income in NIS — number or range (e.g. 4000, 4000-5000). Not qualitative.' },
        { name: 'expensesRange', description: 'Monthly expenses in NIS — number or range (e.g. 3000, 3000-4000). Not qualitative.' },
        { name: 'mainExpenseTypes', description: 'Main expense types' },
        { name: 'financialCommitments', description: 'Existing financial commitments (high level)' },
        { name: 'expectedAccountUsage', description: 'Expected account usage' },
        { name: 'customerType', description: 'Overall read of the customer' },
        { name: 'signals', description: 'Mood, hesitation, urgency, confidence' },
      ],
      transitionTo: 'advisor-b',
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
   * Adds customer profile from welcome crew.
   */
  async buildThinkerContext(params) {
    const profile = await this.getContext('onboarding_profile', true) || {};
    const prevState = await this.getContext('advisor_a_state', true) || {};

    return `## Customer
Name: ${profile.name || 'Unknown'}
Age: ${profile.age || 'Unknown'}
Gender: ${profile.gender || 'Unknown'}

## Previous State
${JSON.stringify(prevState, null, 2)}`;
  }

  /**
   * Inject domain context for the talker.
   */
  async getAdditionalContext(params) {
    const profile = await this.getContext('onboarding_profile', true) || {};
    return {
      role: 'Account Advisor — Profiling',
      customerName: profile.name || null,
      customerGender: profile.gender || null,
      customerAge: profile.age || null
    };
  }

  /**
   * Check if thinker decided we're ready to transition to advisor-b.
   */
  async postThinkingTransfer(context) {
    const advice = context.thinkingAdvice;
    if (!advice?.readyToTransfer) return false;

    // Persist the profile for advisor-b to read
    await this.mergeContext('onboarding_profile', {
      currentStep: 'advisor-b',
      handlingPrinciple: advice.handlingPrinciple || null,
      earlyAnchor: advice.earlyAnchor || null,
      employment: advice.profile?.employment || context.collectedFields?.employment || null,
      incomeRange: advice.profile?.incomeRange || context.collectedFields?.incomeRange || null,
      expenseRange: advice.profile?.expenseRange || context.collectedFields?.expensesRange || null,
      creditUsage: advice.profile?.creditUsage || null,
      mainExpenseTypes: advice.profile?.mainExpenseTypes || context.collectedFields?.mainExpenseTypes || null,
      financialCommitments: advice.profile?.financialCommitments || context.collectedFields?.financialCommitments || null,
      relevantContext: advice.profile?.relevantContext || null,
    }, true);

    console.log('   ✅ Advisor-A: readyToTransfer, transitioning to advisor-b');
    return true;
  }
}

module.exports = AdvisorACrew;
