/**
 * Banking Onboarder - Identity Verification Crew Member
 *
 * Section 4: אימות זהות - Identity Verification
 *
 * Verifies customer identity through document collection and OTP verification.
 * Keeps the customer calm and informed throughout the process.
 *
 * Transitions:
 * - If identity verified successfully → 'kyc'
 * - If verification fails repeatedly → End journey with alternative guidance
 */
const CrewMember = require('../../../crew/base/CrewMember');

class IdentityVerificationCrew extends CrewMember {
  constructor() {
    super({
      name: 'identity-verification',
      displayName: 'Identity Verification',
      description: 'Identity verification via documents and OTP',
      isDefault: false,

      fieldsToCollect: [
        {
          name: 'id_number',
          description: "User's government-issued ID number (national ID, passport, etc.). Extract the number provided."
        },
        {
          name: 'id_document_uploaded',
          description: "Set to 'yes' when user confirms they have uploaded or provided a photo/scan of their ID document. Set to 'pending' if not yet provided."
        },
        {
          name: 'phone_number',
          description: "User's mobile phone number for OTP verification. Extract in format provided (with or without country code)."
        },
        {
          name: 'otp_sent',
          description: "Set to 'yes' after OTP code has been sent to user's phone. This is a system action confirmation."
        },
        {
          name: 'otp_code',
          description: "The OTP code entered by the user. Extract the numeric code they provide."
        },
        {
          name: 'otp_verified',
          description: "Set to 'success' if OTP verification passed, 'failed' if it failed, 'pending' if not yet attempted."
        },
        {
          name: 'verification_attempt_count',
          description: "Number of OTP verification attempts. Increment each time verification is attempted. Max 3 attempts allowed."
        }
      ],

      transitionTo: 'kyc',

      guidance: `You are a professional banking assistant helping customers verify their identity to proceed with account opening.

## YOUR PURPOSE
Guide customers through identity verification, which includes:
1. Collecting government ID information
2. Receiving ID document photo/scan
3. Verifying identity via OTP (One-Time Password) sent to their mobile phone

## WHY THIS IS NEEDED
Identity verification is a **mandatory regulatory requirement** for opening bank accounts. It helps:
- Prevent fraud and identity theft
- Comply with banking regulations
- Protect both the customer and the bank

## CONVERSATION FLOW

### Step 1: Collect ID Information
"To verify your identity, I'll need a few details:
1. Your government-issued ID number (national ID, passport, or driver's license)
2. A photo or scan of that ID document

Could you please provide your ID number?"

[Wait for response]

"Thank you. Now, please upload a clear photo or scan of your ID document. Make sure all details are visible and readable."

### Step 2: Collect Phone Number for OTP
"Great! Next, I need to verify your phone number. This is a quick security step.

What's the best mobile number to send you a verification code?"

### Step 3: Send OTP
"Perfect! I'm sending a verification code to [phone number] right now. You should receive it within 1-2 minutes.

Please enter the code when you receive it."

### Step 4: Verify OTP Code
[User provides code]

**If verification succeeds:**
"Excellent! Your identity has been verified successfully. We can now proceed with the next step."

**If verification fails (attempt 1-2):**
"The code you entered doesn't match. This can happen if:
- The code was typed incorrectly
- The code expired (they're valid for 10 minutes)

You have [X attempts remaining]. Would you like to try again, or should I send you a new code?"

**If verification fails repeatedly (3 attempts):**
"I apologize, but the verification couldn't be completed after multiple attempts. This can happen due to technical issues or expired codes.

To proceed with opening your account, please:
- Try again later when you have a stable connection
- Visit one of our branches where we can verify your identity in person
- Call our customer service line for assistance

Your progress has been saved, and you can resume from this step."

## RULES
- Keep language **calm and neutral** - this is standard procedure, not a security drama
- **Don't alarm** the customer with security warnings
- **Don't blame** the user for failures - frame as technical or timing issues
- Allow **limited retries** (max 3 attempts)
- Explain **what's happening** at each step
- Keep responses **short and clear** (2-3 sentences)
- Make the process feel **routine and safe**

## OTP VERIFICATION LOGIC (SIMULATED FOR DEMO)
In this demo:
- Any 6-digit code starting with "1" = SUCCESS
- Any 6-digit code starting with "2" or "3" = FAILURE (retry)
- Any other format = Ask user to enter 6-digit code
- After 3 failed attempts = End verification, provide alternatives

**Note:** In production, this would integrate with actual OTP service.

## KEY PRINCIPLES
- **Calm and professional** - reduce anxiety
- **Clear instructions** - tell them exactly what to do
- **Handle failures gracefully** - don't make users feel incompetent
- **Progress preservation** - reassure that work isn't lost`,

      model: 'gpt-4o',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  async preMessageTransfer(collectedFields) {
    // Only transition if:
    // 1. ID info collected
    // 2. ID document uploaded
    // 3. Phone number provided
    // 4. OTP sent and verified successfully

    const hasIdNumber = !!collectedFields.id_number;
    const hasIdDocument = collectedFields.id_document_uploaded === 'yes';
    const hasPhoneNumber = !!collectedFields.phone_number;
    const otpVerified = collectedFields.otp_verified === 'success';

    return hasIdNumber && hasIdDocument && hasPhoneNumber && otpVerified;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const hasIdNumber = !!collectedFields.id_number;
    const hasIdDocument = collectedFields.id_document_uploaded === 'yes';
    const hasPhoneNumber = !!collectedFields.phone_number;
    const otpSent = collectedFields.otp_sent === 'yes';
    const otpCode = collectedFields.otp_code || null;
    const otpVerified = collectedFields.otp_verified || 'pending';
    const attemptCount = parseInt(collectedFields.verification_attempt_count || '0', 10);

    const verificationComplete = otpVerified === 'success';
    const verificationFailed = attemptCount >= 3 && otpVerified !== 'success';

    // Get user name from previous sections
    const userName = collectedFields.user_name || null;

    // Simple OTP simulation logic for demo
    let otpSimulation = null;
    if (otpCode && otpVerified === 'pending') {
      // Simulate OTP check: codes starting with "1" succeed, others fail
      const codeStr = String(otpCode);
      if (codeStr.length === 6 && /^\d+$/.test(codeStr)) {
        otpSimulation = codeStr.startsWith('1') ? 'success' : 'failed';
      }
    }

    return {
      ...baseContext,
      role: 'Identity Verification',
      stage: 'Document Collection & OTP Verification',
      customerName: userName,
      verificationStatus: {
        idNumber: hasIdNumber ? 'Collected' : 'Pending',
        idDocument: hasIdDocument ? 'Uploaded' : 'Pending',
        phoneNumber: hasPhoneNumber ? 'Collected' : 'Pending',
        otpSent: otpSent ? 'Yes' : 'No',
        otpCode: otpCode ? 'Entered' : 'Not entered',
        otpVerification: otpVerified,
        attemptsUsed: `${attemptCount}/3`
      },
      otpSimulationResult: otpSimulation,
      nextSteps: verificationComplete
        ? 'Identity verified successfully! System will transition to KYC checks.'
        : verificationFailed
        ? 'Verification failed after 3 attempts. End journey and provide alternative channels.'
        : !hasIdNumber
        ? 'Request ID number from customer.'
        : !hasIdDocument
        ? 'Request ID document upload (photo/scan).'
        : !hasPhoneNumber
        ? 'Request phone number for OTP verification.'
        : !otpSent
        ? 'Confirm OTP has been sent to phone number.'
        : !otpCode
        ? 'Wait for customer to enter OTP code.'
        : otpVerified === 'failed'
        ? `OTP verification failed (attempt ${attemptCount}/3). Allow retry or send new code.`
        : 'Processing OTP verification...',
      instruction: verificationComplete
        ? 'Congratulate user on successful verification and prepare for transition.'
        : verificationFailed
        ? 'Explain that verification could not be completed. Provide alternative options (branch visit, call support). End journey supportively.'
        : !hasIdNumber || !hasIdDocument
        ? 'Collect ID number and document. Explain why it\'s needed clearly.'
        : !hasPhoneNumber || !otpSent
        ? 'Collect phone number and simulate sending OTP (in demo, just confirm "code sent").'
        : otpVerified === 'failed'
        ? `OTP failed. Explain calmly, offer retry (${3 - attemptCount} attempts remaining) or new code.`
        : 'Guide user through OTP entry. Use simulation logic: codes starting with "1" succeed, others fail.',
      demoNote: 'OTP SIMULATION: For demo purposes, any 6-digit code starting with "1" will succeed (e.g., 123456). Other codes will fail. Max 3 attempts.'
    };
  }
}

module.exports = IdentityVerificationCrew;
