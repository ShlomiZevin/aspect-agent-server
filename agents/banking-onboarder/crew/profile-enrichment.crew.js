/**
 * Banking Onboarder - Profile Data Enrichment Crew Member
 *
 * Section 6: איסוף מידע וניתוח פרופיל - Profile Data Enrichment
 *
 * Builds a comprehensive financial profile by collecting employment, income,
 * and financial behavior information. Uses external data when available,
 * minimizes user questioning, allows partial completion.
 *
 * Transitions:
 * - When minimum required profile is complete → 'offers-terms'
 */
const CrewMember = require('../../../crew/base/CrewMember');

class ProfileEnrichmentCrew extends CrewMember {
  constructor() {
    super({
      name: 'profile-enrichment',
      displayName: 'Financial Profile',
      description: 'Financial profile collection and enrichment',
      isDefault: false,

      fieldsToCollect: [
        // Employment Information
        { name: 'employment_status', description: "Employment status: 'employed', 'self-employed', 'unemployed', 'student', 'retired'" },
        { name: 'occupation', description: "Occupation or role (high-level, e.g., 'teacher', 'engineer', 'business owner')" },
        { name: 'industry', description: "Industry sector (optional, e.g., 'technology', 'healthcare', 'retail')" },
        { name: 'employment_stability', description: "'permanent', 'temporary', 'contract', 'freelance'" },

        // Income Information
        { name: 'primary_income_source', description: "Primary income source type: 'salary', 'business income', 'investments', 'benefits', 'other'" },
        { name: 'monthly_income_range', description: "Monthly income range, not exact number (e.g., 'under 2000', '2000-5000', '5000-10000', '10000+')" },
        { name: 'income_frequency', description: "'monthly', 'bi-weekly', 'weekly', 'irregular'" },
        { name: 'additional_income_sources', description: "Number or description of additional income sources (extract 'none' if only one source)" },

        // Financial Behavior (can be from external data OR user input)
        { name: 'expected_account_usage', description: "How they plan to use the account: 'daily transactions', 'salary deposit', 'savings', 'bill payments', 'mixed'" },
        { name: 'average_monthly_spending', description: "Estimated monthly spending range (e.g., 'under 1000', '1000-3000', '3000-5000', '5000+')" },
        { name: 'existing_financial_commitments', description: "Loans, mortgages, or major financial commitments (high-level, extract 'none' if none)" },

        // Special Indicators
        { name: 'is_student', description: "Set to 'yes' if user is a student, 'no' otherwise" },
        { name: 'is_first_bank_account', description: "Set to 'yes' if this is their first bank account, 'no' if they have had accounts before, 'unknown' if not mentioned" },

        // External Data Availability (simulated)
        { name: 'external_data_available', description: "Set to 'yes' if simulating that external financial data is available (open banking, credit bureau), 'no' if must ask user directly" }
      ],

      transitionTo: 'offers-terms',

      guidance: `You are a professional banking assistant helping customers build their financial profile for account setup.

## YOUR PURPOSE
Collect sufficient financial information to:
- Understand customer's financial situation
- Tailor account features and recommendations
- Assess appropriate account limits and services

## KEY PRINCIPLE: MINIMIZE USER EFFORT
- **Prefer external data** when available (open banking, credit reports)
- **Don't over-question** - especially young or early-career customers
- **Allow ranges** instead of exact numbers
- **Accept partial information** when full details aren't available
- **Group related questions** - ask 2-3 at a time

## CONVERSATION FLOW

### Introduction
"Great! Now let's build your financial profile so we can tailor your account to your needs. I'll ask a few questions about your employment and finances.

Note: If you have connected open banking data or credit information, I can fill in some of this automatically. Otherwise, I'll ask you directly - and you can provide ranges rather than exact figures for privacy."

### IF EXTERNAL DATA AVAILABLE (Simulated)
"I see we have some financial data available from your previous accounts. Let me use that to fill in your profile...

[Simulate brief processing]

Based on available data, I have:
- Employment: [status]
- Income range: [range]
- Typical account activity: [usage pattern]

Does this look accurate, or would you like to update anything?"

### IF NO EXTERNAL DATA - Ask User Directly

**Employment Block:**
"Let's start with employment:
1. What's your current employment status? (employed, self-employed, student, retired, etc.)
2. What's your occupation or role?
3. Is this permanent or temporary work?"

**Income Block:**
"Now about income - just provide ranges, no exact figures needed:
1. What's your primary source of income? (salary, business, investments, etc.)
2. What's your approximate monthly income range? (e.g., under $2000, $2000-$5000, etc.)
3. Do you have any additional income sources?"

**Financial Behavior Block:**
"Finally, how do you plan to use this account?
1. Main purpose? (daily transactions, salary deposit, savings, bill payments, etc.)
2. Approximate monthly spending range?
3. Any existing loans or major financial commitments? (just yes/no or high-level)"

## HANDLING DIFFERENT USER TYPES

### Young / Student / First-Time Customers
- Don't push for precision they don't have
- Accept "I don't know" or "Not much" as valid answers
- Focus on intended use rather than history
- Frame as "expected" rather than "current"

### Established Customers
- They'll have more details - collect efficiently
- Respect privacy - ranges are fine
- Don't make them repeat what external data already shows

## RULES
- **Group logically** - employment together, income together, etc.
- **2-3 questions at a time** maximum
- **Acknowledge answers** as they come in
- **Don't interrogate** - keep tone conversational
- **Ranges over precision** - "around 3000" is fine
- **Partial is OK** - some missing data is acceptable
- **No judgment** - all financial situations are valid
- Keep responses **short** (2-3 sentences between question blocks)

## MINIMUM REQUIRED PROFILE
To proceed, we need AT LEAST:
- Employment status
- Primary income source
- Monthly income range (can be broad)
- Expected account usage

Optional but helpful:
- Occupation
- Additional income sources
- Financial commitments
- Student/first-account indicators

## KEY PHRASES
✅ "Just approximate ranges are fine"
✅ "This helps us tailor your account features"
✅ "No need for exact numbers"
✅ "We can skip anything you're unsure about"

❌ Avoid: "We need exact income" (too demanding)
❌ Avoid: "This is required" (sounds pushy)
❌ Avoid: Over-explaining data usage (creates suspicion)`,

      model: 'gpt-4o',
      maxTokens: 2000,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // Minimum required fields to proceed
    const requiredFields = [
      'employment_status',
      'primary_income_source',
      'monthly_income_range',
      'expected_account_usage'
    ];

    const hasAllRequired = requiredFields.every(f => !!collectedFields[f]);

    // Also want at least 2 optional fields for a decent profile
    const optionalFields = [
      'occupation',
      'industry',
      'employment_stability',
      'income_frequency',
      'additional_income_sources',
      'average_monthly_spending',
      'existing_financial_commitments',
      'is_student',
      'is_first_bank_account'
    ];

    const optionalCollected = optionalFields.filter(f => !!collectedFields[f]).length;

    return hasAllRequired && optionalCollected >= 2;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const required = ['employment_status', 'primary_income_source', 'monthly_income_range', 'expected_account_usage'];
    const optional = ['occupation', 'industry', 'employment_stability', 'income_frequency', 'additional_income_sources',
                      'average_monthly_spending', 'existing_financial_commitments', 'is_student', 'is_first_bank_account'];

    const requiredCollected = required.filter(f => !!collectedFields[f]);
    const optionalCollected = optional.filter(f => !!collectedFields[f]);
    const requiredMissing = required.filter(f => !collectedFields[f]);
    const hasMinimumProfile = requiredCollected.length === required.length && optionalCollected.length >= 2;

    const externalDataAvailable = collectedFields.external_data_available === 'yes';
    const userName = collectedFields.user_name || null;

    return {
      ...baseContext,
      role: 'Financial Profile Collection',
      stage: 'Profile Data Enrichment',
      customerName: userName,
      dataSource: externalDataAvailable ? 'External data + User input' : 'User input only',
      profileCompleteness: {
        required: `${requiredCollected.length}/${required.length}`,
        optional: `${optionalCollected.length}/${optional.length}`,
        total: `${requiredCollected.length + optionalCollected.length}/${required.length + optional.length}`
      },
      collectedFields: {
        employment: {
          status: collectedFields.employment_status || 'missing',
          occupation: collectedFields.occupation || 'missing',
          stability: collectedFields.employment_stability || 'missing'
        },
        income: {
          source: collectedFields.primary_income_source || 'missing',
          range: collectedFields.monthly_income_range || 'missing',
          frequency: collectedFields.income_frequency || 'missing'
        },
        usage: {
          expected: collectedFields.expected_account_usage || 'missing',
          spending: collectedFields.average_monthly_spending || 'missing'
        }
      },
      missingRequired: requiredMissing,
      nextSteps: hasMinimumProfile
        ? 'Minimum profile complete! System will transition to Offers & Terms.'
        : requiredMissing.length > 0
        ? `Still need: ${requiredMissing.join(', ')}`
        : 'Need at least 2 more optional fields for decent profile.',
      instruction: externalDataAvailable && requiredCollected.length === 0
        ? 'Simulate using external data to pre-fill profile. Present to user for confirmation.'
        : requiredMissing.length > 0
        ? `Ask for missing required fields: ${requiredMissing.slice(0, 3).join(', ')}. Group logically (2-3 questions together).`
        : optionalCollected.length < 2
        ? 'Required fields done! Ask 1-2 more optional questions to round out profile.'
        : 'Profile is sufficient. Summarize and prepare for transition.',
      note: 'Young/student/first-time customers may not have detailed history - that\'s OK. Focus on expectations rather than history. Ranges are fine, precision not needed.'
    };
  }
}

module.exports = ProfileEnrichmentCrew;
