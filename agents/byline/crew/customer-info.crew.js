/**
 * Byline RDDA Customer Information & Business Background Crew
 *
 * Section 1 - Collects company information and business background details.
 * This is the most comprehensive section with 17 questions.
 *
 * Transitions: -> 'account-activity' (when all fields collected)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineCustomerInfoCrew extends CrewMember {
  constructor() {
    super({
      name: 'customer-info',
      displayName: 'Company Information',
      description: 'Business details and background',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        // Basic Company Info
        { name: 'legal_entity_name', description: "The company's legal entity name (official registered name). REQUIRED - extract the exact name provided." },
        { name: 'dba_name', description: "The company's DBA (Doing Business As) name. Extract the DBA name, OR extract 'None' or 'N/A' if they say they don't have one or it's the same as legal name." },
        { name: 'tin', description: "The company's Tax Identification Number (TIN/EIN). REQUIRED - extract the number provided." },
        { name: 'primary_address', description: "The company's primary address including street, city, state, and zip code. REQUIRED." },
        { name: 'phone_number', description: "The company's main phone number. REQUIRED." },
        { name: 'contact_name', description: "Primary contact person's name. REQUIRED." },
        { name: 'contact_email', description: "Primary contact person's email address. REQUIRED." },
        { name: 'company_website', description: "The company's website URL. Extract the URL, OR extract 'None' if they don't have a website." },

        // Corporate Structure
        { name: 'parent_subsidiaries', description: "Parent company and/or subsidiaries. Extract company names if yes, OR extract 'No' or 'None' if they have no parent company or subsidiaries." },
        { name: 'other_locations', description: "Other office locations besides primary. Extract locations if yes, OR extract 'No' or 'None' if they only have one location." },

        // Business Details
        { name: 'company_description', description: "Company description including: length of time in business, services offered, and key personnel. REQUIRED." },
        { name: 'material_changes', description: "Material changes to business strategy or key personnel in past 12 months. Extract details if yes, OR extract 'No' or 'None' if no changes." },
        { name: 'merchant_base_overview', description: "Overview of merchant base and industry sectors supported. REQUIRED." },

        // Regulatory & Compliance
        { name: 'pep_ownership', description: "PEP (Politically Exposed Person) ownership or control. Extract name/position if yes, OR extract 'No' if not PEP-owned." },
        { name: 'other_bank_relationships', description: "Processing relationships with other banks. Extract bank names/details if yes, OR extract 'No' or 'None' if no other bank relationships." },
        { name: 'key_vendors', description: "Key/critical vendors and partners (risk, processing, technology). Extract vendor info, OR extract 'None' if no key vendors." },
        { name: 'is_payment_facilitator', description: "Registered Payment Facilitator status. Extract 'Yes' or 'No'." },
        { name: 'is_msb', description: "FinCEN MSB registration. Extract registration details if yes, OR extract 'No' if not registered as MSB." },
        { name: 'compliance_program', description: "Compliance program overview (accredited personnel, compliance officer, NACHA/CFPB knowledge). REQUIRED." },
        { name: 'foreign_transactions', description: "Foreign transactions. Extract countries if yes, OR extract 'No' or 'None' if no foreign transactions." },
        { name: 'gateway_iso_arrangements', description: "Gateway arrangements or ISO relationships. Extract details if yes, OR extract 'No' or 'None' if no such arrangements." }
      ],

      transitionTo: 'account-activity',

      guidance: `You are a professional banking assistant for Byline Bank, collecting Customer Information and Business Background for the RDDA process.

## YOUR PURPOSE
Collect comprehensive information about the company's identity, structure, operations, and regulatory status. This is Section 1 of the RDDA assessment.

## INFORMATION TO COLLECT
You need to gather the following information through natural conversation:

### Basic Company Information
1. Legal entity name, DBA (if any), and TIN
2. Primary address (street, city, state, zip)
3. Phone number, contact name, and email address
4. Company website

### Corporate Structure
5. Parent company and/or subsidiaries (list if applicable)
6. Other office locations

### Business Details
7. Company description - length of time in business, services offered, key personnel
8. Any material changes to business strategy or key personnel in the past 12 months
9. Merchant base overview - industries supported, processing categories

### Regulatory & Relationships
10. PEP (Politically Exposed Person) ownership or control
11. Processing relationships with other banks
12. Key vendors and partners (risk, processing, technology)
13. Registered Payment Facilitator status
14. FinCEN MSB registration status
15. Compliance program overview
16. Foreign transaction activity and countries
17. Gateway arrangements or ISO relationships

## CONVERSATION APPROACH
- Ask 2-3 related questions at a time, grouping logically
- Acknowledge information as it's provided
- If something is not applicable, record "N/A" or "None"
- Be thorough but efficient
- Keep a professional, helpful tone

## RULES
- Do not skip any required fields
- Clarify ambiguous answers
- If user doesn't know an answer, note it as "Unknown - to be provided"
- Keep responses concise (2-4 sentences)
- Thank the user periodically for their patience with the detailed questions`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const requiredFields = [
      'legal_entity_name', 'tin', 'primary_address', 'phone_number',
      'contact_name', 'contact_email', 'company_description', 'merchant_base_overview',
      'is_payment_facilitator', 'compliance_program'
    ];

    const hasAllRequired = requiredFields.every(f => !!collectedFields[f]);

    // Also check that at least some optional fields are addressed
    const optionalFields = [
      'dba_name', 'company_website', 'parent_subsidiaries', 'other_locations',
      'material_changes', 'pep_ownership', 'other_bank_relationships', 'key_vendors',
      'is_msb', 'foreign_transactions', 'gateway_iso_arrangements'
    ];
    const optionalAnswered = optionalFields.filter(f => !!collectedFields[f]).length;

    return hasAllRequired && optionalAnswered >= 6;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const allFields = this.fieldsToCollect.map(f => f.name);
    const collected = allFields.filter(f => !!collectedFields[f]);
    const missing = allFields.filter(f => !collectedFields[f]);

    return {
      ...baseContext,
      role: 'Customer Information Collection',
      stage: 'Section 1 - Customer Information & Business Background',
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length > 0
        ? `Still need to collect: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}. Group related questions together.`
        : 'All fields collected. System will transition to Account Activity section.',
      note: 'For fields marked N/A or None by the user, record that value. Do not re-ask for information already provided.'
    };
  }
}

module.exports = BylineCustomerInfoCrew;
