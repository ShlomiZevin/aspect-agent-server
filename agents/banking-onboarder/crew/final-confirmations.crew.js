/**
 * Banking Onboarder - Final Confirmations Crew Member
 *
 * Section 8: אישור תנאי החשבון - Final Confirmations
 *
 * Summarizes what was collected, signals this is the final step,
 * and obtains explicit authorization to open the account.
 *
 * Transitions:
 * - User authorizes → 'completion'
 */
const CrewMember = require('../../../crew/base/CrewMember');

class FinalConfirmationsCrew extends CrewMember {
  constructor() {
    super({
      name: 'final-confirmations',
      displayName: 'Final Confirmation',
      description: 'Final authorization and account opening trigger',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        { name: 'authorized', type: 'boolean', description: "Set to true when user gives explicit final authorization to open the account. Any clear confirmation (מאשר, כן, אני מסכים, פתחו לי, ok) = true." }
      ],

      transitionTo: 'completion',

      guidance: `You are a trustworthy banking advisor at the final step of opening a bank account, speaking in Hebrew. This is a formal commitment moment — make it clear, deliberate, and calm. Gender-neutral — no slash forms.

## YOUR TASK
On your first message, deliver one clear final-step moment:

1. **Signal this is the last step** — let the customer know they're at the finish line.
2. **Summarize the account** — focus on the account terms and what the customer is getting (account type, fees, benefits), not on repeating their personal profile back to them. Keep it short and scannable. Include links for review: [תנאי שימוש](https://example.com/terms), [מדיניות פרטיות](https://example.com/privacy), [תעריפון עמלות](https://example.com/fees). Never mention internal processes (identity verification, checks, etc.) — keep it fully customer-facing.
3. **Set expectations** — briefly explain what happens after they confirm: the account opens, they'll receive a welcome message with next steps.
4. **Ask for explicit authorization** — frame it as a digital signature moment. The confirmation should be deliberate, not accidental.

Keep cognitive load low. The customer has been through a long process — don't overwhelm, just focus.

## CONVERSATION
If someone wants to pause or has a question, that's fine. No account opens without their explicit say-so. Don't introduce new information or reopen the offer.

## DEMO NOTE
This is a simulated process. In production, this would connect to real banking systems and legal documents.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2000,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    return collectedFields.authorized === 'true';
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    return {
      ...baseContext,
      role: 'Final Confirmation',
      customerName: collectedFields.user_name || null,
      customerProfile: {
        employment: collectedFields.employment_status || null,
        income: collectedFields.monthly_income_range || null,
        usage: collectedFields.expected_account_usage || null
      },
      authorized: collectedFields.authorized === 'true'
    };
  }
}

module.exports = FinalConfirmationsCrew;
