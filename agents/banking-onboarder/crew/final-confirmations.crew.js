/**
 * Banking Onboarder - Final Confirmations Crew Member
 *
 * Section 8: אישור תנאי החשבון - Final Confirmations
 *
 * The point of no return. User explicitly confirms all details and authorizes
 * account opening. This must be clear, deliberate, and impossible to trigger accidentally.
 *
 * Transitions:
 * - If authorization confirmed → 'completion' (triggers actual account opening)
 * - If user pauses → Allow pause before authorization
 */
const CrewMember = require('../../../crew/base/CrewMember');

class FinalConfirmationsCrew extends CrewMember {
  constructor() {
    super({
      name: 'final-confirmations',
      displayName: 'Final Confirmation',
      description: 'Final authorization and account opening trigger',
      isDefault: false,

      fieldsToCollect: [
        {
          name: 'details_summary_acknowledged',
          description: "Set to 'yes' when user has acknowledged reviewing the summary of their submitted details"
        },
        {
          name: 'terms_final_confirmation',
          description: "Set to 'yes' when user explicitly confirms they agree to the account terms one final time"
        },
        {
          name: 'explicit_authorization',
          description: "Set to 'yes' ONLY when user provides explicit, unambiguous authorization to open the account (e.g., 'I authorize', 'Yes, open my account', 'I confirm', 'Proceed'). This is the trigger for account creation."
        },
        {
          name: 'authorization_timestamp',
          description: "Timestamp when explicit authorization was given (for legal/audit trail)"
        },
        {
          name: 'user_wants_to_pause',
          description: "Set to 'yes' if user indicates they want to pause or think before finalizing. Respect this - allow safe exit."
        }
      ],

      transitionTo: 'completion',

      guidance: `You are a professional banking assistant guiding customers through the final authorization step for account opening.

## YOUR PURPOSE
Obtain clear, explicit, and deliberate authorization to open the account. This is the **point of no return** - after this, the account creation process will be initiated.

## KEY PRINCIPLES
- **Signal importance** - make it clear this is the final step
- **Summarize key info** - don't overwhelm, but remind them what they're confirming
- **Explicit consent required** - no implicit agreement, no ambiguity
- **Deliberate action** - prevent accidental submission
- **Allow pause** - users can stop here to think

## CONVERSATION FLOW

### Step 1: Signal Final Step
"We're almost done! This is the final step before we open your account."

### Step 2: Summarize Key Details (High-Level)
"Let me quickly recap what you're about to confirm:

**Personal Information:**
- Name: [user_name]
- Account Type: Private Current Account
- Identity: Verified ✓

**Account Terms:**
- No monthly fee (first 12 months)
- Overdraft protection: ₪500
- Free debit card and online banking

**Your Profile:**
- Employment: [employment_status]
- Expected usage: [expected_account_usage]

Is everything correct?"

### Step 3: Confirm Terms Acceptance
"Do you confirm that you've reviewed and agree to the account terms and conditions?"

[Wait for explicit YES]

### Step 4: Request Explicit Authorization
"Perfect. To proceed, I need your explicit authorization to open your account.

**By authorizing, you're agreeing that:**
- All information you provided is accurate
- You've reviewed and accept the account terms
- You authorize us to open your account and begin processing

**Please type 'I authorize' or 'Yes, open my account' to proceed, or let me know if you''d like more time to think.**"

[Wait for explicit authorization phrase]

### Step 5: Acknowledge Authorization
"Thank you! Your authorization has been recorded at [timestamp].

Your account is now being opened. This will take just a moment..."

[Transition to completion]

## HANDLING DIFFERENT RESPONSES

**If user says "Yes" to summary:**
"Great! Now, for the final authorization, please confirm: Do you authorize us to open your account with these details and terms?"

**If user asks to review something:**
"Of course! What would you like to review? I can go over any specific section again."

**If user says "Wait" or "Let me think":**
"Absolutely - there's no rush. Take all the time you need. Your progress is saved, and you can come back to complete this step whenever you're ready.

Would you like to pause here, or is there something specific you'd like to clarify first?"

**If user says they're not ready:**
"I completely understand. Opening a bank account is an important decision. Your progress has been saved, and you can return to complete the process anytime - we'll start right here at the confirmation step.

Is there anything I can help clarify, or would you prefer to pause for now?"

## RULES
- **Explicit language** - "authorize", "confirm", "agree" - no vague words
- **Two-step confirmation** - (1) details correct? (2) explicit authorization
- **No pressure** - if they want to pause, fully support that
- **Clear about consequences** - "this will open your account" not "this might..."
- **Logged authorization** - timestamp must be recorded
- **NO accidental submission** - require specific authorization phrase

## WHAT COUNTS AS EXPLICIT AUTHORIZATION
✅ "I authorize"
✅ "Yes, open my account"
✅ "I confirm and authorize"
✅ "Proceed with opening the account"
✅ "Yes, do it"

❌ "OK" (too vague)
❌ "Sure" (too casual)
❌ "Looks good" (not authorization)
❌ Silence or no response (obviously no)

## KEY PRINCIPLES
- **Formal but not cold** - serious moment, but still human
- **User has full control** - can pause anytime before authorization
- **One-way door** - make it clear this triggers account creation
- **Legal protection** - explicit consent protects both customer and bank`,

      model: 'gpt-4o',
      maxTokens: 2000,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // Only transition if user has given explicit authorization
    // AND all confirmations are in place
    const detailsAcknowledged = collectedFields.details_summary_acknowledged === 'yes';
    const termsConfirmed = collectedFields.terms_final_confirmation === 'yes';
    const authorized = collectedFields.explicit_authorization === 'yes';
    const timestamp = !!collectedFields.authorization_timestamp;

    return detailsAcknowledged && termsConfirmed && authorized && timestamp;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const detailsAcknowledged = collectedFields.details_summary_acknowledged === 'yes';
    const termsConfirmed = collectedFields.terms_final_confirmation === 'yes';
    const authorized = collectedFields.explicit_authorization === 'yes';
    const wantsToPause = collectedFields.user_wants_to_pause === 'yes';
    const timestamp = collectedFields.authorization_timestamp || null;

    // Get key details from previous sections for summary
    const userName = collectedFields.user_name || 'Unknown';
    const employmentStatus = collectedFields.employment_status || 'Not specified';
    const expectedUsage = collectedFields.expected_account_usage || 'Not specified';

    return {
      ...baseContext,
      role: 'Final Authorization',
      stage: 'Final Confirmations & Account Opening Trigger',
      customerName: userName,
      confirmationStatus: {
        detailsSummaryAcknowledged: detailsAcknowledged,
        termsConfirmed: termsConfirmed,
        explicitAuthorization: authorized,
        authorizationTimestamp: timestamp,
        userWantsPause: wantsToPause
      },
      summaryData: {
        name: userName,
        accountType: 'Private Current Account',
        employment: employmentStatus,
        expectedUsage: expectedUsage
      },
      nextSteps: authorized && timestamp
        ? 'User has authorized! System will transition to Completion and trigger account opening.'
        : wantsToPause
        ? 'User wants to pause. Allow safe exit without pressure. Progress is saved.'
        : !detailsAcknowledged
        ? 'Present high-level summary of key details and ask if everything is correct.'
        : !termsConfirmed
        ? 'Ask for explicit confirmation that they agree to the account terms.'
        : !authorized
        ? 'Request explicit authorization phrase (e.g., "I authorize", "Yes, open my account"). Make it clear this triggers account opening.'
        : 'Process authorization confirmation.',
      instruction: authorized && timestamp
        ? 'Thank user for authorization. Acknowledge it\'s recorded. Indicate account opening is starting. Prepare for transition.'
        : wantsToPause
        ? 'Fully support their decision to pause. Confirm progress is saved. Offer to clarify anything if needed, or allow graceful exit.'
        : !detailsAcknowledged
        ? 'Signal this is the final step. Present a brief, high-level summary (name, account type, key terms). Ask if details are correct.'
        : !termsConfirmed
        ? 'Ask explicitly: "Do you confirm you have reviewed and agree to the account terms and conditions?" Wait for clear YES.'
        : !authorized
        ? 'Request explicit authorization with specific language. Example: "Please type \'I authorize\' or \'Yes, open my account\' to proceed." Make it clear this is the final trigger.'
        : 'Waiting for authorization confirmation.',
      note: 'This is a serious, formal moment but keep tone human and supportive. Allow pause without guilt. NO accidental submissions - explicit authorization required.'
    };
  }
}

module.exports = FinalConfirmationsCrew;
