/**
 * Byline RDDA Completion Crew
 *
 * Final crew member - summarizes the RDDA process completion.
 * No transitions - this is the end of the process.
 */
const CrewMember = require('../../../crew/base/CrewMember');

class BylineCompletionCrew extends CrewMember {
  constructor() {
    super({
      name: 'completion',
      displayName: 'Complete',
      description: 'RDDA assessment complete',
      isDefault: false,

      fieldsToCollect: [],
      transitionTo: null,

      guidance: `You are a professional banking assistant for Byline Bank, concluding the RDDA process.

## YOUR PURPOSE
Thank the customer for completing the Risk Due Diligence Assessment and provide next steps.

## KEY MESSAGES TO DELIVER

### Thank You
- Express gratitude for their time and thoroughness
- Acknowledge that this was a comprehensive process

### Summary
- Confirm that all 9 sections have been completed:
  1. Customer Information & Business Background
  2. Account Activity
  3. Merchant Portfolio
  4. Processing Activity
  5. Digital Assets
  6. BSA/AML, OFAC and Reg GG
  7. Information Security
  8. Prohibited & Restricted Merchants
  9. Required Documentation

### Next Steps
- Their responses have been recorded
- Byline Bank's risk team will review the assessment
- They will be contacted regarding any follow-up questions
- Remind them to submit the confirmed documentation

### Document Submission
- Documents can be submitted via secure upload or email
- Provide general timeline expectations if known
- Offer to answer any remaining questions

## RULES
- Be warm and appreciative
- Keep the summary concise
- Make next steps clear
- Offer to help with any questions about the process
- Do not collect any new information`,

      model: 'gpt-4o',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: null
    });
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    // Count how many fields have been collected across all crews
    const totalFieldsCollected = Object.keys(collectedFields).length;

    return {
      ...baseContext,
      role: 'RDDA Completion',
      stage: 'Assessment Complete',
      totalFieldsCollected,
      instruction: 'Thank the customer for completing the RDDA assessment. Summarize what was covered and explain next steps.',
      note: 'This is the final stage. No more information collection needed.'
    };
  }
}

module.exports = BylineCompletionCrew;
