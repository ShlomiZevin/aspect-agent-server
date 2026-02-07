/**
 * Byline RDDA Prohibited & Restricted Merchants Crew
 *
 * Section 8 - Collects information about prohibited and restricted merchant types.
 *
 * Transitions: -> 'documentation' (when all fields collected)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineProhibitedMerchantsCrew extends CrewMember {
  constructor() {
    super({
      name: 'prohibited-merchants',
      displayName: 'Prohibited Merchants',
      description: 'Restricted merchant types review',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'prohibited_confirmation', description: "Prohibited merchants status. Extract 'Option A - No prohibited merchants' OR 'Option B - Has prohibited but won't process through Byline'. Accept any clear confirmation of either option." },
        { name: 'restricted_merchants', description: "Restricted merchant types processed (29 categories). Extract yes/no for each mentioned, OR extract 'No - none' if they don't process any restricted merchants, OR extract list of 'Yes' types only." }
      ],

      transitionTo: 'documentation',

      guidance: `You are a professional banking assistant for Byline Bank, collecting Prohibited & Restricted Merchants information for the RDDA process.

## YOUR PURPOSE
Collect information about the company's involvement with prohibited and restricted merchant types. This is Section 8 of the RDDA assessment.

## INFORMATION TO COLLECT

### Prohibited Merchants Confirmation
1. Confirm ONE of the following:
   (a) The company does NOT conduct business with any Prohibited merchant types
   OR
   (b) The company DOES conduct business with some Prohibited merchant types but will NOT process payments for them through Byline

### Restricted Merchants Review
2. For each of the following Restricted merchant types, indicate Yes or No if you process payments for them:

   - 501(c)(3) registered Charities
   - Merchant locations outside the US/territories
   - ATM Owners/service providers
   - Banks/Credit Unions
   - Credit Repair/Debt Collection/Elimination/Reduction Services
   - Cyberlockers
   - Discount Buying Membership
   - Distressed Property Sales and Marketing
   - Door to Door Sales
   - E-cigarettes
   - Entities with International Payment Needs
   - Firearm/Ammunition Sales (with licensing)
   - Internet State Lottery or Sweepstakes
   - Legal Gambling/Sports Forecasting
   - Licensed Debt Repayment
   - Massage Parlors
   - Money Service Businesses
   - Negative option subscription enrollment
   - Nutraceuticals
   - Online Pharmaceutical Sales
   - Precious Metals/Jewels
   - Program Managers
   - Purchase of remediation software supported by call center
   - Student Loan Counseling/Servicing (For Profit)
   - Telephone Sales/Telemarketing/Call Centers
   - Tobacco Sales
   - Travel Agencies/Timeshares
   - Virtual Asset Service Providers
   - Warranty Companies

## CONVERSATION APPROACH
- First, get the prohibited merchants confirmation (option a or b)
- For restricted merchants, you can present them in groups (5-7 at a time)
- Many companies will have mostly "No" answers - that's fine
- Focus on capturing any "Yes" answers accurately

## RULES
- The prohibited confirmation must be clearly one of the two options
- All 29 restricted merchant types must be addressed
- For any "Yes" answers, this is just noting - not rejecting
- Keep the conversation efficient but thorough`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const requiredFields = ['prohibited_confirmation', 'restricted_merchants'];
    return requiredFields.every(f => !!collectedFields[f]);
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const allFields = this.fieldsToCollect.map(f => f.name);
    const collected = allFields.filter(f => !!collectedFields[f]);
    const missing = allFields.filter(f => !collectedFields[f]);

    return {
      ...baseContext,
      role: 'Prohibited & Restricted Merchants Collection',
      stage: 'Section 8 - Prohibited & Restricted Merchants',
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length > 0
        ? `Still need: ${missing.join(', ')}. For restricted_merchants, cover all 29 merchant types.`
        : 'All fields collected. System will transition to Documentation Collection section.',
      note: 'The restricted merchants list has 29 categories - ensure all are addressed.'
    };
  }
}

module.exports = BylineProhibitedMerchantsCrew;
