/**
 * Banking Onboarder - Consents & Permissions Crew Member
 *
 * Section 3: קבלת הסכמות - Consents & Permissions
 *
 * Obtains all mandatory consents required to proceed with account opening.
 * Ensures informed approval with minimal cognitive load.
 *
 * Transitions:
 * - If all mandatory consents approved → 'identity-verification'
 * - If any mandatory consent rejected (after reconsideration) → End journey
 */
const CrewMember = require('../../../crew/base/CrewMember');

class ConsentsCrew extends CrewMember {
  constructor() {
    super({
      name: 'consents',
      displayName: 'Consents',
      description: 'Regulatory consents and permissions',
      isDefault: false,

      fieldsToCollect: [
        {
          name: 'terms_and_conditions_consent',
          description: "MANDATORY. User's explicit consent to Terms & Conditions. Extract 'approved' if they explicitly agree/accept/consent. Extract 'rejected' if they explicitly decline/refuse. If they ask questions without deciding, do not extract yet."
        },
        {
          name: 'privacy_policy_consent',
          description: "MANDATORY. User's explicit consent to Privacy Policy. Extract 'approved' if they explicitly agree/accept/consent. Extract 'rejected' if they explicitly decline/refuse. If they ask questions without deciding, do not extract yet."
        },
        {
          name: 'data_processing_consent',
          description: "MANDATORY. User's explicit consent to Data Processing (KYC, credit checks, regulatory compliance). Extract 'approved' if they explicitly agree/accept/consent. Extract 'rejected' if they explicitly decline/refuse. If they ask questions without deciding, do not extract yet."
        },
        {
          name: 'electronic_communication_consent',
          description: "MANDATORY. User's explicit consent to receive electronic communications (statements, notifications). Extract 'approved' if they explicitly agree/accept/consent. Extract 'rejected' if they explicitly decline/refuse. If they ask questions without deciding, do not extract yet."
        },
        {
          name: 'consent_rejection_reconsidered',
          description: "Set to 'true' only if user initially rejected a consent, you explained why it's required, and they reconsidered and approved. This tracks the reconsideration cycle."
        }
      ],

      transitionTo: 'identity-verification',

      guidance: `You are a professional banking assistant helping customers understand and provide the necessary consents for opening a bank account.

## YOUR PURPOSE
Obtain all **mandatory consents** required by law and regulation to proceed with account opening. Enable **informed approval** with minimal friction.

## MANDATORY CONSENTS
The following consents are **required** to open an account through this digital process:

1. **Terms & Conditions** - Standard account terms
2. **Privacy Policy** - How we handle personal information
3. **Data Processing** - Permission to verify identity, run credit/compliance checks
4. **Electronic Communications** - Receive statements and notifications electronically

## CONVERSATION FLOW

### Initial Presentation
"To proceed with your account opening, I need your approval on a few important items. These are standard regulatory requirements:

1. **Terms & Conditions** - Our account terms
2. **Privacy Policy** - How we protect your information
3. **Data Processing** - Permission for identity verification and compliance checks
4. **Electronic Communications** - Receiving statements digitally

You can review the full details [links would be provided], but in brief: these allow us to open your account, verify your identity, and communicate with you securely.

Do you approve these items?"

### If User Approves All
"Perfect! Thank you for your approval. All consents are now in place, and we can proceed with identity verification."

### If User Has Questions
Answer directly and simply. Don't force reading full legal text. Keep answers practical and focused on **why we need this**.

### If User Rejects a Consent (First Time)
**Explain purpose calmly:**
"I understand your hesitation. [Consent name] is required because [practical reason - e.g., 'we need permission to verify your identity for security and regulatory compliance'].

Without this consent, we won't be able to proceed with opening your account through this digital process, as it's a regulatory requirement.

Would you like to reconsider, or would you prefer to explore opening an account through one of our branches where you can discuss this in detail?"

### If User Still Rejects After Reconsideration
**End journey respectfully:**
"I completely understand. Without [consent name], we're unable to proceed with this digital account opening process.

If you'd like to discuss this further or explore other options, you can:
- Visit one of our branches
- Call our customer service line

Thank you for your time, and please feel free to return when you're ready."

## RULES
- Clearly distinguish **mandatory** vs optional consents (all listed above are mandatory)
- Use **simple, human language** - not legal jargon as primary language
- Explain **purpose** ("why we need this") not just legal framing
- Allow **one reconsideration cycle** - explain once, then respect decision
- Don't dump full legal text inline - offer to "read more" but don't force it
- Don't guilt the user into approval
- Don't create infinite loops - ask once, explain if rejected, then accept final decision
- Allow **questions** without treating them as rejection
- Keep **process momentum** - don't make this feel like a roadblock

## KEY PRINCIPLES
- **Informed approval with minimal cognitive load**
- **Transparency** - clear about what they're approving and why
- **Respect user autonomy** - no manipulation, no guilt
- **Regulatory requirement** - frame as necessary, not arbitrary

## CONSENT LOGGING
When user approves, note timestamp and confirmation in your response for tracking purposes. Example: "Your consents have been recorded as of [timestamp]."`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // Check if all mandatory consents are approved
    const requiredConsents = [
      'terms_and_conditions_consent',
      'privacy_policy_consent',
      'data_processing_consent',
      'electronic_communication_consent'
    ];

    const allApproved = requiredConsents.every(
      consent => collectedFields[consent] === 'approved'
    );

    // Only transition if all mandatory consents are approved
    return allApproved;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const consents = {
      termsAndConditions: collectedFields.terms_and_conditions_consent || 'pending',
      privacyPolicy: collectedFields.privacy_policy_consent || 'pending',
      dataProcessing: collectedFields.data_processing_consent || 'pending',
      electronicComm: collectedFields.electronic_communication_consent || 'pending'
    };

    const approved = Object.values(consents).filter(v => v === 'approved').length;
    const rejected = Object.values(consents).filter(v => v === 'rejected').length;
    const pending = Object.values(consents).filter(v => v === 'pending').length;

    const allApproved = approved === 4;
    const anyRejected = rejected > 0;
    const hasReconsidered = collectedFields.consent_rejection_reconsidered === 'true';

    // Get user name from previous sections
    const userName = collectedFields.user_name || null;

    return {
      ...baseContext,
      role: 'Consents & Permissions Collection',
      stage: 'Regulatory Consents',
      customerName: userName,
      consentStatus: {
        termsAndConditions: consents.termsAndConditions,
        privacyPolicy: consents.privacyPolicy,
        dataProcessing: consents.dataProcessing,
        electronicCommunications: consents.electronicComm
      },
      summary: {
        approved: `${approved}/4`,
        rejected: rejected,
        pending: pending
      },
      reconsiderationCycle: hasReconsidered ? 'Used (one reconsideration allowed)' : 'Available',
      nextSteps: allApproved
        ? 'All mandatory consents approved! System will transition to Identity Verification.'
        : anyRejected && hasReconsidered
        ? 'User has rejected consent after reconsideration. Explain limitation and end journey respectfully.'
        : anyRejected && !hasReconsidered
        ? 'User rejected a consent. Explain why it\'s required and offer one reconsideration.'
        : 'Present consents clearly and obtain approval.',
      instruction: allApproved
        ? 'Thank the user for their approvals and confirm we can proceed.'
        : anyRejected && hasReconsidered
        ? 'User has made their final decision. End journey respectfully, provide alternative channels.'
        : anyRejected && !hasReconsidered
        ? 'Explain calmly why the rejected consent is required. Offer one chance to reconsider.'
        : pending === 4
        ? 'Present all four mandatory consents clearly. Explain purpose in simple terms.'
        : 'Continue collecting remaining consent approvals.',
      note: 'Questions are normal and should be answered without treating as rejection. Only explicit refusal counts as rejection.'
    };
  }
}

module.exports = ConsentsCrew;
