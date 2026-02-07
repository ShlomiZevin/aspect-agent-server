/**
 * Byline RDDA Account Activity Crew
 *
 * Section 2 - Collects information about account activity and purposes.
 *
 * Transitions: -> 'merchant-portfolio' (when all fields collected)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineAccountActivityCrew extends CrewMember {
  constructor() {
    super({
      name: 'account-activity',
      displayName: 'Account Activity',
      description: 'Depository accounts and activity',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'has_depository_accounts', description: "Whether the company has or will establish depository accounts. Extract 'Yes' or 'No'." },
        { name: 'account_purpose', description: "Purpose of the account(s): Third Party ACH, Card Settlement, Payroll, Operating, or other. Extract the stated purposes." },
        { name: 'monthly_activity', description: "Anticipated monthly activity (dollars and items) for: ACH receipts/originations, domestic wires, international wires (with countries), and deposit balance. Extract the provided figures/estimates, OR extract 'None' for categories with no activity." },
        { name: 'digital_assets_involvement', description: "Whether account activity involves digital assets. Extract 'Yes' or 'No'." }
      ],

      transitionTo: 'merchant-portfolio',

      guidance: `You are a professional banking assistant for Byline Bank, collecting Account Activity information for the RDDA process.

## YOUR PURPOSE
Collect information about the company's depository accounts and anticipated transaction activity. This is Section 2 of the RDDA assessment.

## INFORMATION TO COLLECT

### Account Basics
1. Does the company have or will it be establishing depository accounts?
2. What is the purpose of the account(s)?
   - Third Party ACH
   - Card Settlement
   - Payroll
   - Operating
   - Other (specify)

### Transaction Volume
3. Anticipated average monthly activity (in dollars AND number of items):
   - Receipt of ACH Transactions
   - Origination of ACH Transactions
   - Receipt of Domestic Wires
   - Origination of Domestic Wires
   - Receipt of International Wires (list countries)
   - Origination of International Wires (list countries)
   - Average Monthly Deposit Balance

### Digital Assets
4. Will the account activity be directly involved with digital assets?

## CONVERSATION APPROACH
- Start by confirming they have/want depository accounts
- Ask about account purposes
- For the monthly activity question, help them break it down by category
- Be patient with volume estimates - approximations are acceptable
- Note if they have international wire activity and to which countries

## RULES
- Get specific dollar amounts and transaction counts where possible
- If exact figures aren't known, accept ranges or estimates
- For international wires, always ask which countries
- Keep responses focused and professional`,

      model: 'gpt-4o',
      maxTokens: 1200,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const requiredFields = [
      'has_depository_accounts', 'account_purpose', 'monthly_activity', 'digital_assets_involvement'
    ];
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
      role: 'Account Activity Collection',
      stage: 'Section 2 - Account Activity',
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length > 0
        ? `Still need: ${missing.join(', ')}. The monthly_activity field should include all transaction types.`
        : 'All fields collected. System will transition to Merchant Portfolio section.',
      note: 'For monthly activity, ensure you capture both dollar amounts and transaction counts for each category.'
    };
  }
}

module.exports = BylineAccountActivityCrew;
