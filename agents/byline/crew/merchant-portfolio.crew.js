/**
 * Byline RDDA Merchant Portfolio Crew
 *
 * Section 3 - Collects information about merchant portfolio and controls.
 *
 * Transitions: -> 'processing-activity' (when all fields collected)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineMerchantPortfolioCrew extends CrewMember {
  constructor() {
    super({
      name: 'merchant-portfolio',
      displayName: 'Merchant Portfolio',
      description: 'Merchant controls and audits',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'merchant_controls', description: "Controls for reviewing merchant activity (Return Reporting, Dollar Limits, Variance Detection, MFA, etc.). Extract the controls listed, OR extract 'None' if no controls in place." },
        { name: 'completed_audits', description: "Completed audits and dates (NACHA Self Audit, PCI, SOC 1, SOC 2). Extract audit names with dates, OR extract 'None' if no audits completed." },
        { name: 'total_merchants_volume', description: "Total merchant clients count and annual processing volume. Extract the numbers provided." },
        { name: 'byline_merchants_volume', description: "Anticipated Byline merchant clients and volume. Extract the numbers provided." },
        { name: 'merchant_growth', description: "Anticipated annual merchant growth. Extract percentage or number provided." }
      ],

      transitionTo: 'processing-activity',

      guidance: `You are a professional banking assistant for Byline Bank, collecting Merchant Portfolio information for the RDDA process.

## YOUR PURPOSE
Collect information about the company's merchant portfolio, controls, and audit history. This is Section 3 of the RDDA assessment.

## INFORMATION TO COLLECT

### Merchant Activity Controls
1. What controls are in place to review merchant activity?
   - Return Reporting & Merchant Level Thresholds
   - Dollar Limits
   - Variance Detection
   - Multi-Factor Authentication
   - Other controls (specify)

### Audit History
2. Have any of the following audits been completed? If so, what is the date of the most recent:
   - NACHA Self Audit
   - PCI Audit
   - SOC 1
   - SOC 2

### Portfolio Metrics
3. What is the total number of merchant clients and annual processing volume?
4. What is the anticipated number of merchant clients and annual processing volume to be processed at Byline?
5. What is the anticipated annual merchant client growth?

## CONVERSATION APPROACH
- Start with controls they have in place
- Ask about audit completions - need both which ones AND dates
- Get current total portfolio size before Byline-specific numbers
- For growth, accept percentage or absolute numbers

## RULES
- Be specific about audit dates (month/year is fine)
- For volumes, get dollar amounts
- Differentiate between total portfolio and Byline-specific volumes
- Keep the conversation efficient`,

      model: 'gpt-4o',
      maxTokens: 1200,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const requiredFields = [
      'merchant_controls', 'completed_audits', 'total_merchants_volume',
      'byline_merchants_volume', 'merchant_growth'
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
      role: 'Merchant Portfolio Collection',
      stage: 'Section 3 - Merchant Portfolio',
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length > 0
        ? `Still need: ${missing.join(', ')}.`
        : 'All fields collected. System will transition to Processing Activity section.',
      note: 'Ensure audit dates are captured for each completed audit type.'
    };
  }
}

module.exports = BylineMerchantPortfolioCrew;
