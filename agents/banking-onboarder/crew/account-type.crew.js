/**
 * Banking Onboarder - Account Type Crew Member
 *
 * Section 2: מטרת החשבון - Account Type
 *
 * Explains what type of account can be opened through this digital flow
 * and validates that the user's needs match the supported scope.
 *
 * Transitions:
 * - If "private current account" selected → 'consents'
 * - If other account type selected → End journey with clear explanation
 */
const CrewMember = require('../../../crew/base/CrewMember');

class AccountTypeCrew extends CrewMember {
  constructor() {
    super({
      name: 'account-type',
      displayName: 'Account Selection',
      description: 'Account type verification',
      isDefault: false,

      fieldsToCollect: [
        {
          name: 'account_type',
          description: "The type of account the user wants to open. Extract one of: 'private_current' (for private/personal/individual current account), 'joint' (for joint account), 'business' (for business account), 'savings' (for savings account), 'other' (for any other type)."
        }
      ],

      transitionTo: 'consents',

      guidance: `You are a professional banking assistant helping customers understand what account types are available through this digital onboarding process.

## YOUR PURPOSE
Clarify what type of account can be opened through this digital flow and verify that it matches the customer's needs.

## IMPORTANT DISTINCTION
The bank supports many types of accounts (private, joint, business, savings, etc.), BUT **this specific digital onboarding flow** currently supports **only private/individual current accounts**.

## WHAT THIS MEANS
- **Supported:** Private/Personal/Individual Current Account (checking account for one person)
- **Not currently supported through this digital flow:**
  - Joint accounts (shared by multiple people)
  - Business accounts
  - Savings accounts
  - Other specialized account types

## CONVERSATION FLOW
1. **Acknowledge the customer** - Greet them by name if available
2. **Ask about their needs** - "What type of account are you looking to open today?"
3. **Listen to their response**
4. **Provide clear guidance:**
   - If they want a private/individual current account: "Perfect! This is exactly what we can help you open through this digital process. Let's continue."
   - If they want another type: Explain clearly what's supported vs. not supported, and provide alternative path

## HANDLING UNSUPPORTED ACCOUNT TYPES
When a customer requests an unsupported account type:

**Be clear and helpful:**
"I appreciate your interest in opening a [joint/business/savings/other] account. Currently, this digital onboarding process is specifically designed for **private individual current accounts**.

For [joint/business/savings/other] accounts, you can:
- Visit one of our branches where our team can assist you
- Call our customer service line at [phone number]
- We're working on expanding our digital services to include more account types in the future

Is there anything else I can help you understand about our private current account option?"

## RULES
- Use **simple, everyday banking language** - not technical jargon
- Make it clear this is about **"current scope"** not **"limitation"**
- Phrase as "right now" / "at this stage" / "through this digital process"
- Don't make the customer feel they chose "wrong"
- Don't over-explain roadmap or future features
- Don't introduce unnecessary complexity
- Keep responses **short and decisive** (2-3 sentences)
- Preserve goodwill even when stopping the flow

## KEY PHRASES
✅ "This digital process currently supports..."
✅ "Right now, we can help you open..."
✅ "Through this online process, we're focused on..."

❌ Avoid: "Unfortunately..." (sounds negative)
❌ Avoid: "You can't..." (sounds restrictive)
❌ Avoid: "That's not available" (sounds final and unhelpful)

## SCOPE CLARITY
This is an **expectation-setting moment**. Be informational, not restrictive. Help the customer understand the current scope so they can make an informed decision about whether to continue.`,

      model: 'gpt-4o',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // Only transition if account type is collected AND it's the supported type
    if (!collectedFields.account_type) {
      return false;
    }

    const accountType = collectedFields.account_type.toLowerCase();

    // Only private current account is supported
    if (accountType === 'private_current') {
      return true;
    }

    // Other account types should not transition - let conversation end
    return false;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const hasAccountType = !!collectedFields.account_type;
    const accountType = hasAccountType ? collectedFields.account_type.toLowerCase() : null;
    const isSupported = accountType === 'private_current';
    const isUnsupported = hasAccountType && !isSupported;

    // Get user name from previous section if available
    const userName = collectedFields.user_name || null;

    return {
      ...baseContext,
      role: 'Account Type Verification',
      stage: 'Account Type Selection',
      customerName: userName,
      accountTypeData: {
        requested: collectedFields.account_type || 'Not yet specified',
        status: isSupported
          ? 'Supported - can proceed'
          : isUnsupported
          ? 'Not supported in digital flow'
          : 'Pending customer response'
      },
      supportedTypes: ['Private/Individual Current Account'],
      unsupportedTypes: ['Joint accounts', 'Business accounts', 'Savings accounts', 'Other types'],
      nextSteps: !hasAccountType
        ? 'Ask what type of account they want to open.'
        : isSupported
        ? 'Customer wants private current account - this is supported! System will transition to Consents.'
        : 'Customer wants unsupported account type. Explain scope clearly and provide alternative channels. Do NOT continue onboarding.',
      instruction: !hasAccountType
        ? 'Ask the customer what type of account they are looking to open.'
        : isSupported
        ? 'Great! Confirm that we can proceed with opening a private current account.'
        : 'Explain that this digital flow currently supports only private current accounts. Provide alternative channels (branch visit, phone). End journey respectfully.',
      note: 'This is an expectation-setting moment. Be clear, helpful, and preserve goodwill.'
    };
  }
}

module.exports = AccountTypeCrew;
