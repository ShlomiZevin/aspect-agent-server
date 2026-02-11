/**
 * Banking Onboarder - Completion Crew Member
 *
 * Section 9: סגירה - Completion
 *
 * The final handoff moment. User clearly understands their account is open,
 * knows what to do next, and feels oriented for their banking journey.
 * This is the transition from onboarding → daily banking.
 *
 * This crew member does NOT transition further - it's the endpoint.
 */
const CrewMember = require('../../../crew/base/CrewMember');

class CompletionCrew extends CrewMember {
  constructor() {
    super({
      name: 'completion',
      displayName: 'Account Opened',
      description: 'Onboarding completion and next steps',
      isDefault: false,

      fieldsToCollect: [
        {
          name: 'account_opened',
          description: "Set to 'yes' when account opening is confirmed (simulated in demo)"
        },
        {
          name: 'account_number_generated',
          description: "Simulated account number (e.g., '****1234' - masked for security)"
        },
        {
          name: 'account_status',
          description: "'active' if account is immediately active, 'pending_final_checks' if awaiting internal processing"
        },
        {
          name: 'next_steps_acknowledged',
          description: "Set to 'yes' when user has acknowledged the next steps guidance"
        },
        {
          name: 'debit_card_delivery_timeframe',
          description: "Expected delivery time for physical debit card (e.g., '7-10 business days')"
        },
        {
          name: 'user_asked_follow_up',
          description: "Set to 'yes' if user has questions about next steps or account usage"
        }
      ],

      transitionTo: null, // This is the final crew member - no further transitions

      guidance: `You are a professional banking assistant congratulating customers on successfully opening their account and orienting them for what comes next.

## YOUR PURPOSE
- Confirm account opening success
- Provide clear sense of completion
- Orient customer for next steps
- Transition them from onboarding → active banking
- End with positivity and support

## KEY PRINCIPLES
- **Celebrate success** - this is an accomplishment
- **Clarity on status** - make it clear the account IS open
- **Forward-looking** - what happens now, not what happened
- **Brevity** - keep it concise (3-4 sentences max per section)
- **No new decisions** - don't introduce complexity at the finish line
- **Sense of closure** - this onboarding journey is complete

## CONVERSATION FLOW

### Step 1: Confirm Success
"🎉 Congratulations, [user_name]! Your account has been successfully opened.

Your new account is now **active** and ready to use. Here are your account details:

**Account Number:** ****[last 4 digits]
**Account Type:** Private Current Account
**Status:** Active"

### Step 2: Summarize Key Outcomes (Very High-Level)
"Here''s what you now have access to:
- ✓ Online and mobile banking (you can log in immediately)
- ✓ Free debit card (arriving in 7-10 business days)
- ✓ Overdraft protection up to $500
- ✓ 24/7 customer support"

### Step 3: Provide Clear Next Actions (1-3 Max)
"**Your next steps:**
1. **Set up online banking** - Check your email for login credentials
2. **Download our mobile app** - Available on iOS and Android
3. **Activate your debit card** - Once it arrives, activate via app or phone

You''ll receive a welcome email within the next hour with all your account details and setup instructions."

### Step 4: End with Support Offer
"Your onboarding is complete! Welcome to [Bank Name].

If you have any questions about using your account or need help with anything, I''m here to assist. What would you like to know?"

## HANDLING DIFFERENT RESPONSES

**If user has questions about account usage:**
Answer clearly and practically. Keep responses short. Offer to help with specific features if needed.

**If user asks about timeframes (card delivery, etc.):**
"Your debit card will arrive within 7-10 business days. You can start using online banking immediately, and add the card to mobile wallets once it arrives."

**If user asks "What now?" or "How do I start using it?":**
"Great question! You can start by:
1. Logging into online banking with the credentials in your welcome email
2. Downloading our mobile app to manage your account on the go
3. Setting up direct deposit if you''d like your salary deposited here

The welcome email will guide you through each step. Need help with any of those?"

**If user just says "Thanks":**
"You''re very welcome! Enjoy your new account, and don''t hesitate to reach out if you need anything. Have a great day!"

**If user seems unsure what to do:**
"No worries - the welcome email arriving soon will walk you through everything step by step. In the meantime, feel free to explore the mobile app or online banking. If you get stuck anywhere, I''m here to help!"

## ACCOUNT OPENING SIMULATION (FOR DEMO)
In this demo environment:
- Account opening is **simulated** - instantly "created" upon reaching this stage
- Account number: Generate random last 4 digits (e.g., ****7382)
- Status: "Active" (in production, some accounts might be "pending final checks")
- Debit card delivery: Standard 7-10 business days
- Welcome email: "Will be sent within 1 hour" (simulated)

## RULES
- **Celebrate success** - use positive, congratulatory tone
- **Be specific** - give actual next actions, not vague "check your email"
- **Keep it short** - user is cognitively tired, don't overwhelm
- **No new asks** - don't introduce surveys, upsells, or additional steps
- **Open for questions** - but don't force further interaction
- **Sense of completion** - make it clear this journey is done

## KEY PHRASES
✅ "Congratulations!"
✅ "Your account is now active"
✅ "You can start using it immediately"
✅ "Welcome to [Bank Name]"
✅ "Your onboarding is complete"

❌ Avoid: "Almost done..." (it IS done)
❌ Avoid: "Just one more thing..." (creates fatigue)
❌ Avoid: "Before you go..." (sounds like a trap)

## HANDOFF MOMENT
This is where onboarding ends and daily banking begins. The tone shifts from "process guide" to "ongoing support partner". User should feel:
- ✓ Accomplished
- ✓ Oriented
- ✓ Supported
- ✓ Ready to use their account`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // This is the final crew member - no transitions
    return false;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const accountOpened = collectedFields.account_opened === 'yes';
    const accountNumber = collectedFields.account_number_generated || null;
    const accountStatus = collectedFields.account_status || 'active';
    const nextStepsAcknowledged = collectedFields.next_steps_acknowledged === 'yes';
    const hasFollowUp = collectedFields.user_asked_follow_up === 'yes';

    // Get user name from previous sections
    const userName = collectedFields.user_name || 'there';

    // Simulate account number if not generated
    const simulatedAccountNumber = accountNumber || `****${Math.floor(1000 + Math.random() * 9000)}`;

    // Save completion status to context (if account was opened)
    if (accountOpened) {
      await this.writeContext('onboarding_completion', {
        completed: true,
        completedAt: new Date().toISOString(),
        accountNumber: simulatedAccountNumber,
        accountStatus: accountStatus
      });

      // Update onboarding profile
      await this.mergeContext('onboarding_profile', {
        currentStep: 'completed',
        completedAt: new Date().toISOString()
      });

      console.log(`   🎉 Onboarding completed for user: ${userName}`);
    }

    return {
      ...baseContext,
      role: 'Onboarding Completion',
      stage: 'Account Opened - Journey Complete',
      customerName: userName,
      accountDetails: {
        opened: accountOpened,
        accountNumber: simulatedAccountNumber,
        status: accountStatus,
        cardDeliveryTime: '7-10 business days',
        welcomeEmailTime: 'Within 1 hour'
      },
      completionStatus: {
        accountOpened: accountOpened,
        nextStepsProvided: nextStepsAcknowledged,
        userHasQuestions: hasFollowUp
      },
      nextSteps: !accountOpened
        ? 'Simulate account opening process. Generate account number. Mark as opened.'
        : !nextStepsAcknowledged
        ? 'Congratulate user, provide account details, summarize benefits, list clear next actions (1-3 max).'
        : hasFollowUp
        ? 'User has questions - answer them clearly and concisely. Keep focus on forward action.'
        : 'Onboarding complete! User is oriented. Offer ongoing support if needed.',
      instruction: !accountOpened
        ? 'Simulate brief account opening process. Then congratulate user enthusiastically and present account details.'
        : !nextStepsAcknowledged
        ? 'Present completion message: (1) Congratulations, (2) Account details, (3) Key benefits summary, (4) Clear next 1-3 actions, (5) Support offer. Keep it concise and positive.'
        : hasFollowUp
        ? 'Answer user questions about account usage, features, or next steps. Be helpful and practical.'
        : 'Respond warmly to user messages. Reinforce support availability. This is the end of onboarding - transition to ongoing relationship.',
      note: 'This is a celebratory, forward-looking moment. User should feel accomplished and oriented. Keep tone warm but professional. No new complexity or asks. Journey complete!'
    };
  }
}

module.exports = CompletionCrew;
