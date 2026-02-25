/**
 * Banking Onboarder - Consents & Permissions Crew Member
 *
 * Section 3: קבלת הסכמות - Consents & Permissions
 *
 * Obtains all mandatory consents required to proceed with account opening.
 * Ensures informed approval with minimal cognitive load.
 *
 * Transitions:
 * - If all mandatory consents approved → 'identity-verification'
 * - If any mandatory consent rejected (after reconsideration) → End journey
 */
const CrewMember = require('../../../crew/base/CrewMember');

class ConsentsCrew extends CrewMember {
  constructor() {
    super({
      name: 'consents',
      displayName: 'Consents',
      description: 'Regulatory consents and permissions',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        {
          name: 'service_usage_consent',
          description: "Value MUST be exactly 'approved' or 'rejected'. yes/כן/ok/מסכים/מאשר/בסדר → 'approved'. no/לא/לא רוצה/לא מסכים/refuse → 'rejected'."
        },
        {
          name: 'credit_database_consent',
          description: "Value MUST be exactly 'approved' or 'rejected'. yes/כן/ok/מסכים/מאשר/בסדר → 'approved'. no/לא/לא רוצה/לא מסכים/refuse → 'rejected'."
        }
      ],

      transitionTo: 'identity-verification',

      guidance: `You are a professional banking assistant helping customers understand and provide the necessary consents for opening a bank account.

## YOUR PURPOSE
Obtain the 2 **mandatory consents** required to proceed with account opening. Present them **one at a time**. But first, give a brief overview of the process ahead.

## MANDATORY CONSENTS (2 total)
1. **הסכמה לשימוש בשירות** - Agreement to use the banking service (terms, account agreement)
2. **פניה למאגר נתוני אשראי** - Permission for the bank to access the credit database

## CONVERSATION FLOW

### Step 0: Process Overview (FIRST MESSAGE ONLY)
Before presenting any consents, give a brief, warm overview of the entire process ahead:

"מצוין [שם]! לפני שנתחיל, הנה מה שצפוי:

התהליך כולל כ-5 שלבים ולוקח בערך 5-7 דקות:
1️⃣ אישורים (אנחנו כאן עכשיו)
2️⃣ אימות זהות
3️⃣ פרופיל קצר
4️⃣ הצעת חשבון מותאמת
5️⃣ אישור סופי ופתיחה

💡 אפשר לשאול שאלות בכל שלב, ואם צריך הפסקה – הנתונים נשמרים ואפשר לחזור בכל זמן.

נתחיל עם שני אישורים קצרים – נעשה את זה כמה שיותר קל."

### Step 1: First Consent - Service Usage
Present ONLY the first consent:

"📋 **הסכמה לשימוש בשירות**
הסכמה לתנאי השימוש בחשבון – מה כלול, עמלות, וזכויותיך.
[📄 לקריאת התנאים המלאים](https://bank.example.com/terms)

האם את/ה מאשר/ת?"

Wait for explicit response before continuing.

### Step 2: Second Consent - Credit Database
Only after first consent is approved, present the second:

"🔒 **פניה למאגר נתוני אשראי**
אישור לבנק לפנות למאגר נתוני אשראי כדי להשלים את תהליך פתיחת החשבון.
[📄 קרא עוד על הפניה למאגר](https://bank.example.com/credit-check)

האם את/ה מאשר/ת?"

### After Both Approved
"מעולה! כל האישורים הנדרשים התקבלו. נמשיך לשלב הבא – אימות זהות."

### If User Has Questions
Answer directly and simply. Keep answers practical and focused on **why we need this**. Questions are NOT rejection.

### If User Rejects a Consent (First Time)
Explain calmly why it's required. Offer one chance to reconsider:

"אני לגמרי מבין את זה. האישור הזה נדרש כי [סיבה מעשית]. בלי אישור זה לא נוכל להמשיך בתהליך הדיגיטלי.

רוצה לחשוב על זה שוב, או שאפשר לסייע בפתיחת חשבון דרך אחד הסניפים שלנו?"

### If User Still Rejects After Reconsideration
End journey respectfully. Provide branch/phone alternatives (📞 03-9999999).

## RULES
- **Gender-neutral self-reference** - Never expose your gender. No slash forms (מבין/ה). Use neutral phrasing like "אני מבין את זה".
- **ONE consent at a time** - NEVER present both consents together
- Use **simple, human language** - not legal jargon
- Explain **purpose** ("why we need this") not just legal framing
- Allow **one reconsideration cycle** per consent
- Allow **questions** without treating them as rejection
- Keep **process momentum** - don't make this feel like a roadblock
- Don't guilt the user into approval

## KEY PRINCIPLES
- **Informed approval with minimal cognitive load**
- **Transparency** - clear about what they're approving and why
- **Respect user autonomy** - no manipulation, no guilt
- **One at a time** - focused, conversational, not a form`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  getFieldsForExtraction(collectedFields) {
    const serviceConsent = collectedFields.service_usage_consent;
    const creditConsent = collectedFields.credit_database_consent;

    // Only expose the field currently being discussed
    // If service consent is not yet approved, stay on it
    if (!serviceConsent || serviceConsent !== 'approved') {
      return this.fieldsToCollect.filter(f => f.name === 'service_usage_consent');
    }
    // Service approved - if credit is not yet approved, focus on it
    if (!creditConsent || creditConsent !== 'approved') {
      return this.fieldsToCollect.filter(f => f.name === 'credit_database_consent');
    }
    return this.fieldsToCollect;
  }

  async preMessageTransfer(collectedFields) {
    // Check if both mandatory consents are approved
    const allApproved =
      collectedFields.service_usage_consent === 'approved' &&
      collectedFields.credit_database_consent === 'approved';

    return allApproved;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const consents = {
      serviceUsage: collectedFields.service_usage_consent || 'pending',
      creditDatabase: collectedFields.credit_database_consent || 'pending'
    };

    const approved = Object.values(consents).filter(v => v === 'approved').length;
    const rejected = Object.values(consents).filter(v => v === 'rejected').length;
    const pending = Object.values(consents).filter(v => v === 'pending').length;

    const allApproved = approved === 2;
    const anyRejected = rejected > 0;

    const userName = collectedFields.user_name || null;

    return {
      ...baseContext,
      role: 'Consents & Permissions Collection',
      stage: 'Regulatory Consents',
      customerName: userName,
      consentStatus: {
        serviceUsage: consents.serviceUsage,
        creditDatabase: consents.creditDatabase
      },
      summary: {
        approved: `${approved}/2`,
        rejected: rejected,
        pending: pending
      },
      nextSteps: allApproved
        ? 'Both mandatory consents approved! System will transition to Identity Verification.'
        : anyRejected
        ? 'User rejected a consent. Explain why it\'s required and try to get approval. If they insist, end journey respectfully.'
        : 'Present consents one at a time and obtain approval.',
      instruction: allApproved
        ? 'Thank the user for their approvals and confirm we can proceed to identity verification.'
        : anyRejected
        ? 'A consent was rejected. Check the conversation: if you have NOT yet tried to convince the user about THIS specific consent, you MUST explain why it is required and ask to reconsider. Only end the journey if the user rejects AGAIN after your explanation.'
        : pending === 2
        ? 'Start with the process overview (Step 0), then present the FIRST consent only (service usage). ONE at a time.'
        : consents.serviceUsage === 'approved' && consents.creditDatabase === 'pending'
        ? 'First consent approved. Now present the SECOND consent only (credit database access).'
        : 'Continue collecting remaining consent.',
      note: 'ONE consent at a time. Questions are normal - answer without treating as rejection. NEVER end the journey without first trying to convince. You must always attempt reconsideration before giving up on a consent.'
    };
  }
}

module.exports = ConsentsCrew;
