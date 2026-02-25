/**
 * Banking Onboarder - Entry & Introduction Crew Member
 *
 * Section 1: כניסה והיכרות - Entry, Introduction & Eligibility
 *
 * The entry-point crew member for the banking onboarding process.
 * Welcomes the customer, explains the service, and validates basic eligibility (age ≥ 16).
 *
 * Transitions:
 * - If age ≥ 16 → 'account-type'
 * - If age < 16 → End journey with respectful explanation
 */
const CrewMember = require('../../../crew/base/CrewMember');

class EntryIntroductionCrew extends CrewMember {
  constructor() {
    super({
      name: 'entry-introduction',
      displayName: 'Welcome',
      description: 'Introduction and eligibility check',
      isDefault: true,

      fieldsToCollect: [
        {
          name: 'user_name',
          description: "The user's name or preferred name"
        },
        {
          name: 'age',
          description: "The user's age as a number (extract from statements like 'I am 25', 'I'm 30 years old', etc.). If they provide date of birth, calculate age and extract the age number."
        }
      ],

      transitionTo: 'account-type',

      guidance: `You are a warm, professional banking assistant helping customers open a new bank account.

## YOUR PURPOSE
Welcome the customer and explain what will happen in this onboarding journey. Validate that they meet the basic eligibility requirement (age ≥ 16).

## WHAT TO COMMUNICATE
This is a digital onboarding service that will:
1. Help them understand what account type they can open
2. Collect necessary information securely
3. Verify their identity
4. Set up their new bank account

The process is:
- **Safe and secure** - all information is confidential
- **User-friendly** - they can take breaks and continue later
- **Transparent** - no hidden commitments until final confirmation
- **Guided** - you'll be with them every step

## ELIGIBILITY CHECK
To open an account through this digital service, customers must be **at least 16 years old**. This is a regulatory requirement.

## CONVERSATION FLOW
1. **Greet warmly and sell the experience** - Open with an inviting message that also helps someone still considering. Example:
   "שלום! אני כאן כדי ללוות אותך בפתיחת חשבון בנק חדש. אני אסביר על המסלולים, המוצרים והיתרונות, ונוודא שתצא/י מפה עם החשבון שהכי טוב עבורך. בואו נתחיל – איך קוראים לך?"
2. **Collect age** - After getting name, ask for their age to verify eligibility
3. **Handle outcome:**
   - If age ≥ 16: Confirm eligibility, briefly acknowledge next step
   - If age < 16: Explain limitation respectfully, end journey politely

## RULES
- **Gender-neutral self-reference** - Never expose your gender. No slash forms (מבין/ה). Use neutral phrasing like "אני מבין את זה".
- Keep language **simple and confidence-building**
- Use a **conversational, not formal** tone
- **Don't** use banking jargon or legal language
- **Don't** ask for data collection without explaining why
- **Don't** make it feel like a form - make it feel like a helpful conversation
- Normalize hesitation: "You can pause and continue later anytime"
- **Zero pressure** - this is exploration, not commitment
- Keep responses **short** (2-3 sentences maximum)
- If they seem uncertain, reassure them about the process

## AGE VALIDATION LOGIC
- **Age ≥ 16:** "Great! You're eligible to proceed. Let me guide you through the next steps."
- **Age < 16:** "I appreciate your interest! Unfortunately, to open an account through this digital service, you need to be at least 16 years old. This service will be available to you when you reach that age. Is there anything else I can help you understand about our banking services?"

## KEY PRINCIPLES
- **Value before action** - Explain what they'll get before asking for information
- **Transparency** - Be clear about why age is required
- **Respectful** - Treat age requirement as practical, not rejecting
- **No sales pressure** - This is guidance, not selling`,

      model: 'gpt-4o',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // Only transition if we have name AND age AND age is valid (≥ 16)
    if (!collectedFields.user_name || !collectedFields.age) {
      return false;
    }

    const age = parseInt(collectedFields.age, 10);

    // If age is invalid or < 16, don't transition (let conversation end naturally)
    if (isNaN(age) || age < 16) {
      return false;
    }

    // Save user profile to context (conversation-level for fresh starts)
    await this.writeContext('onboarding_profile', {
      name: collectedFields.user_name,
      age: age,
      eligibleForOnboarding: true,
      startedAt: new Date().toISOString(),
      currentStep: 'account-type'
    }, true);

    console.log(`   💾 Saved onboarding profile for user: ${collectedFields.user_name}`);

    // Age is valid (≥ 16), proceed to next step
    return true;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    // Check for existing onboarding profile (returning user)
    const existingProfile = await this.getContext('onboarding_profile');

    const hasName = !!collectedFields.user_name;
    const hasAge = !!collectedFields.age;
    const age = hasAge ? parseInt(collectedFields.age, 10) : null;
    const isEligible = age !== null && !isNaN(age) && age >= 16;
    const isTooYoung = age !== null && !isNaN(age) && age < 16;

    // Determine if this is a returning user
    const isReturningUser = !!existingProfile?.name;

    return {
      ...baseContext,
      role: 'Welcome & Eligibility Check',
      stage: 'Entry & Introduction',
      isReturningUser: isReturningUser,
      existingProfile: existingProfile,
      collectedData: {
        name: collectedFields.user_name || 'Not collected',
        age: collectedFields.age || 'Not collected',
        eligibilityStatus: isTooYoung
          ? 'Not eligible (under 16)'
          : isEligible
          ? 'Eligible (16+)'
          : 'Pending verification'
      },
      nextSteps: hasName && hasAge
        ? isEligible
          ? 'Customer is eligible. System will transition to Account Type selection.'
          : isTooYoung
          ? 'Customer is under 16. Explain limitation respectfully and end journey.'
          : 'Age validation pending.'
        : 'Still collecting basic information (name and age).',
      instruction: isReturningUser && !hasName
        ? `This is a returning user (${existingProfile.name}). Greet them warmly: "Welcome back, ${existingProfile.name}! Ready to continue your account setup?"`
        : !hasName
        ? 'Greet warmly with an inviting opening. Explain you can help with routes, products, advantages, and personalized matching. End by asking their name. Make someone still considering feel this is the right place for them.'
        : !hasAge
        ? 'Now ask for their age to verify eligibility (must be 16+).'
        : isTooYoung
        ? 'Customer is under 16. Explain the age requirement respectfully. Offer future availability. Do NOT continue the onboarding process.'
        : isEligible
        ? 'Customer is eligible! Acknowledge and prepare for transition to next step.'
        : 'Verify age is a valid number.',
      note: 'Keep responses friendly and short (2-3 sentences max). Make the customer feel welcome and safe.'
    };
  }
}

module.exports = EntryIntroductionCrew;
