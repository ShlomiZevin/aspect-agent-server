/**
 * Banking Onboarder - KYC Crew Member
 *
 * Section 5: KYC - Know Your Customer
 *
 * Performs automated KYC (Know Your Customer) checks including sanctions screening,
 * PEP (Politically Exposed Person) checks, and risk indicators.
 * This is a non-negotiable regulatory requirement.
 *
 * Transitions:
 * - If all KYC checks pass → 'profile-enrichment'
 * - If any KYC check fails → End journey with clear explanation and alternative channel
 */
const CrewMember = require('../../../crew/base/CrewMember');

class KYCCrew extends CrewMember {
  constructor() {
    super({
      name: 'kyc',
      displayName: 'KYC Verification',
      description: 'Know Your Customer compliance checks',
      isDefault: false,

      fieldsToCollect: [
        {
          name: 'kyc_checks_initiated',
          description: "Set to 'yes' when KYC checks have been started. This indicates system is running background checks."
        },
        {
          name: 'sanctions_check',
          description: "Result of sanctions list screening. Set to 'pass' if clear, 'fail' if found on sanctions list, 'pending' if not yet completed. FOR DEMO: Extract 'pass' for any user whose name does NOT contain 'sanction' or 'blocked', otherwise 'fail'."
        },
        {
          name: 'pep_check',
          description: "PEP (Politically Exposed Person) check result. Set to 'pass' if not a PEP, 'fail' if identified as PEP, 'pending' if not yet completed. FOR DEMO: Extract 'pass' for all users (PEP would require enhanced due diligence, not automatic failure)."
        },
        {
          name: 'risk_assessment',
          description: "Overall risk assessment result. Set to 'low', 'medium', 'high', or 'pending'. FOR DEMO: Set to 'low' for standard customers. High risk would require manual review."
        },
        {
          name: 'kyc_decision',
          description: "Final KYC decision. Set to 'approved' if all checks pass and risk acceptable, 'declined' if any critical check fails, 'manual_review' if requires human review, 'pending' if checks not complete."
        }
      ],

      transitionTo: 'profile-enrichment',

      guidance: `You are a professional banking assistant guiding customers through the KYC (Know Your Customer) verification process.

## YOUR PURPOSE
Inform customers about the automated compliance checks being performed and communicate results clearly. KYC is a mandatory regulatory requirement for all bank accounts.

## WHAT IS KYC
KYC (Know Your Customer) is a set of automated checks that banks must perform to:
- Verify customer identity
- Screen against sanctions lists
- Identify politically exposed persons (PEPs)
- Assess risk factors
- Comply with anti-money laundering (AML) regulations

These checks are:
- **Automated** - run by secure systems
- **Standard practice** - required by law
- **Non-negotiable** - cannot be skipped or bypassed
- **Fast** - usually complete in seconds

## CONVERSATION FLOW

### Step 1: Explain KYC Process
"Perfect! Your identity is verified. Now I'll run some standard regulatory checks. These are automated compliance checks that every bank must perform - they take just a moment.

I'm checking:
- Sanctions list screening
- Regulatory compliance indicators
- Risk assessment

This will only take a few seconds..."

### Step 2: Running Checks (Simulate Processing)
[Brief pause for realism]

"Checks are running..."

### Step 3: Communicate Results

**If ALL checks PASS (most common):**
"Excellent! All regulatory checks have been completed successfully. Your application meets all compliance requirements, and we can proceed with building your financial profile."

**If ANY check FAILS:**
"Thank you for your patience. Our automated compliance checks have identified that we're unable to proceed with this digital account opening at this time.

This doesn't necessarily mean there's an issue - it may indicate that your application requires **additional review** by our compliance team.

To proceed, please:
- **Visit a branch:** Our team can conduct a detailed review and assist you in person
- **Call us:** Speak with a specialist at [phone number]
- **More information:** You'll receive an email with specific next steps

Your information is secure, and we appreciate your understanding of these regulatory requirements."

### Step 4: Handle Questions

**If customer asks why they failed:**
"For security and privacy reasons, I cannot provide specific details about compliance checks. However, our branch team or specialists can review your situation in detail and provide more information. This is standard banking practice to protect customer privacy."

**If customer disputes the result:**
"I understand your concern. These checks are automated and required by law. If you believe there's been an error, our compliance team can review your case. Please visit a branch or call us so they can look into this for you."

## RULES
- Use **neutral, factual language** - not emotional or judgmental
- Present KYC as a **standard regulatory step** - not as evaluation or suspicion
- **Don't suggest** the customer did something wrong
- **Don't expose** internal KYC logic, thresholds, or specific reasons for failure
- **Don't allow retry** - KYC decision is automated and final
- Be **clear and definitive** about the outcome
- Offer **clear alternatives** when KYC fails

## KYC SIMULATION LOGIC (FOR DEMO)
In this demo environment:
- **Sanctions check:** PASS for all users unless name contains "sanction" or "blocked"
- **PEP check:** PASS for all users (PEPs get flagged for enhanced due diligence, not auto-declined)
- **Risk assessment:** LOW for standard customers
- **Overall decision:** APPROVED if all checks pass

**In production:** These would be real API calls to compliance services (e.g., Dow Jones, World-Check, OFAC lists, etc.)

## KEY PRINCIPLES
- **Transparency** about what's being checked
- **Speed** - don't create unnecessary anxiety with long delays
- **Clarity** on outcomes
- **Respect** for the process and the customer
- **Clear next steps** when checks don't pass`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // Only transition if KYC checks are complete and approved
    const kycDecision = collectedFields.kyc_decision;

    return kycDecision === 'approved';
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const checksInitiated = collectedFields.kyc_checks_initiated === 'yes';
    const sanctionsCheck = collectedFields.sanctions_check || 'pending';
    const pepCheck = collectedFields.pep_check || 'pending';
    const riskAssessment = collectedFields.risk_assessment || 'pending';
    const kycDecision = collectedFields.kyc_decision || 'pending';

    const allChecksComplete = sanctionsCheck !== 'pending' && pepCheck !== 'pending' && riskAssessment !== 'pending';
    const anyCheckFailed = sanctionsCheck === 'fail' || pepCheck === 'fail' || riskAssessment === 'high';
    const allChecksPassed = sanctionsCheck === 'pass' && pepCheck === 'pass' && riskAssessment === 'low';

    // Get user name from previous sections
    const userName = collectedFields.user_name || null;

    // Simulate KYC decision based on check results
    let simulatedDecision = 'pending';
    if (allChecksComplete) {
      if (anyCheckFailed) {
        simulatedDecision = 'declined';
      } else if (allChecksPassed) {
        simulatedDecision = 'approved';
      } else {
        simulatedDecision = 'manual_review';
      }
    }

    return {
      ...baseContext,
      role: 'KYC Compliance Verification',
      stage: 'Know Your Customer Checks',
      customerName: userName,
      kycStatus: {
        initiated: checksInitiated,
        sanctionsCheck: sanctionsCheck,
        pepCheck: pepCheck,
        riskAssessment: riskAssessment,
        finalDecision: kycDecision
      },
      simulatedDecision: simulatedDecision,
      nextSteps: !checksInitiated
        ? 'Explain KYC process and initiate checks.'
        : !allChecksComplete
        ? 'Simulate running checks (brief pause for realism), then mark as complete.'
        : kycDecision === 'approved'
        ? 'All checks passed! System will transition to Profile Enrichment.'
        : kycDecision === 'declined' || anyCheckFailed
        ? 'KYC checks did not pass. Explain limitation clearly and provide alternative channels. End journey.'
        : 'Process KYC results and communicate outcome.',
      instruction: !checksInitiated
        ? 'Explain that automated compliance checks will now run. This is standard for all accounts. Make it sound routine and quick.'
        : !allChecksComplete
        ? 'Simulate processing (you can say "running checks..."). Then mark all checks as complete based on simulation logic.'
        : kycDecision === 'approved'
        ? 'Congratulate the customer! All compliance checks passed. Ready to proceed.'
        : kycDecision === 'declined' || anyCheckFailed
        ? 'Explain that compliance checks require additional review. Do NOT provide specific failure reasons. Offer alternative channels (branch, phone). Be respectful and clear.'
        : 'Communicate KYC outcome based on check results.',
      demoNote: 'KYC SIMULATION: For demo, all standard customers pass. Sanctions check fails only if name contains "sanction" or "blocked". In production, this would call real compliance APIs.'
    };
  }
}

module.exports = KYCCrew;
