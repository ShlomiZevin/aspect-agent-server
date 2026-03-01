/**
 * Banking Onboarder - KYC Crew Member
 *
 * Section 5: KYC - Know Your Customer
 *
 * Performs automated KYC checks (simulated for demo).
 * In demo: all standard customers pass automatically.
 * Crew delivers result message, user confirms to continue.
 *
 * Transitions:
 * - If user confirms → 'profile-enrichment'
 */
const CrewMember = require('../../../crew/base/CrewMember');

class KYCCrew extends CrewMember {
  constructor() {
    super({
      name: 'kyc',
      displayName: 'KYC Verification',
      description: 'Know Your Customer compliance checks',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        {
          name: 'kyc_approved',
          type: 'boolean',
          description: "Set to true when user confirms they want to continue after KYC results. Any confirmation (yes, כן, נמשיך, בסדר, מאשר, ok) = true."
        }
      ],

      transitionTo: 'profile-enrichment',

      guidance: `You are a professional banking assistant guiding customers through the KYC (Know Your Customer) verification process.

## YOUR PURPOSE
Inform customers that automated compliance checks passed and guide them to the next step.

## CONVERSATION FLOW

### First message - deliver KYC results:

"מעולה! כל הבדיקות הושלמו בהצלחה ✅

השלב הבא – כמה שאלות קצרות על העיסוק וההכנסה שלך, כדי שנוכל להמליץ לך על האפשרויות שהכי מתאימות לך.

נמשיך?"

### If user confirms → system will transition automatically.

### If user has questions → answer briefly, then ask again to continue.

## RULES
- **Gender-neutral self-reference** - Never expose your gender. No slash forms (מבין/ה). Use neutral phrasing.
- Do NOT list which checks were performed (sanctions, compliance, risk, etc.) - just confirm everything passed
- Use **neutral, factual language** - not emotional or judgmental
- Present KYC as a **standard regulatory step** - not as evaluation or suspicion
- Keep responses **short** (2-3 sentences)

## DEMO NOTE
In this demo, all customers pass KYC automatically. In production, these would be real API calls to compliance services.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const approved = collectedFields.kyc_approved === 'true';

    if (approved) {
      await this.writeContext('kyc_results', {
        approved: true,
        completedAt: new Date().toISOString()
      }, true);

      await this.mergeContext('onboarding_profile', {
        kycCompleted: true,
        currentStep: 'profile-enrichment'
      }, true);

      console.log('   ✅ KYC approved, transitioning to profile-enrichment');
    }

    return approved;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const approved = collectedFields.kyc_approved === 'true';
    const userName = collectedFields.user_name || null;

    return {
      ...baseContext,
      role: 'KYC Compliance Verification',
      customerName: userName,
      kycApproved: approved,
      instruction: approved
        ? 'User confirmed. System will transition.'
        : 'Deliver KYC results (all checks passed) and ask user to continue. Do NOT list individual checks.',
      demoNote: 'All customers pass KYC in demo. In production, real compliance API calls.'
    };
  }
}

module.exports = KYCCrew;
