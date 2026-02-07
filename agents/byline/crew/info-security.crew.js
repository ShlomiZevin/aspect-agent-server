/**
 * Byline RDDA Information Security Crew
 *
 * Section 7 - Collects information about information security policies and practices.
 *
 * Transitions: -> 'prohibited-merchants' (when all fields collected)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineInfoSecurityCrew extends CrewMember {
  constructor() {
    super({
      name: 'info-security',
      displayName: 'Information Security',
      description: 'Security policies and controls',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'security_policies', description: "Approved security policies (Info Security, BC, DR, Incident Response, Cyber Insurance). Extract yes/no for each policy, OR extract 'Yes - all' or 'No - none' as summary if given." },
        { name: 'bcm_practices', description: "BCM practices (DR testing, BIA review, RTO alignment, geographic redundancy). Extract yes/no for each practice, OR extract summary response." },
        { name: 'security_incidents', description: "Security incidents in past 5 years (breaches, claims, investigations, notifications, ransomware). Extract yes/no for each with details if yes, OR extract 'No - none' if no incidents." },
        { name: 'security_controls', description: "Technical security controls (EPP, EDR, MDR, NDR, email security, etc.). Extract yes/no for controls mentioned, OR extract summary response." }
      ],

      transitionTo: 'prohibited-merchants',

      guidance: `You are a professional banking assistant for Byline Bank, collecting Information Security information for the RDDA process.

## YOUR PURPOSE
Collect information about the company's information security policies, practices, and incident history. This is Section 7 of the RDDA assessment.

## INFORMATION TO COLLECT

### Security Policies & Programs (Management-Annually-Approved)
1. Does the company have approved policies for:
   - Information Security Policy/Program
   - Business Continuity Policy/Program
   - Disaster Recovery Policy/Program
   - Incident Response Plan
   - Cyber Insurance Coverage

### Business Continuity Management
2. For BCM, does the company:
   - Annually test disaster recovery plans and remediate gaps
   - Annually review/approve business impact analysis (BIA)
   - Ensure disaster recovery time objectives (RTOs) align with business needs
   - Have geographic redundancy for critical systems

### Security Incident History (Past 5 Years)
3. In the past five years, has the company:
   - Experienced any cybersecurity incidents or data breaches
   - Received any claims/complaints regarding privacy or security breaches
   - Been subject to any government action/investigation/subpoena regarding privacy law violations
   - Notified customers or third parties of a data breach
   - Experienced an actual or attempted extortion/ransomware demand

### Technical Security Controls
4. Does the company implement and maintain:
   - EPP (Endpoint Protection Platform)
   - EDR (Endpoint Detection and Response)
   - MDR (Managed Detection and Response)
   - NDR (Network Detection and Response)
   - Email screening for malicious attachments
   - Email link screening/blocking
   - Email tagging for external vs. internal
   - Phishing report capability for end users
   - Deny non-authorized devices from syncing/accessing email
   - Anti-ransomware defensive strategy
   - Defense against web browser session hijacking
   - Whether ordinary Windows users have Administrator access (should be NO)
   - Whether access is allowed from US countries of concern or APT nation states (should be NO)

## CONVERSATION APPROACH
- Break this into logical sections: policies, BCM, incidents, controls
- For each section, you can ask about multiple items at once
- For incident history, be sensitive but thorough
- For controls, focus on what they have in place

## RULES
- Each category has multiple yes/no items - capture all
- For any "yes" on incident history, get details
- Technical controls section is detailed - be patient
- Keep responses organized and professional`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const requiredFields = [
      'security_policies', 'bcm_practices', 'security_incidents', 'security_controls'
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
      role: 'Information Security Collection',
      stage: 'Section 7 - Information Security',
      progress: {
        collected: collected.length,
        total: allFields.length,
        percentage: Math.round((collected.length / allFields.length) * 100)
      },
      fieldsAlreadyCollected: collected.map(f => `${f}: ${collectedFields[f]}`),
      fieldsStillNeeded: missing,
      instruction: missing.length > 0
        ? `Still need: ${missing.join(', ')}. Each field contains multiple yes/no items - capture all.`
        : 'All fields collected. System will transition to Prohibited & Restricted Merchants section.',
      note: 'This is a comprehensive security assessment. Ensure each sub-item is addressed.'
    };
  }
}

module.exports = BylineInfoSecurityCrew;
