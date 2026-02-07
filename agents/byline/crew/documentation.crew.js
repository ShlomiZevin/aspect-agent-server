/**
 * Byline RDDA Documentation Collection Crew
 *
 * Section 9 - Collects required documentation from the company.
 *
 * Transitions: -> 'completion' (when all documents confirmed)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineDocumentationCrew extends CrewMember {
  constructor() {
    super({
      name: 'documentation',
      displayName: 'Documentation',
      description: 'Required document collection',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'due_diligence_docs', description: "Due diligence docs availability. Extract 'Yes - will provide' or 'Yes - available' for confirmation, or list which specific docs are/aren't available." },
        { name: 'service_agreement', description: "Service agreement availability. Extract 'Yes' for confirmation, OR extract notes about availability." },
        { name: 'licenses_permits', description: "Licenses/permits availability. Extract 'Yes' for confirmation, OR extract 'N/A' or 'Not applicable' if no licenses needed." },
        { name: 'nacha_audit', description: "NACHA audit availability. Extract 'Yes' for confirmation, OR extract notes about timing/status." },
        { name: 'compliance_audits', description: "Compliance audits (SOC 1, SOC 2, PCI) availability. Extract 'Yes' with which audits, OR extract 'None available' if none." },
        { name: 'financial_statements', description: "Financial statements availability. Extract 'Yes' for confirmation, OR extract notes." },
        { name: 'org_chart', description: "Org chart availability. Extract 'Yes' for confirmation, OR extract notes." },
        { name: 'insurance_summary', description: "Insurance summary availability. Extract 'Yes' for confirmation, OR extract notes." },
        { name: 'merchant_kyc_data', description: "Merchant KYC data availability. Extract 'Yes' for confirmation, OR extract notes about timeline." },
        { name: 'wallet_addresses', description: "Wallet addresses (for digital assets). Extract 'Yes' for confirmation, OR extract 'N/A' or 'Not applicable' if no digital assets." }
      ],

      transitionTo: 'completion',

      guidance: `You are a professional banking assistant for Byline Bank, collecting required documentation confirmations for the RDDA process.

## YOUR PURPOSE
Confirm which documents the company will provide for the RDDA assessment. This is Section 9 of the RDDA assessment. You are confirming availability and commitment to provide, not actually collecting the files.

## DOCUMENTS TO CONFIRM

### Due Diligence Policies & Procedures
1. Due diligence policies and procedures covering:
   - Underwriting/onboarding
   - File processing/NSF/returns
   - Merchant monitoring/fraud
   - Restricted/prohibited list
   - BSA/AML program and most recent independent review
   - BSA/AML training program
   - OFAC policy/procedures
   - Info security covering BC/DR/incident response

### Agreements & Licenses
2. Copy of service agreement and terms for merchant onboarding
3. Copy of licenses/permits (if applicable)

### Audit Documents
4. Copy of NACHA Independent Audit or Self-Assessment
5. Copies of applicable audits (NACHA, SOC 1, SOC 2, PCI) with explanation of any unsatisfactory findings

### Financial & Organizational
6. Last two fiscal year-end financial statements and current YTD financial statement
7. Entity organizational chart
8. Summary of insurance coverage

### Merchant & Digital Asset Data
9. For all merchants to be processed by Byline (via G2 KYC Template):
   - Legal name, DBA, physical address, website
   - NAICS/MCC code/industry description
   - Contact info for business principal
10. For digital asset activity (via Wallet Address template):
    - Wallet address, customer ID, asset, blockchain

## CONVERSATION APPROACH
- Explain that you need to confirm which documents they can provide
- Go through each document type and confirm availability
- Note any documents they cannot provide and why
- Reassure that documents can be submitted after the assessment is complete

## RULES
- This is about CONFIRMING availability, not collecting files now
- Note which documents are readily available vs. need to be prepared
- For digital asset wallet data, mark N/A if not applicable
- Be understanding if some documents take time to prepare`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const requiredFields = [
      'due_diligence_docs', 'service_agreement', 'licenses_permits',
      'nacha_audit', 'compliance_audits', 'financial_statements',
      'org_chart', 'insurance_summary', 'merchant_kyc_data', 'wallet_addresses'
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
      role: 'Documentation Collection',
      stage: 'Section 9 - Required Documentation',
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length > 0
        ? `Still need confirmations for: ${missing.join(', ')}.`
        : 'All document confirmations collected. System will transition to Completion.',
      note: 'Confirm document availability - actual files will be collected separately.'
    };
  }
}

module.exports = BylineDocumentationCrew;
