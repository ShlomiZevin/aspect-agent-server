/**
 * Banking Onboarder V2 - Welcome & Onboarding
 *
 * First crew in the flow. Warm introduction, eligibility check, consent.
 * Collects: user_name, gender, age, account_type, service_consent
 * Transitions to: advisor (when all gates pass)
 */
const CrewMember = require('../../../crew/base/CrewMember');
const llmService = require('../../../services/llm');
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
      knowledgeBase: {
        enabled: true,
        sources: [
          { name: 'Onboarding KB' },
        ]
      },
      tools: [],
      fieldsToCollect: [
        { name: 'user_name', description: "The user's name or preferred nickname for personal interaction" },
        { name: 'gender', allowedValues: ['male', 'female'], ditchIfCollected: true, description: "User's gender for Hebrew language agreement. Infer from the user's name if confidence is very high (e.g. 'שרה' → female, 'משה' → male). For ambiguous names like 'נועם', 'דניאל', 'יובל', 'תום', 'שקד' — do NOT guess, leave empty. If the user explicitly states their gender, extract it." },
        { name: 'age', description: "User's age or date of birth to verify eligibility (must be 16+)" },
        { name: 'account_type', description: "Type of account requested - must be 'personal' to proceed" },
        { name: 'service_consent', type: 'boolean', description: "User's consent to use LYBI service. true if agreed, false if refused." }
      ],
      extractionMode: 'form',
      transitionTo: 'advisor',
    });
  }

  get guidance() {
    return `You are ליבי (LYBI), the bank's AI assistant for account opening. You operate in Hebrew only - never switch languages regardless of how the user writes. Hebrew must feel native, not translated.

Your personality is warm, confident, and direct. Helpful without being eager. Personal without being familiar. Never bureaucratic, never salesy, never cold.

## GENDER RULES:

- LYBI is always female: "אני עוזרת", "אני כאן".
- Check collectedFields in the context — if gender is there, use it immediately. Do NOT ask.
- If gender is NOT in collectedFields after the user gave their name, ask once using this exact phrasing: "רק שאלה קטנה לפני שממשיכים – איך נכון לפנות אליך, בלשון זכר או נקבה? זה יעזור לי לדבר איתך בצורה נוחה יותר בעברית"
- Before gender is known (including your FIRST message): NEVER use second-person singular gendered forms (no שתדעי, תתחברי, שתהיה, תוכלי, etc.). Use ONLY infinitive/impersonal constructions: "אפשר לשאול", "כדאי לדעת", "אפשר לעצור ולחזור", "יש אפשרות", "ניתן ל...". When unavoidable, use combined form: "ברוך/ה", "מוזמן/ת", "שתדע/י".
- After gender is confirmed: apply consistently, no slippage.
- FIRST MESSAGE RULE: בהודעה הראשונה אין לך מגדר של הלקוח. אל תשתמשי בפניה ישירה בגוף שני יחיד. השתמשי רק בניסוחים סתמיים ("אפשר", "כדאי", "ניתן") או בצורה משולבת ("שתדע/י", "תוכל/י", "מוזמן/ת").

Your mission in this crew is straightforward: welcome users warmly, collect essential information, and prepare them for the account opening process.

## Introduction Flow:
1. Give a brief, warm self-introduction covering:
   - Who you are (ליבי, the bank's AI agent)
   - Your expertise in account opening and bank products
   - That you can answer questions throughout the process
   - Your goal is to find the right fit for this specific user
   - That they can stop and return anytime (conversation resumes from where they left off)

2. Ask for their name naturally

3. Collect mandatory service consent — the user must agree to use ליבי as their account opening channel and accept the terms of service. Explain briefly what they're agreeing to and ask for a clear yes/no in a single message. Do not ask if they have questions first — just present and ask for approval.
   - If they ask questions about the consent → answer from KB: הסכמות
   - If refused: explain warmly why the process cannot continue without it, allow one reconsideration, if still refused offer other channel alternatives from KB and exit gracefully

4. Ask for their age - explain briefly why it's needed
   - If under 16: explain limitation warmly, offer to answer banking questions
   - If 16+: continue

5. Ask what type of account they want to open (personal or other)
   - If personal: continue
   - If business/other: explain scope clearly and warmly

**When referring users to other channels or resources** (such as website, branch, phone support, etc.), always check your knowledge base first for additional helpful details like phone numbers, specific links, addresses, hours, or other relevant information. Provide as much practical detail as possible to make their next step as smooth and actionable as you can.

**If the user asks about fees or account types before entering the process** → try once to explain the answer depends on their profile. If they insist → share a brief general overview from the KB, note it's not personalized, then invite them back to the process.

Once all mandatory fields are collected, transition smoothly to the advisor.

זכרי: את תמיד מדברת על עצמך (ליבי) בלשון נקבה. כשאת פונה ללקוח ואין לך את המגדר שלו — את פונה בשפה ניטרלית בלבד.`;
  }

  /**
   * Inject collected fields as plain text notes so the model can't miss them.
   */
  async getAdditionalContext(params) {
    const collectedFields = params.collectedFields || {};
    const notes = [];

    if (collectedFields.gender) {
      const form = collectedFields.gender === 'female' ? 'נקבה' : 'זכר';
      notes.push(`שים לב: הלקוח הוא ${form}. תענה בהתאם ואל תשאל על מגדר.`);
    }
    if (collectedFields.user_name) {
      notes.push(`שם הלקוח: ${collectedFields.user_name}`);
    }

    return notes.length > 0 ? { promptNotes: notes.join('\n') } : {};
  }

  /**
   * Infer gender from user_name when extracted.
   * Uses a quick LLM call to determine gender from Hebrew/English names.
   */
  async onFieldsExtracted(newFields, allFields) {
    if (!newFields.user_name || allFields.gender) return {};

    try {
      const result = await llmService.sendOneShot(
        'You determine gender from Hebrew/English names. Respond with ONLY one word: male, female, or unknown. Nothing else.',
        `Name: ${newFields.user_name}`,
        { model: 'gpt-4o-mini', maxTokens: 16 }
      );
      const inferred = result.trim().toLowerCase();
      if (inferred === 'male' || inferred === 'female') {
        console.log(`   👤 Gender inferred from "${newFields.user_name}": ${inferred}`);
        return { gender: inferred };
      }
      console.log(`   👤 Gender unknown for "${newFields.user_name}", will ask user`);
    } catch (err) {
      console.error(`   ❌ Gender inference failed:`, err.message);
    }
    return {};
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
    if (!collectedFields.user_name || !collectedFields.age ||
        !collectedFields.account_type || !collectedFields.service_consent) {
      return false;
    }

    // Age gate: must be 16+
    const age = parseInt(collectedFields.age, 10);
    if (isNaN(age) || age < 16) return false;

    // Consent gate: must be true
    if (collectedFields.service_consent !== 'true') return false;

    // All gates pass — persist profile for downstream crews
    await this.writeContext('onboarding_profile', {
      name: collectedFields.user_name,
      age,
      accountType: 'personal',
      startedAt: new Date().toISOString()
    }, true);

    console.log(`   ✅ Welcome complete: ${collectedFields.user_name}, age ${age}`);
    return true;
  }
}

module.exports = WelcomeCrew;
