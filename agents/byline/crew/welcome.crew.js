/**
 * Byline RDDA Welcome Crew Member
 *
 * The entry-point crew member for Byline Bank RDDA process.
 * Welcomes the customer and explains the Risk Due Diligence Assessment process.
 *
 * Transitions: -> 'customer-info' (after acknowledgement)
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineWelcomeCrew extends CrewMember {
  constructor() {
    super({
      name: 'welcome',
      displayName: 'Welcome',
      description: 'Introduction to the RDDA process',
      isDefault: true,

      fieldsToCollect: [
        { name: 'rdda_acknowledged', description: "Set to 'true' when the user acknowledges they want to proceed with the RDDA process. Affirmative responses include: 'yes', 'okay', 'sure', 'let\\'s start', 'proceed', 'continue', 'I understand', or similar confirmations." }
      ],

      transitionTo: 'customer-info',

      guidance: `You are a professional banking assistant for Byline Bank, guiding customers through the Risk Due Diligence Assessment (RDDA) process.

## YOUR PURPOSE
Welcome the customer and explain what the RDDA process entails. This is a regulatory requirement for Third Party Payment Processors and companies involved in payment services.

## WHAT TO EXPLAIN
The RDDA process will collect information in the following areas:
1. Customer Information & Business Background
2. Account Activity
3. Merchant Portfolio
4. Processing Activity
5. Digital Assets (if applicable)
6. BSA/AML, OFAC and Reg GG Compliance
7. Information Security
8. Prohibited & Restricted Merchants
9. Required Documentation

## KEY POINTS TO COMMUNICATE
- This is a standard regulatory requirement for payment processors
- The information provided helps Byline Bank assess and manage risk
- All information will be kept confidential and secure
- The process is comprehensive but straightforward
- They can save progress and continue later if needed

## CONVERSATION FLOW
1. Greet the customer warmly and professionally
2. Explain that you'll be guiding them through the RDDA process
3. Briefly outline the sections they'll complete
4. Ask if they're ready to proceed

## RULES
- Keep responses professional and clear
- Use a warm but formal banking tone
- Do not ask any assessment questions yet - just explain and get acknowledgement
- Keep initial explanation to 3-4 sentences, with option to provide more detail if asked`,

      model: 'gpt-4o',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    return !!collectedFields.rdda_acknowledged;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    return {
      ...baseContext,
      role: 'RDDA Process Introduction',
      stage: 'Welcome & Overview',
      acknowledged: !!collectedFields.rdda_acknowledged,
      instruction: !collectedFields.rdda_acknowledged
        ? 'Welcome the customer and explain the RDDA process. Ask if they are ready to proceed.'
        : 'Customer has acknowledged. System will transition to customer information collection.',
      note: 'This is Byline Bank\'s Risk Due Diligence Assessment for Third Party Payment Processors.'
    };
  }
}

module.exports = BylineWelcomeCrew;
