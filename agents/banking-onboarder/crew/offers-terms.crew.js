/**
 * Banking Onboarder - Offers & Terms Crew Member
 *
 * Section 7: המלצות - Offers, Account Terms & Conditional Negotiation
 *
 * Presents account terms and offers clearly. Negotiation is used ONLY when:
 * - User explicitly raises a concern or objection
 * - System identifies a clear blocker to continuation
 *
 * Negotiation is a problem-solving tool, not a sales tactic.
 *
 * Transitions:
 * - If user accepts terms (with or without negotiation) → 'final-confirmations'
 * - If objection persists after negotiation → End journey without pressure
 */
const CrewMember = require('../../../crew/base/CrewMember');

class OffersTermsCrew extends CrewMember {
  constructor() {
    super({
      name: 'offers-terms',
      displayName: 'Account Terms & Offers',
      description: 'Account terms presentation and conditional negotiation',
      isDefault: false,

      fieldsToCollect: [
        {
          name: 'terms_presented',
          description: "Set to 'yes' when account terms and offers have been presented to the user"
        },
        {
          name: 'user_response_to_terms',
          description: "User's response: 'accepted' if they agree and want to proceed, 'objection' if they raise concerns or hesitations, 'declined' if they clearly refuse, 'questions' if asking for clarification without deciding yet"
        },
        {
          name: 'specific_objection',
          description: "If user raised an objection, extract what specifically concerns them (e.g., 'monthly fee too high', 'overdraft limit too low', 'interest rate', etc.)"
        },
        {
          name: 'negotiation_triggered',
          description: "Set to 'yes' if negotiation path was activated due to objection, otherwise 'no'"
        },
        {
          name: 'negotiation_outcome',
          description: "If negotiation occurred: 'resolved' if user accepted after adjustment, 'unresolved' if objection persists, 'pending' if still in negotiation"
        },
        {
          name: 'final_terms_accepted',
          description: "Set to 'yes' only when user has given explicit final acceptance to proceed with the account opening"
        }
      ],

      transitionTo: 'final-confirmations',

      guidance: `You are a professional banking assistant presenting account terms and helping customers make an informed decision.

## YOUR PURPOSE
Present account terms and offers clearly and neutrally. Help customers understand what they're getting. Use negotiation ONLY when necessary to remove genuine blockers.

## KEY PRINCIPLE: NEGOTIATION IS OPTIONAL
- **Default path:** Present terms → User accepts → Continue
- **Negotiation path:** ONLY triggered by explicit objection or clear hesitation
- Do NOT proactively offer negotiation
- Do NOT frame negotiation as expected behavior
- Treat it as a **problem-solving tool**, not a sales tactic

## CONVERSATION FLOW

### Step 1: Present Terms & Offers
"Excellent! Based on your profile, here's what we can offer you:

**Account Type:** Private Current Account

**Key Features:**
- No monthly maintenance fee for first 12 months
- Free debit card and online/mobile banking
- Overdraft protection up to $500 (subject to approval)
- 24/7 customer support
- Integration with budgeting tools

**Standard Terms:**
- Monthly fee after 12 months: $5 (waived if monthly direct deposit > $1000)
- ATM withdrawals: Free at our network, $2 fee at others
- International transactions: 2.5% foreign exchange fee
- Minimum balance: None

**This offer is personalized based on your profile and typical for your account type.**

Does this work for you? Any questions before we proceed?"

### Step 2: Handle Response

**If USER ACCEPTS immediately:**
"Perfect! Let's move forward to the final confirmation step."

**If USER ASKS QUESTIONS (without objecting):**
Answer clearly and factually. Don't trigger negotiation. After answering: "Does that address your question? Ready to proceed?"

**If USER RAISES OBJECTION or HESITATION:**
This triggers the **conditional negotiation path**.

## NEGOTIATION PATH (Only When Triggered)

### Step 1: Acknowledge & Understand
"I understand your concern about [specific issue]. Let me see what we can do to address that."

### Step 2: Offer Adjustment (If Possible)
Examples:
- **Fee concern:** "For customers in your profile, we can waive the monthly fee indefinitely if you set up a direct deposit of $500/month. Would that work better?"
- **Overdraft limit concern:** "Based on your income range, we can increase your overdraft limit to $1000. Would that be more suitable?"
- **International fee concern:** "If you travel frequently, we have a premium tier with no foreign exchange fees for $10/month. Over 4 international transactions/month, that saves you money."

### Step 3: Confirm Resolution
"Would that adjustment address your concern? Are you comfortable moving forward with these updated terms?"

**If YES - objection resolved:**
"Great! Let's proceed with these terms."

**If NO - objection persists:**
"I understand. This particular term is part of our standard account structure. If this doesn't work for you, you might want to:
- Explore our other account types (visit a branch or call us)
- Consider whether the other benefits still make this worthwhile
- Take time to think it over

There's no pressure - what would you prefer to do?"

## RULES FOR NEGOTIATION
- **Don't initiate proactively** - wait for clear objection
- **Be genuine** - only offer adjustments that are realistic
- **One negotiation cycle** - offer adjustment, get response, then accept decision
- **No pressure** - respect if they still decline after adjustment
- **Clear alternatives** - always provide exit option without guilt

## WHEN NOT TO NEGOTIATE
❌ User asks a clarification question → Just answer
❌ User says "let me think" → Give them space
❌ User accepts immediately → Don't reopen discussion
❌ User has no objection → Don't create artificial tension

## WHEN TO NEGOTIATE
✅ User says "the fee is too high"
✅ User expresses disappointment about a specific term
✅ User says "I was hoping for..." or "I expected..."
✅ System detects dropout pattern (user keeps delaying decision)

## KEY PRINCIPLES
- **Clarity over persuasion** - make terms crystal clear
- **User control** - they drive the pace
- **No manipulation** - negotiation is problem-solving, not tactics
- **Respect decline** - if they don't want it, that's valid`,

      model: 'gpt-4o',
      maxTokens: 2000,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // Only transition if user has given final acceptance
    return collectedFields.final_terms_accepted === 'yes';
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const termsPresented = collectedFields.terms_presented === 'yes';
    const userResponse = collectedFields.user_response_to_terms || 'pending';
    const hasObjection = collectedFields.specific_objection ? true : false;
    const negotiationTriggered = collectedFields.negotiation_triggered === 'yes';
    const negotiationOutcome = collectedFields.negotiation_outcome || 'pending';
    const finalAccepted = collectedFields.final_terms_accepted === 'yes';

    const userName = collectedFields.user_name || null;

    return {
      ...baseContext,
      role: 'Account Terms & Offers',
      stage: 'Terms Presentation & Conditional Negotiation',
      customerName: userName,
      status: {
        termsPresented: termsPresented,
        userResponse: userResponse,
        objectionRaised: hasObjection,
        objectionDetails: collectedFields.specific_objection || 'None',
        negotiationActive: negotiationTriggered,
        negotiationOutcome: negotiationOutcome,
        finalAcceptance: finalAccepted
      },
      nextSteps: finalAccepted
        ? 'User accepted! System will transition to Final Confirmations.'
        : !termsPresented
        ? 'Present account terms and offers clearly and neutrally.'
        : userResponse === 'accepted'
        ? 'User accepted without objection - ready to proceed!'
        : userResponse === 'questions'
        ? 'User has questions - answer them clearly without triggering negotiation unless they object.'
        : userResponse === 'objection' && !negotiationTriggered
        ? 'User raised objection. Activate negotiation path - acknowledge concern and offer adjustment if possible.'
        : negotiationTriggered && negotiationOutcome === 'pending'
        ? 'In negotiation - wait for user response to proposed adjustment.'
        : negotiationTriggered && negotiationOutcome === 'resolved'
        ? 'Negotiation succeeded! User accepted adjusted terms. Confirm final acceptance.'
        : negotiationTriggered && negotiationOutcome === 'unresolved'
        ? 'Negotiation did not resolve objection. Offer alternatives (branch visit, think it over) and allow graceful exit without pressure.'
        : 'Handle user response to terms.',
      instruction: !termsPresented
        ? 'Present the account terms, features, and fees clearly. Make it neutral and informative - not a sales pitch. Ask if they have questions or are ready to proceed.'
        : userResponse === 'accepted' && !finalAccepted
        ? 'User accepted! Confirm their acceptance and mark final_terms_accepted as yes.'
        : userResponse === 'questions'
        ? 'Answer their questions clearly and factually. Don\'t trigger negotiation unless they express concern or objection.'
        : userResponse === 'objection' && !negotiationTriggered
        ? 'Acknowledge their concern. Identify the specific issue. Offer a realistic adjustment if possible (e.g., fee waiver with direct deposit, higher limit, etc.). This is problem-solving, not pressure.'
        : negotiationTriggered && negotiationOutcome === 'resolved'
        ? 'Objection was resolved! Confirm they\'re happy with adjusted terms and get final acceptance.'
        : negotiationTriggered && negotiationOutcome === 'unresolved'
        ? 'User still has concerns after negotiation. Respect their decision. Offer alternatives (branch, call, think it over). Do NOT pressure. End journey supportively if they decline.'
        : 'Waiting for user decision on terms.',
      note: 'Negotiation is OPTIONAL and CONDITIONAL - only use when there\'s a clear blocker. Default path is present → accept → continue. Don\'t manufacture objections or pressure users.'
    };
  }
}

module.exports = OffersTermsCrew;
