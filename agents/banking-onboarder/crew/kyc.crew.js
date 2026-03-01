/**
 * Banking Onboarder - KYC Crew Member
 *
 * Section 5: KYC - Know Your Customer
 *
 * Performs automated KYC checks (simulated for demo).
 * In demo: all standard customers pass automatically.
 * Delivers result, user acknowledges to continue.
 *
 * Transitions:
 * - User acknowledges → 'profile-enrichment'
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
          name: 'kyc_acknowledged',
          type: 'boolean',
          description: "Set to true when user acknowledges the KYC result and is ready to continue. Any response after the result (כן, בסדר, נמשיך, ok, אחלה, מעולה) = true."
        }
      ],

      transitionTo: 'profile-enrichment',

      guidance: `You are a calm, professional banking advisor running a quick regulatory check in Hebrew. Gender-neutral — no slash forms.

## YOUR TASK
Simulate a short KYC process in one message. Structure it like a real-time status update:

1. Say you're running the check now (e.g., "רגע, מריץ בדיקת תקינות...")
2. Show 2-3 short status lines as if they're completing in real time — things like verifying details against records, confirming eligibility, regulatory clearance. Use ✅ to mark each as done. Keep the language simple and non-technical.
3. Confirm everything passed — short and routine.
4. Briefly mention the next step (a few short questions about employment and income).
5. End with a short prompt to continue — e.g., "נמשיך?" or "מוכנים לשלב הבא?" so the user knows to respond.

The whole thing should feel like a loading screen that resolves — not a formal report. Keep it short and light.

## CONVERSATION
If the user has questions, answer briefly. Don't explain what was checked in detail.

## DEMO NOTE
In this demo, all customers pass KYC automatically. In production, these would be real API calls to compliance services.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    const acknowledged = collectedFields.kyc_acknowledged === 'true';

    if (acknowledged) {
      await this.writeContext('kyc_results', {
        approved: true,
        completedAt: new Date().toISOString()
      }, true);

      await this.mergeContext('onboarding_profile', {
        kycCompleted: true,
        currentStep: 'profile-enrichment'
      }, true);

      console.log('   ✅ KYC acknowledged, transitioning to profile-enrichment');
    }

    return acknowledged;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    return {
      ...baseContext,
      role: 'KYC Compliance Verification',
      customerName: collectedFields.user_name || null,
      kycResult: 'passed',
      demoNote: 'All customers pass KYC in demo. In production, real compliance API calls.'
    };
  }
}

module.exports = KYCCrew;
