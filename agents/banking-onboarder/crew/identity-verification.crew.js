/**
 * Banking Onboarder - Identity Verification Crew Member
 *
 * Section 4: אימות זהות - Identity Verification
 *
 * Verifies customer identity through OTP, document collection, and face verification.
 * All verification steps are simulated for demo purposes.
 *
 * Flow: Phone → OTP → ID number → ID document → Face verification
 *
 * Transitions:
 * - If all verified → 'kyc'
 * - If OTP fails 3 times → End journey with alternative guidance
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../banking-onboarder-persona');

class IdentityVerificationCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'identity-verification',
      displayName: 'Identity Verification',
      description: 'Identity verification via OTP, documents, and face scan',
      isDefault: false,
      extractionMode: 'form',

      fieldsToCollect: [
        {
          name: 'phone_number',
          description: "User's mobile phone number for OTP verification. Extract in format provided."
        },
        {
          name: 'otp_code',
          description: "The OTP code entered by the user. Extract the numeric code exactly as typed."
        },
        {
          name: 'id_number',
          description: "User's government-issued ID number (ת\"ז, passport, driver's license). Extract the number."
        },
        {
          name: 'id_document_uploaded',
          type: 'boolean',
          description: "SIMULATED: Set to true when user confirms they uploaded/provided their ID photo. Any confirmation = true."
        },
        {
          name: 'face_verified',
          type: 'boolean',
          description: "SIMULATED: Set to true when user confirms they completed the selfie/face scan. Any confirmation = true."
        }
      ],

      transitionTo: 'kyc',

      guidance: `You are a professional banking assistant helping customers verify their identity to proceed with account opening.

## YOUR PURPOSE
Guide customers through identity verification. All steps are simulated for demo.

## CONVERSATION FLOW

### Step 1: Collect Phone Number
"מעולה! נתחיל עם אימות מהיר של מספר הטלפון שלך. מה המספר הנייד שלך?"

### Step 2: Send & Verify OTP
After receiving phone number, immediately confirm OTP was sent:
"שלחתי קוד אימות ל-[מספר]. הקוד הוא בן **6 ספרות** ויגיע תוך דקה-שתיים. הזן את הקוד כשתקבל אותו."

**Success:** "מצוין! הטלפון אומת בהצלחה."
**Fail (retry):** "הקוד לא תואם. נשארו [X] ניסיונות. רוצה לנסות שוב?"
**Fail (3 attempts):** "לא הצלחנו להשלים את האימות. אפשר לפנות לסניף: 📞 03-9999999"

### Step 3: Collect ID Number (after OTP success)
"עכשיו צריך את מספר תעודת הזהות שלך (ת\\"ז, דרכון או רישיון נהיגה)."

### Step 4: ID Document Upload (simulated)
"תודה! עכשיו צריך תמונה ברורה של התעודה. העלה את התמונה ואשר כשסיימת."
(In demo: user just confirms they "uploaded" and we accept it)

### Step 5: Face Verification (simulated)
"שלב אחרון – אימות פנים 📸
צלם סלפי ברור עם תאורה טובה. ודא שהפנים גלויות במלואן."
(In demo: user just confirms they "took a selfie" and we accept it)

### Step 6: All Complete
"מעולה! כל שלבי האימות הושלמו בהצלחה ✅ נמשיך לשלב הבא."

## RULES
- **Gender-neutral self-reference** - Never expose your gender. No slash forms (מבין/ה). Use neutral phrasing.
- Keep language **calm and neutral** - standard procedure, not security drama
- **Don't alarm** the customer
- **Don't blame** user for failures - frame as technical issues
- Keep responses **short** (2-3 sentences)
- **Always move forward** - after each step, immediately proceed to the next. Never ask "do you have questions?" or "should we continue?"

## OTP DEMO RULES
- 6-digit code starting with "1" = SUCCESS (e.g., 123456)
- 6-digit code starting with "2"/"3" = FAILURE
- Other format = ask for 6-digit code
- Max 3 attempts
- **IMPORTANT:** Always mention the code is **6 digits**`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1500,
      tools: [],
      knowledgeBase: null
    });
  }

  /**
   * Validate OTP code in code (not via LLM extraction).
   * Returns true for 6-digit codes starting with '1'.
   */
  _isOtpValid(code) {
    if (!code) return false;
    const codeStr = String(code).trim();
    return codeStr.length === 6 && /^\d+$/.test(codeStr) && codeStr.startsWith('1');
  }

  getFieldsForExtraction(collectedFields) {
    const hasPhoneNumber = !!collectedFields.phone_number;
    const otpCode = collectedFields.otp_code;
    const otpVerified = this._isOtpValid(otpCode);
    const hasIdNumber = !!collectedFields.id_number;
    const hasIdDocument = collectedFields.id_document_uploaded === 'true';

    // Sequential: only expose the current step's field(s)
    if (!hasPhoneNumber) {
      return this.fieldsToCollect.filter(f => f.name === 'phone_number');
    }
    if (!otpVerified) {
      // OTP step: only extract the code, verification is done in code
      return this.fieldsToCollect.filter(f => f.name === 'otp_code');
    }
    if (!hasIdNumber) {
      return this.fieldsToCollect.filter(f => f.name === 'id_number');
    }
    if (!hasIdDocument) {
      return this.fieldsToCollect.filter(f => f.name === 'id_document_uploaded');
    }
    // Last step: face verification
    return this.fieldsToCollect.filter(f => f.name === 'face_verified');
  }

  async preMessageTransfer(collectedFields) {
    const hasPhoneNumber = !!collectedFields.phone_number;
    const otpVerified = this._isOtpValid(collectedFields.otp_code);
    const hasIdNumber = !!collectedFields.id_number;
    const hasIdDocument = collectedFields.id_document_uploaded === 'true';
    const faceVerified = collectedFields.face_verified === 'true';

    return hasPhoneNumber && otpVerified && hasIdNumber && hasIdDocument && faceVerified;
  }

  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const hasPhoneNumber = !!collectedFields.phone_number;
    const otpCode = collectedFields.otp_code || null;
    const otpVerified = this._isOtpValid(otpCode);
    const hasIdNumber = !!collectedFields.id_number;
    const hasIdDocument = collectedFields.id_document_uploaded === 'true';
    const faceVerified = collectedFields.face_verified === 'true';

    const allComplete = hasPhoneNumber && otpVerified && hasIdNumber && hasIdDocument && faceVerified;

    // Determine OTP status for the LLM
    let otpStatus = 'pending';
    if (otpCode) {
      const codeStr = String(otpCode).trim();
      if (codeStr.length !== 6 || !/^\d+$/.test(codeStr)) {
        otpStatus = 'invalid_format';
      } else if (otpVerified) {
        otpStatus = 'success';
      } else {
        otpStatus = 'failed';
      }
    }

    return {
      ...baseContext,
      role: 'Identity Verification',
      stage: 'OTP, Document & Face Verification',
      customerName: collectedFields.user_name || null,
      verificationStatus: {
        phoneNumber: hasPhoneNumber ? 'Collected' : 'Pending',
        otpCode: otpCode ? 'Entered' : 'Not entered',
        otpVerification: otpStatus,
        idNumber: hasIdNumber ? 'Collected' : 'Pending',
        idDocument: hasIdDocument ? 'Uploaded' : 'Pending',
        faceVerification: faceVerified ? 'Verified' : 'Pending'
      },
      instruction: allComplete
        ? 'All verification steps complete! Confirm success and prepare for transition.'
        : !hasPhoneNumber
        ? 'Ask for phone number. Explain this is a quick verification step.'
        : !otpCode
        ? 'Simulate sending OTP to the phone number. Confirm "code sent" and mention it is a 6-digit code.'
        : otpStatus === 'failed'
        ? 'OTP failed. Explain calmly and offer to try again with a new code.'
        : otpStatus === 'invalid_format'
        ? 'The code entered is not in the right format. Ask for a 6-digit code.'
        : !otpVerified
        ? 'Guide user through OTP entry.'
        : !hasIdNumber
        ? 'OTP verified! Now ask for ID number (ת"ז, passport, or driver\'s license).'
        : !hasIdDocument
        ? 'Ask user to upload a photo of their ID document. In demo, accept any confirmation.'
        : !faceVerified
        ? 'Ask user to take a selfie for face verification. In demo, accept any confirmation.'
        : 'Preparing transition.',
      note: 'After each step, immediately proceed to the next. NEVER ask "do you have questions?" or "should we continue?" - just move forward.',
      demoNote: 'ALL VERIFICATION IS SIMULATED. OTP: 6-digit code starting with "1" = success. ID upload & face scan: accept any user confirmation.'
    };
  }
}

module.exports = IdentityVerificationCrew;
