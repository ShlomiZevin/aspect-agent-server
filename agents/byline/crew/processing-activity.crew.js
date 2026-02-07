/**
 * Byline RDDA Processing Activity Crew
 *
 * Section 4 - Collects information about processing activity and transaction types.
 *
 * Transitions: -> 'digital-assets' (when all fields collected)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineProcessingActivityCrew extends CrewMember {
  constructor() {
    super({
      name: 'processing-activity',
      displayName: 'Processing Activity',
      description: 'Transaction types and volumes',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'nested_processors', description: "Whether portfolio includes nested processors. Extract details if yes, OR extract 'No' or 'None' if no nested processors." },
        { name: 'ach_transaction_types', description: "ACH transaction types and percentages (CCD, PPD, POP, TEL, ARC, WEB, BOC debits/credits). Extract the percentage breakdown provided." },
        { name: 'return_rates_60day', description: "Overall return rate for last 60 days. Extract the percentage." },
        { name: 'return_rates_12month', description: "Overall return rate for last 12 months. Extract the percentage." },
        { name: 'unauthorized_rates_60day', description: "Unauthorized return rate for last 60 days. Extract the percentage." },
        { name: 'unauthorized_rates_12month', description: "Unauthorized return rate for last 12 months. Extract the percentage." },
        { name: 'max_2day_ach_totals', description: "Maximum 2-day ACH file totals for credits and debits. Extract the dollar amounts." },
        { name: 'restricted_businesses', description: "Whether processing for Restricted Businesses per Byline's list. Extract details and percentage if yes, OR extract 'No' if not processing restricted businesses." }
      ],

      transitionTo: 'digital-assets',

      guidance: `You are a professional banking assistant for Byline Bank, collecting Processing Activity information for the RDDA process.

## YOUR PURPOSE
Collect detailed information about the company's processing activity, transaction types, and return rates. This is Section 4 of the RDDA assessment.

## INFORMATION TO COLLECT

### Nested Processors
1. Does the merchant portfolio include any nested processors? If yes, explain.

### ACH Transaction Breakdown
2. What are the types and percentages of ACH merchant transactions?
   - CCD Debits (%)
   - PPD Debits (%)
   - POP Debits (%)
   - TEL Debits (%)
   - ARC Debits (%)
   - CCD Credits (%)
   - PPD Credits (%)
   - CIE Credits (%)
   - WEB Debits (%)
   - BOC Debits (%)
   (Only applicable types need to be provided)

### Return Rates
3. Overall return rates for the last 60 days?
4. Overall return rates for the last 12 months?
5. Unauthorized return rates for the last 60 days?
6. Unauthorized return rates for the last 12 months?

### Volume Limits
7. What are the maximum 2-day ACH file totals for credits and debits?

### Restricted Businesses
8. Will you process payments through Byline for any Restricted Businesses (per Byline's Restricted/Prohibited Merchant List)? If yes, explain and provide percentage of overall volume.

## CONVERSATION APPROACH
- Start with nested processors question
- Walk through ACH transaction types - they only need to provide ones they use
- Get all four return rate metrics (60-day and 12-month for both overall and unauthorized)
- Clarify max 2-day totals for both credits AND debits
- End with restricted businesses question

## RULES
- Return rates should be percentages
- ACH breakdown should total approximately 100%
- 2-day totals should be dollar amounts
- Be clear about the difference between overall and unauthorized returns`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const requiredFields = [
      'nested_processors', 'ach_transaction_types', 'return_rates_60day',
      'return_rates_12month', 'unauthorized_rates_60day', 'unauthorized_rates_12month',
      'max_2day_ach_totals', 'restricted_businesses'
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
      role: 'Processing Activity Collection',
      stage: 'Section 4 - Processing Activity',
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length > 0
        ? `Still need: ${missing.join(', ')}.`
        : 'All fields collected. System will transition to Digital Assets section.',
      note: 'Ensure return rates are captured as percentages. ACH transaction types should show percentage breakdown.'
    };
  }
}

module.exports = BylineProcessingActivityCrew;
