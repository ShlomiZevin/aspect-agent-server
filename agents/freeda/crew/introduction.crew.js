/**
 * Freeda Introduction Crew Member
 *
 * Section 1 - Introduction & Service Overview
 *
 * The entry-point crew member for Freeda. Handles:
 * - Warm introduction to Freeda and the service
 * - Terms of Service presentation
 * - Collection of user profile (name, age, language, location)
 * - Eligibility determination (age >= 38, not male)
 *
 * Transitions:
 * - Eligible users (age >= 38) -> 'profiler' crew (orientation & journey profiling)
 * - Ineligible users (age < 38 or male) -> 'ineligible' crew
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../freeda-persona');

class FreedaIntroductionCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'introduction',
      displayName: 'Introduction',
      description: 'Introduction, service overview, and eligibility check',
      isDefault: true,

      fieldsToCollect: [
        { name: 'name', description: "The user's first name or preferred nickname" },
        { name: 'age', description: "The user's age as a number (e.g., 45, 52). Extract the numeric value." },
        { name: 'tos_acknowledged', description: "Set to 'true' when the user gives ANY affirmative response after Freeda presents the Terms of Service / disclaimer about not being a medical professional. Affirmative responses include: 'yes', 'okay', 'sure', 'I understand', 'that's fine', 'כן', 'בסדר', 'מתאים לי', 'אוקיי', 'בטח', or any similar confirmation in any language. If the assistant asked about ToS and the user said yes - this is true." }
      ],

      // Default transition for eligible users
      // Will be dynamically changed to 'ineligible' for users who don't meet criteria
      transitionTo: 'profiler',

      guidance: `You are Freeda, a warm and supportive menopause wellness companion.

## YOUR PURPOSE IN THIS STAGE
You are the Introduction agent. Your role is to:
1. Welcome the user warmly and introduce yourself
2. Explain what Freeda does (and what it doesn't do)
3. Present the Terms of Service
4. Collect basic information: name, age, preferred language, and location
5. Determine eligibility for the service

## WHAT FREEDA IS
- An ongoing wellness companion for women navigating menopause
- A source of guidance, information, and emotional support
- A safe space to discuss symptoms, treatments, and wellbeing

## WHAT FREEDA IS NOT
- NOT a medical diagnosis or treatment service
- NOT a replacement for healthcare professionals
- NOT a one-time chat - this is ongoing support

## TERMS OF SERVICE
At an appropriate point early in the conversation, present the Terms of Service:
"Before we continue, I want to be clear about what I can offer: I provide guidance and support for menopause-related wellness, but I'm not a medical professional and cannot diagnose or treat conditions. For medical concerns, please consult your healthcare provider. By continuing our conversation, you acknowledge this. Is that okay with you?"

## HOW TO COLLECT INFORMATION
- Be conversational and warm - NOT like a form
- Weave questions naturally into the conversation
- Don't ask all questions at once
- If user provides multiple pieces of info, acknowledge them
- CRITICAL: Respond in the user's language consistently

## FLOW
1. First message: Warm introduction, ask for name
2. After name: Thank them, naturally ask about age (be sensitive - "may I ask your age?")
3. Ask about preferred language if not obvious from their messages
4. Ask about location (country)
5. Present Terms of Service - IMPORTANT: This must happen before transition
6. Wait for user acknowledgement of ToS (they say "yes", "okay", "I understand", etc.)
7. Once ToS is acknowledged and age collected, confirm and transition

IMPORTANT: Do not rush the conversation. The user must acknowledge the Terms of Service before proceeding to the next stage.

## ELIGIBILITY RULES (Internal - do not mention these explicitly)
- This service is designed for women aged 38 and above
- If user's age is under 38: Politely explain the service is currently designed for women 38+, offer to provide general information, or invite them to return when appropriate
- If user indicates they are male: Respectfully explain the service scope is specifically for women's menopause wellness, gracefully redirect or end

## RULES
- Keep responses to 2-4 sentences max
- Use a warm, human, non-clinical tone
- Use Freeda's signature emoji sparingly: sunflower
- Do NOT use medical jargon
- Do NOT promise outcomes, diagnoses, or treatments
- Do NOT ask in-depth medical questions (symptoms, medical history)
- Do NOT overload with product features
- Position as ongoing support, not a one-off chat
- Be a host and guide, not an assessor`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: null
    });
  }

  /**
   * Pre-message transfer check with eligibility routing.
   *
   * Returns true when ready to transition:
   * - Eligible (age >= 38, not male) -> transitions to 'general'
   * - Ineligible (age < 38 or male) -> transitions to 'ineligible'
   *
   * @param {Object} collectedFields - All collected fields
   * @returns {Promise<boolean>} - true if ready to transition
   */
  async preMessageTransfer(collectedFields) {
    const hasName = !!collectedFields.name;
    const hasAge = !!collectedFields.age;
    const hasTosAcknowledged = !!collectedFields.tos_acknowledged;

    // Parse age early for ineligibility checks (can reject before ToS)
    const ageStr = collectedFields.age ? String(collectedFields.age) : '';
    const ageMatch = ageStr.match(/\d+/);
    const age = ageMatch ? parseInt(ageMatch[0], 10) : null;

    // Check gender if mentioned (can reject before ToS)
    const gender = collectedFields.gender?.toLowerCase();
    const isMale = gender === 'male' || gender === 'man';

    // Ineligibility checks - these can trigger immediately upon detection
    // (no need to wait for ToS if user is ineligible)
    if (isMale) {
      this.transitionTo = 'ineligible';
      return true;
    }

    if (age !== null && age < 38) {
      this.transitionTo = 'ineligible';
      return true;
    }

    // For eligible users: require name, age, AND ToS acknowledgement
    // Transition conditions per requirements:
    // 1. ToS have been presented
    // 2. User continues after ToS (implicit consent = tos_acknowledged)
    // 3. Age collected
    if (!hasName || !hasAge || !hasTosAcknowledged) {
      return false;
    }

    // All conditions met - eligible user ready to transition
    if (age !== null && age >= 38) {
      this.transitionTo = 'profiler';
      return true;
    }

    return false;
  }

  /**
   * Build context for the LLM call
   */
  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    const requiredFields = ['name', 'age', 'tos_acknowledged'];
    const optionalFields = ['language', 'location'];

    const missingRequired = requiredFields.filter(f => !collectedFields[f]);
    const missingOptional = optionalFields.filter(f => !collectedFields[f]);
    const collected = this.fieldsToCollect.filter(f => !!collectedFields[f.name]);

    // Determine eligibility status for context
    let eligibilityStatus = 'unknown';
    if (collectedFields.age) {
      const ageMatch = String(collectedFields.age).match(/\d+/);
      const age = ageMatch ? parseInt(ageMatch[0], 10) : null;
      if (age !== null) {
        eligibilityStatus = age >= 38 ? 'eligible' : 'under_age';
      }
    }
    if (collectedFields.gender?.toLowerCase() === 'male' ||
        collectedFields.gender?.toLowerCase() === 'man') {
      eligibilityStatus = 'not_target_audience';
    }

    return {
      ...baseContext,
      role: 'Introduction and eligibility assessment',
      stage: 'Section 1 - Introduction & Service Overview',
      fieldsAlreadyCollected: collected.map(f => `${f.name}: ${collectedFields[f.name]}`),
      fieldsStillNeeded: {
        required: missingRequired,
        optional: missingOptional
      },
      eligibilityStatus,
      instruction: missingRequired.length > 0
        ? `Still need to collect: ${missingRequired.join(', ')}. Be conversational, not form-like. Remember: ToS must be presented BEFORE the user can proceed.`
        : 'Required fields collected. System will handle transition based on eligibility.',
      note: 'The fields above reflect state from previous messages. The user\'s current message may contain new field values - check it directly and do not re-ask for information already provided in this message.'
    };
  }
}

module.exports = FreedaIntroductionCrew;
