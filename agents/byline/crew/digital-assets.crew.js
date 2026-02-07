/**
 * Byline RDDA Digital Assets Crew
 *
 * Section 5 - Collects information about digital asset involvement (if applicable).
 * This section is only relevant if the company deals with digital assets.
 *
 * Transitions: -> 'bsa-aml' (when fields collected or marked N/A)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineDigitalAssetsCrew extends CrewMember {
  constructor() {
    super({
      name: 'digital-assets',
      displayName: 'Digital Assets',
      description: 'Cryptocurrency and blockchain activity',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'digital_assets_applicable', description: "Whether company has digital asset involvement. Extract 'Yes' or 'No'. IMPORTANT: If user says 'no', extract 'No' immediately." },
        { name: 'digital_assets_description', description: "Description of digital asset involvement (trading, mining, token issuance). Extract details if applicable, OR extract 'N/A' if not involved." },
        { name: 'digital_asset_types', description: "Types of digital assets involved. Extract the list, OR extract 'N/A' if not applicable." },
        { name: 'blockchain_analytics_vendors', description: "Blockchain analytics vendors used. Extract vendor names, OR extract 'N/A' or 'None' if not applicable." },
        { name: 'blockchain_analytics_usage', description: "How blockchain analytics is used for monitoring/risk. Extract description, OR extract 'N/A' if not applicable." },
        { name: 'digital_asset_vendors', description: "Third-party vendors for digital assets. Extract vendor names, OR extract 'N/A' or 'None' if not applicable." },
        { name: 'digital_exchanges', description: "Digital exchanges used. Extract exchange names, OR extract 'N/A' or 'None' if not applicable." },
        { name: 'self_custody_practices', description: "Self-custody practices and client asset holding. Extract description, OR extract 'N/A' or 'None' if not applicable." }
      ],

      transitionTo: 'bsa-aml',

      guidance: `You are a professional banking assistant for Byline Bank, collecting Digital Assets information for the RDDA process.

## YOUR PURPOSE
Collect information about the company's involvement with digital assets and cryptocurrency. This is Section 5 of the RDDA assessment.

## IMPORTANT: APPLICABILITY CHECK
First, ask if the company has any involvement with digital assets. If they do NOT deal with digital assets:
- Record digital_assets_applicable as "no"
- Mark all other fields as "N/A"
- Proceed to transition

If they DO deal with digital assets, collect the detailed information.

## INFORMATION TO COLLECT (if applicable)

### Digital Asset Involvement
1. Is the company involved with digital assets?
2. If yes, describe the firm's involvement (trading, mining, token issuance, etc.)
3. What specific types of digital assets are involved?

### Blockchain Analytics
4. What blockchain analytics software vendor(s) does the firm use?
5. How does the firm use blockchain analytics for transaction monitoring and risk management?

### Third-Party Relationships
6. What third-party vendors are used for holding or transacting with digital assets?
7. What digital exchanges does the firm use?

### Custody
8. Describe any self-custody practices. Does the firm hold client assets?

## CONVERSATION APPROACH
- Start with a clear yes/no on digital asset involvement
- If no involvement, quickly mark all as N/A and move on
- If yes, gather each piece of information systematically
- This is a specialized area - be patient with detailed explanations

## RULES
- If not applicable, mark fields as N/A explicitly
- Get specific vendor and exchange names
- Understand the difference between holding own assets vs. client assets
- Keep the conversation efficient for companies without digital asset involvement`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // If not applicable, we just need the applicability field
    if (collectedFields.digital_assets_applicable?.toLowerCase() === 'no') {
      return true;
    }

    // If applicable, need all fields
    const requiredFields = [
      'digital_assets_applicable', 'digital_assets_description', 'digital_asset_types',
      'blockchain_analytics_vendors', 'blockchain_analytics_usage', 'digital_asset_vendors',
      'digital_exchanges', 'self_custody_practices'
    ];
    return requiredFields.every(f => !!collectedFields[f]);
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const isApplicable = collectedFields.digital_assets_applicable?.toLowerCase() !== 'no';
    const allFields = this.fieldsToCollect.map(f => f.name);
    const collected = allFields.filter(f => !!collectedFields[f]);
    const missing = allFields.filter(f => !collectedFields[f]);

    return {
      ...baseContext,
      role: 'Digital Assets Collection',
      stage: 'Section 5 - Digital Assets',
      isApplicable,
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: !collectedFields.digital_assets_applicable
        ? 'First ask if the company has any involvement with digital assets (cryptocurrency, blockchain, etc.)'
        : (isApplicable && missing.length > 0)
          ? `Digital assets applicable. Still need: ${missing.join(', ')}.`
          : 'Section complete. System will transition to BSA/AML section.',
      note: 'If digital assets are not applicable, mark all remaining fields as N/A.'
    };
  }
}

module.exports = BylineDigitalAssetsCrew;
