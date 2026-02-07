/**
 * Byline RDDA BSA/AML, OFAC and Reg GG Crew
 *
 * Section 6 - Collects information about anti-money laundering and sanctions compliance.
 *
 * Transitions: -> 'info-security' (when all fields collected)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineBsaAmlCrew extends CrewMember {
  constructor() {
    super({
      name: 'bsa-aml',
      displayName: 'BSA/AML Compliance',
      description: 'Anti-money laundering and OFAC compliance',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'has_aml_program', description: "Whether company has written AML Compliance Program. Extract 'Yes' or 'No'. If no, extract the explanation given." },
        { name: 'aml_program_approved', description: "Whether AML program is approved by Senior Management/Board. Extract 'Yes' or 'No'." },
        { name: 'third_party_aml', description: "Whether third parties are used for AML/CTF/Sanctions. Extract 'Yes' with vendor/component details, OR extract 'No' if no third parties used." },
        { name: 'aml_program_standards', description: "AML program standards coverage for 15 areas. Extract the yes/no responses for each area, OR extract 'Yes - all areas' or 'Yes - except [gaps]' as appropriate." },
        { name: 'ofac_reports', description: "Whether company files blocked/rejected reports with OFAC. Extract 'Yes' or 'No'. If no, extract the explanation." },
        { name: 'whistleblower_policy', description: "Whether company has whistleblower policy. Extract 'Yes' or 'No'." }
      ],

      transitionTo: 'info-security',

      guidance: `You are a professional banking assistant for Byline Bank, collecting BSA/AML, OFAC and Reg GG compliance information for the RDDA process.

## YOUR PURPOSE
Collect information about the company's anti-money laundering and sanctions compliance programs. This is Section 6 of the RDDA assessment.

## INFORMATION TO COLLECT

### AML Program
1. Does the company have a written AML Compliance Program? If no, explain why not.
2. Is the AML program approved by Senior Management or the Board of Directors?
3. Are third parties used for any component of the AML, CTF & Sanctions program? If yes, provide details.

### AML Program Standards
4. Does the program set minimum AML, CTF and Sanctions standards for each of the following:
   - Appointed Officer with sufficient experience/expertise
   - Risk Assessment
   - Policies and Procedures
   - Beneficial Ownership
   - Customer Due Diligence (CDD)
   - Enhanced Due Diligence (EDD)
   - Periodic Review
   - Adverse Information Screening
   - OFAC Sanctions Screening
   - PEP Screening
   - Transaction Monitoring
   - Suspicious Activity Reporting
   - Training and Education
   - Independent Testing
   - Record Retention

### OFAC & Whistleblower
5. Does the company file blocked or rejected reports with OFAC? If no, explain.
6. Does the company have a whistleblower policy?

## CONVERSATION APPROACH
- Start with basic AML program existence and approval
- For the AML standards question, you can ask for a general confirmation or walk through key areas
- Be understanding that this is a detailed compliance area
- Keep a professional, regulatory-focused tone

## RULES
- The AML standards question has 15 sub-items - get confirmation on all or note any gaps
- If they don't have an AML program, understand why (new company, in development, etc.)
- Third-party details should include vendor names and which components they handle
- OFAC reporting is a key compliance requirement`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const requiredFields = [
      'has_aml_program', 'aml_program_approved', 'third_party_aml',
      'aml_program_standards', 'ofac_reports', 'whistleblower_policy'
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
      role: 'BSA/AML Compliance Collection',
      stage: 'Section 6 - BSA/AML, OFAC and Reg GG',
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length > 0
        ? `Still need: ${missing.join(', ')}. For aml_program_standards, confirm coverage of all 15 areas or note gaps.`
        : 'All fields collected. System will transition to Information Security section.',
      note: 'This is a critical compliance section. Ensure thorough responses for each item.'
    };
  }
}

module.exports = BylineBsaAmlCrew;
