/**
 * Banking Onboarder - Profile Data Enrichment Crew Member
 *
 * Section 6: איסוף מידע וניתוח פרופיל - Profile Data Enrichment
 *
 * Collects financial profile one question at a time.
 * Sequential field exposure via getFieldsForExtraction.
 * Conditional: skips occupation for students/retirees/unemployed.
 *
 * Transitions:
 * - When required profile fields are collected → 'offers-terms'
 */
const CrewMember = require('../../../crew/base/CrewMember');

// Statuses that don't need an occupation question
const SKIP_OCCUPATION_STATUSES = new Set([
  'סטודנט', 'פנסיונר', 'לא עובד',
  'student', 'retired', 'unemployed'
]);

class ProfileEnrichmentCrew extends CrewMember {
  constructor() {
    super({
      name: 'profile-enrichment',
      displayName: 'Financial Profile',
      description: 'Financial profile collection and enrichment',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'employment_status', description: "סטטוס תעסוקה: 'שכיר', 'עצמאי', 'סטודנט', 'פנסיונר', 'לא עובד'" },
        { name: 'occupation', description: "תפקיד או תחום עיסוק כללי" },
        { name: 'primary_income_source', description: "מקור הכנסה עיקרי" },
        { name: 'monthly_income_range', description: "Monthly income range. Map the user's answer to the closest bracket: 'עד 5,000', '5,000-10,000', '10,000-20,000', '20,000+'" },
        { name: 'expected_account_usage', description: "שימוש מתוכנן בחשבון: 'הוצאות יומיומיות', 'הפקדת משכורת', 'חיסכון', 'תשלומי חשבונות', 'שילוב'" },
        { name: 'existing_financial_commitments', description: "התחייבויות כספיות (הלוואות, משכנתא). 'אין' אם אין" }
      ],

      transitionTo: 'offers-terms',

      guidance: `You are a professional banking assistant collecting financial information to tailor the account.

## RULES
- **One question at a time** - ask a single question, wait for answer, then continue
- **Conversational** - this is a chat, not a form. Keep it natural
- **Offer choices** - when asking about ranges or usage, present predefined options to choose from rather than open-ended questions
- **Ranges are fine** - never ask for exact numbers
- **No judgment** - all financial situations are valid
- **Gender-neutral** - never expose your gender. No slash forms. Use neutral phrasing
- **Short** - 1-2 sentences per message. Acknowledge briefly before next question
- **Hebrew** - communicate in Hebrew
- **Skip irrelevant questions** - adapt based on previous answers

## FLOW
1. Brief intro explaining you need a few short questions about employment and income
2. Employment status
3. Occupation (only if relevant)
4. Income source
5. Monthly income range - offer predefined ranges
6. Expected account usage - offer common options
7. Existing financial commitments - frame why it's relevant (helps tailor the account), keep it light and optional`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2000,
      tools: [],
      knowledgeBase: null
    });
  }

  getFieldsForExtraction(collectedFields) {
    const status = collectedFields.employment_status;

    if (!status) {
      return this.fieldsToCollect.filter(f => f.name === 'employment_status');
    }
    if (!SKIP_OCCUPATION_STATUSES.has(status.trim().toLowerCase()) && !collectedFields.occupation) {
      return this.fieldsToCollect.filter(f => f.name === 'occupation');
    }
    if (!collectedFields.primary_income_source) {
      return this.fieldsToCollect.filter(f => f.name === 'primary_income_source');
    }
    if (!collectedFields.monthly_income_range) {
      return this.fieldsToCollect.filter(f => f.name === 'monthly_income_range');
    }
    if (!collectedFields.expected_account_usage) {
      return this.fieldsToCollect.filter(f => f.name === 'expected_account_usage');
    }
    return this.fieldsToCollect.filter(f => f.name === 'existing_financial_commitments');
  }

  async preMessageTransfer(collectedFields) {
    const required = ['employment_status', 'primary_income_source', 'monthly_income_range', 'expected_account_usage'];
    return required.every(f => !!collectedFields[f]);
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const required = ['employment_status', 'primary_income_source', 'monthly_income_range', 'expected_account_usage'];
    const missing = required.filter(f => !collectedFields[f]);

    return {
      ...baseContext,
      role: 'Financial Profile Collection',
      customerName: collectedFields.user_name || null,
      profileFields: {
        employment_status: collectedFields.employment_status || null,
        occupation: collectedFields.occupation || null,
        primary_income_source: collectedFields.primary_income_source || null,
        monthly_income_range: collectedFields.monthly_income_range || null,
        expected_account_usage: collectedFields.expected_account_usage || null,
        existing_financial_commitments: collectedFields.existing_financial_commitments || null
      },
      missingRequired: missing,
      isComplete: missing.length === 0
    };
  }
}

module.exports = ProfileEnrichmentCrew;
