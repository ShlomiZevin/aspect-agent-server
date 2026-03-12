/**
 * Banking Onboarder V2 - Welcome Crew
 *
 * First contact. Build trust, check eligibility, get consent.
 *
 * Fields: name, age, account_type_intent, consent
 * Gates: age >= 16, account type = private individual current account
 * Flow: greet → name → age → account type → (gates pass) → explain service + consent → transition
 *
 * Transitions:
 * - All fields + both gates + consent → 'main-conversation'
 * - Age < 16 / unsupported account type / consent declined → end gracefully
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-v2-persona');

class WelcomeCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'welcome',
      displayName: 'קבלת פנים',
      description: 'ברכת שלום, בדיקת זכאות והסכמה',
      isDefault: true,
      model: 'gpt-5-chat-latest',
      maxTokens: 1024,

      fieldsToCollect: [
        {
          name: 'user_name',
          description: "The customer's name or preferred name"
        },
        {
          name: 'age',
          description: "The customer's age as a number"
        },
        {
          name: 'account_type_intent',
          description: "What type of account the customer wants. Values: 'private_current' for private individual current account (חשבון עו\"ש פרטי / חשבון רגיל / חשבון פרטי), 'business' for business account, 'joint' for joint account, 'savings' for savings account, 'other' for anything else"
        },
        {
          name: 'consent',
          description: "Explicit consent to proceed with the AI banking service. Set to 'yes' only when the customer clearly agrees AFTER being informed about the service (כן, בואו נתחיל, מסכים/ה, אשמח, קדימה). Set to 'declined' if they refuse."
        }
      ],

      transitionTo: 'main-conversation',

      guidance: `Welcome the customer and check eligibility. This is a trust-building moment, not a data-collection moment.

## FLOW
1. Greet warmly. Introduce yourself as a digital banking assistant. Explain briefly: "I can help you find the right account, compare options, and open one — all here." Ask their name.
2. After name — ask age. Frame it as access: "כדי לוודא שאני יכול/ה לפתוח לך חשבון, מה הגיל שלך?"
3. After age — ask what type of account they're looking for. Keep it casual: "מה סוג החשבון שמעניין אותך?"
4. Check gates:
   - Age < 16 → explain warmly, offer a "come back later" hook, end gracefully
   - Unsupported account type (business/joint/savings) → acknowledge the bank offers it, explain this flow handles private current accounts, provide contact: "אפשר לפנות לסניף בטלפון 03-1234567 או באתר example.com/business", close warmly
5. Both gates pass → Present what you offer: you can compare account plans and explain the differences, find what fits their specific needs, walk them through every step, and they can ask anything along the way. This is a real conversation, not a form. Then ask if they'd like to get started.
6. Consent declined → explain consent is needed for the service to operate, offer once more. If declined again → close warmly, leave the door open.

## RULES
- Lead with warmth before any data collection
- Don't mention products or upsell
- Don't use regulatory or legal language
- Don't ask for consent before both gates are cleared
- Keep this stage short — every extra second is drop risk
- Normalize exploring: "בלי התחייבות, רק נבדוק ביחד"`,

      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    if (!collectedFields.user_name || !collectedFields.age) return false;

    const age = parseInt(collectedFields.age, 10);
    if (isNaN(age) || age < 16) return false;

    // Must be private individual current account
    const intent = (collectedFields.account_type_intent || '').toLowerCase();
    if (intent !== 'private_current') return false;

    // Must have explicit consent
    if (collectedFields.consent !== 'yes') return false;

    await this.writeContext('onboarding_profile', {
      name: collectedFields.user_name,
      age,
      accountType: 'private_current',
      startedAt: new Date().toISOString()
    }, true);

    console.log(`   ✅ Welcome complete: ${collectedFields.user_name}, age ${age}, consent given`);
    return true;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const cf = params.collectedFields || {};
    const age = cf.age ? parseInt(cf.age, 10) : null;

    return {
      ...baseContext,
      role: 'Welcome & Eligibility',
      customerName: cf.user_name || null,
      age,
      eligible: age !== null ? age >= 16 : null,
      accountTypeIntent: cf.account_type_intent || null,
      consentGiven: cf.consent === 'yes'
    };
  }
}

module.exports = WelcomeCrew;
