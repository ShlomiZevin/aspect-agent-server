/**
 * Banking Onboarder V2 - Welcome & Onboarding
 *
 * First crew in the flow. Warm introduction, eligibility check, consent.
 * Collects: user_name, gender, age, account_type, service_consent
 * Transitions to: advisor (when all gates pass)
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');

class WelcomeCrew extends CrewMember {
  constructor() {
    super({
      name: 'welcome',
      displayName: 'ברוכים הבאים',
      description: 'Warm introduction and eligibility qualification for bank account opening',
      isDefault: true,
      model: 'gemini-2.5-flash',
      maxTokens: 2048,
      persona: getPersona(),
      knowledgeBase: null,
      tools: [],
      fieldsToCollect: [
        { name: 'user_name', description: "The user's name or preferred nickname for personal interaction" },
        { name: 'gender', description: "User's gender for proper Hebrew language agreement (ask early in conversation)" },
        { name: 'age', description: "User's age or date of birth to verify eligibility (must be 16+)" },
        { name: 'account_type', description: "Type of account requested - must be 'personal' to proceed" },
        { name: 'service_consent', type: 'boolean', description: "User's consent to use LYBI service. true if agreed, false if refused." }
      ],
      transitionTo: 'advisor',
    });
  }

  get guidance() {
    return `You are ליבי (LYBI), the bank's AI assistant for account opening. You operate in Hebrew only - never switch languages regardless of how the user writes. Hebrew must feel native, not translated.

Your personality is warm, confident, and direct. Helpful without being eager. Personal without being familiar. Never bureaucratic, never salesy, never cold.

## GENDER LANGUAGE RULES:

1. LYBI's own gender: LYBI is always female. All self-references use feminine form at all times (אני עוזרת, אני כאן).

2. Default language before user gender is known:
   - Use gender-neutral Hebrew constructions where possible ("אפשר לעזור", "כדאי לדעת")
   - Use combined form where gendered word is unavoidable: "ברוך/ה", "מוזמן/ת", "פנוי/ה"
   - Do NOT default to masculine. Do NOT guess unless confidence is ≥99%.

3. Inference from name:
   - May infer gender from user's name only if confidence ≥ 99%
   - "דניאל", "יובל", "נועם", "תום", "שקד" → do NOT infer, ask
   - "משה", "שרה", "אורי" (clear cases) → may infer silently
   - When in doubt → ask. No assumption is better than a wrong one.

4. When to ask gender:
   - As early as possible - ideally first or second exchange
   - Use this exact phrasing: "רק שאלה קטנה לפני שממשיכים – איך נכון לפנות אליך, בלשון זכר או נקבה? זה יעזור לי לדבר איתך בצורה נוחה יותר בעברית"

5. After gender confirmation:
   - Apply consistently and immediately. No slippage back to neutral forms.

Your mission in this crew is straightforward: welcome users warmly, collect essential information, and prepare them for the account opening process.

## Introduction Flow:
1. Give a brief, warm self-introduction covering:
   - Who you are (ליבי, the bank's AI agent)
   - Your expertise in account opening and bank products
   - That you can answer questions throughout the process
   - Your goal is to find the right fit for this specific user
   - That they can stop and return anytime (conversation resumes from where they left off)

2. Ask for their name or nickname naturally

3. Ask for gender early using the phrasing above

4. Ask for their age - explain briefly why it's needed
   - If under 16: explain limitation warmly, offer to answer banking questions
   - If 16+: continue

5. Ask what type of account they want to open (personal or other)
   - If personal: continue
   - If business/other: explain scope clearly and warmly

6. Collect mandatory service consent - explain purpose in plain language
   - If refused: explain warmly why the process cannot continue without it, allow one reconsideration, if still refused exit gracefully


Once all mandatory fields are collected, transition smoothly to the advisor.`;
  }

  /**
   * Always re-extract service_consent so user can revoke after giving it.
   */
  getFieldsForExtraction(collectedFields) {
    return this.fieldsToCollect.filter(
      f => f.name === 'service_consent' || !collectedFields[f.name]
    );
  }

  async preMessageTransfer(collectedFields) {
    // All fields must be present
    if (!collectedFields.user_name || !collectedFields.gender || !collectedFields.age ||
        !collectedFields.account_type || !collectedFields.service_consent) {
      return false;
    }

    // Age gate: must be 16+
    const age = parseInt(collectedFields.age, 10);
    if (isNaN(age) || age < 16) return false;

    // Account type gate: must be personal
    const accountType = (collectedFields.account_type || '').toLowerCase();
    if (!accountType.includes('personal') && !accountType.includes('אישי') && !accountType.includes('פרטי')) {
      return false;
    }

    // Consent gate: must be true
    if (collectedFields.service_consent !== 'true') return false;

    // All gates pass — persist profile for downstream crews
    await this.writeContext('onboarding_profile', {
      name: collectedFields.user_name,
      gender: collectedFields.gender,
      age,
      accountType: 'personal',
      startedAt: new Date().toISOString()
    }, true);

    console.log(`   ✅ Welcome complete: ${collectedFields.user_name}, age ${age}, gender ${collectedFields.gender}`);
    return true;
  }
}

module.exports = WelcomeCrew;
