/**
 * Freeda Profiler Crew Member
 *
 * Pre-Diagnostic Orientation & Profiling Stage
 *
 * This crew handles:
 * - Explaining the diagnostic process (structure, duration, flexibility)
 * - Collecting high-level positioning inputs (cycle status, treatment history)
 * - Forming internal hypothesis about user's menopause journey position
 * - Adapting the upcoming diagnostic flow based on profile
 *
 * Transitions:
 * - After profiling complete -> 'general' (later: 'symptom_collector')
 *
 * Prerequisites:
 * - User has passed eligibility gate (female, age >= 38)
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../freeda-persona');

class FreedaProfilerCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'profiler',
      displayName: 'Journey Profiler',
      description: 'Pre-diagnostic orientation and journey profiling',
      isDefault: false,

      fieldsToCollect: [
        {
          name: 'menstrual_status',
          description: "User's menstrual cycle status. One of: 'regular', 'irregular', 'stopped', 'not_applicable'. Extract from how user describes their periods/cycle."
        },
        {
          name: 'treatment_history',
          description: "User's hormonal treatment history. One of: 'never_tried', 'tried_in_past', 'currently_using', 'prefer_not_to_say'. Extract from mentions of HRT, hormones, treatments tried."
        },
        {
          name: 'cycle_clarification',
          description: "If menstrual_status is 'not_applicable' or 'stopped' at young age, capture high-level reason: 'surgery', 'medical_condition', 'other'. No medical details needed."
        },
        {
          name: 'perceived_stage',
          description: "User's self-perceived stage in menopause journey. One of: 'just_starting', 'in_the_middle', 'experienced', 'unsure'. Extract from how they describe where they are."
        },
        {
          name: 'prior_exposure',
          description: "Has user previously explored menopause info/actions? One of: 'none', 'some_reading', 'actively_researching', 'seen_professionals'. Extract from mentions of prior knowledge/actions."
        },
        {
          name: 'sense_of_change',
          description: "User's general sense of change/transition intensity. One of: 'mild', 'moderate', 'significant', 'overwhelming'. Extract from how they describe their experience overall (not specific symptoms)."
        }
      ],

      transitionTo: 'symptom_assessment',

      guidance: `You are Freeda, continuing your warm conversation with the user who has just completed the introduction stage.

## YOUR PURPOSE IN THIS STAGE
You are the Journey Profiler. Your role is to:
1. Explain the diagnostic process - what it includes, that it can be paused and resumed
2. Collect high-level positioning inputs to understand where the user is in her menopause journey
3. Adapt your approach based on what you learn (internally - do not explain this to the user)

## WHAT YOU MUST DO

### Explain the Process
Early in this conversation, explain:
- "I'd like to understand a bit more about where you are in your journey"
- "This will help me personalize our conversations"
- "We can take this at your pace - feel free to pause anytime and pick up later"
- Keep it brief and warm, not clinical or overwhelming

### Collect Positioning Inputs (Conversationally)
You need to understand:

1. **Menstrual cycle status** - Ask naturally: "How would you describe your periods these days?" or "Are your cycles still regular?"
   - Regular
   - Irregular / changing
   - Stopped
   - Not applicable (surgery, etc.)

2. **Hormonal treatment history** - Ask gently: "Have you explored any hormonal treatments, like HRT?"
   - Never tried
   - Tried in the past
   - Currently using
   - Prefer not to say

3. **If cycle stopped early or not applicable** - Only if relevant, ask high-level: "Was that due to a medical procedure, or...?"
   - No medical details needed, just high-level understanding
   - Surgery / Medical condition / Other

4. **Subjective self-assessment** - Ask reflectively:
   - "How would you describe where you are in this journey?" (just starting / in the middle / experienced)
   - "Have you looked into menopause much before, or is this quite new?"
   - "Overall, how has this transition been feeling for you?"

## COMMUNICATION STYLE

### Do's
- Use experiential language ("how this feels for you") rather than clinical framing
- Normalize variability ("there's no single menopause journey")
- Allow users to answer broadly or approximately
- Signal flexibility: "we can skip this" or "no pressure to answer"
- Subtly reflect back understanding ("based on what you shared...")
- Keep questions high-level and non-intrusive
- One topic at a time, conversationally
- Respond in the user's language

### Don'ts
- Do NOT ask detailed symptom questions (that comes later)
- Do NOT assess severity or impact of symptoms
- Do NOT give medical advice or recommendations
- Do NOT invalidate the user's experience
- Do NOT label the user's menopause stage explicitly ("you're in perimenopause")
- Do NOT overwhelm with long explanations or questionnaires
- Do NOT ask multiple questions at once

## RULES
- Keep responses to 2-4 sentences max
- Use a warm, human, non-clinical tone
- Use Freeda's signature emoji sparingly: sunflower
- Address the user by name if known
- Be patient - this is about understanding, not interrogation
- Remember: you're building trust and rapport, not conducting an intake form

## INTERNAL NOTES (Do not share with user)
Based on inputs, you will internally assess:
- Estimated journey position (early awareness / active transition / post-diagnostic)
- Which symptom group to explore first (emotional / physical / cognitive)
- Appropriate depth and tone for upcoming conversations

This analysis guides your approach but is NEVER shared with the user.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1024,
      tools: [],
      knowledgeBase: null
    });
  }

  /**
   * Pre-message transfer check.
   * Transitions when required positioning inputs are collected (menstrual_status, treatment_history).
   * The process explanation happens naturally as part of the conversation.
   *
   * On transition, persists the journey profile and analysis to context_data.
   */
  async preMessageTransfer(collectedFields) {
    const hasMenstrualStatus = !!collectedFields.menstrual_status;
    const hasTreatmentHistory = !!collectedFields.treatment_history;

    // Required fields for transition
    if (!hasMenstrualStatus || !hasTreatmentHistory) {
      return false;
    }

    // If menstrual status needs clarification, wait for it
    const needsClarification =
      collectedFields.menstrual_status === 'not_applicable' ||
      (collectedFields.menstrual_status === 'stopped' && !collectedFields.cycle_clarification);

    if (needsClarification && !collectedFields.cycle_clarification) {
      return false;
    }

    // Ready to transition - persist journey profile to context_data
    const journeyAnalysis = this._analyzeJourneyPosition(collectedFields);

    const journeyProfile = {
      // User-provided inputs
      menstrualStatus: collectedFields.menstrual_status,
      treatmentHistory: collectedFields.treatment_history,
      cycleClarification: collectedFields.cycle_clarification || null,
      perceivedStage: collectedFields.perceived_stage || null,
      priorExposure: collectedFields.prior_exposure || null,
      senseOfChange: collectedFields.sense_of_change || null,

      // Internal analysis (used by downstream crews)
      analysis: journeyAnalysis,

      // Metadata
      profiledAt: new Date().toISOString(),
      profiledBy: this.name
    };

    // Save to user-level context (persists across conversations)
    await this.writeContext('journey', journeyProfile);
    console.log(`📝 Saved journey profile for user: ${JSON.stringify(journeyAnalysis)}`);

    return true;
  }

  /**
   * Build context with internal journey analysis.
   * This analysis is used to adapt the upcoming diagnostic flow.
   * Also loads any existing journey context from previous sessions.
   */
  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    // Load existing journey context (if user has been profiled before)
    const existingJourney = await this.getContext('journey');

    // Determine what's been collected vs still needed
    const requiredFields = ['menstrual_status', 'treatment_history'];
    const optionalFields = ['cycle_clarification', 'perceived_stage', 'prior_exposure', 'sense_of_change'];

    const missingRequired = requiredFields.filter(f => !collectedFields[f]);
    const missingOptional = optionalFields.filter(f => !collectedFields[f]);
    const collected = this.fieldsToCollect.filter(f => !!collectedFields[f.name]);

    // Internal journey analysis (not shown to user)
    const journeyAnalysis = this._analyzeJourneyPosition(collectedFields);

    return {
      ...baseContext,
      role: 'Pre-diagnostic orientation and journey profiling',
      stage: 'Section 2 - Orientation & Profiling',

      // User info from previous crew
      userName: collectedFields.name,
      userAge: collectedFields.age,

      // Existing journey profile (if returning user)
      existingJourneyProfile: existingJourney ? {
        hasExistingProfile: true,
        profiledAt: existingJourney.profiledAt,
        previousAnalysis: existingJourney.analysis
      } : null,

      // Collection status
      fieldsAlreadyCollected: collected.map(f => `${f.name}: ${collectedFields[f.name]}`),
      fieldsStillNeeded: {
        required: missingRequired,
        optional: missingOptional
      },

      // Internal analysis for adapting conversation (Freeda uses this, not shown to user)
      internalAnalysis: journeyAnalysis,

      instruction: missingRequired.length > 0
        ? `Still need: ${missingRequired.join(', ')}. Ask conversationally, one topic at a time. Do NOT ask about specific symptoms yet.`
        : 'Required profiling complete. Prepare to transition to symptom collection.',

      note: 'The fields above reflect state from previous messages. Check current message for new values.'
    };
  }

  /**
   * Internal analysis of user's menopause journey position.
   * Used to adapt tone, depth, and symptom group priority.
   * This is invisible to the user.
   */
  _analyzeJourneyPosition(fields) {
    const analysis = {
      estimatedPosition: 'unknown',
      symptomGroupPriority: ['emotional', 'physical', 'cognitive'],
      recommendedDepth: 'moderate',
      toneAdjustment: 'warm_exploratory'
    };

    // Estimate journey position based on inputs
    const stage = fields.perceived_stage;
    const exposure = fields.prior_exposure;
    const change = fields.sense_of_change;
    const menstrual = fields.menstrual_status;

    // Early awareness / exploration
    if (stage === 'just_starting' || stage === 'unsure' || exposure === 'none') {
      analysis.estimatedPosition = 'early_awareness';
      analysis.recommendedDepth = 'gentle';
      analysis.toneAdjustment = 'reassuring_educational';
      analysis.symptomGroupPriority = ['emotional', 'physical', 'cognitive'];
    }
    // Active transition
    else if (stage === 'in_the_middle' || menstrual === 'irregular' || change === 'significant') {
      analysis.estimatedPosition = 'active_transition';
      analysis.recommendedDepth = 'moderate';
      analysis.toneAdjustment = 'empathetic_supportive';
      analysis.symptomGroupPriority = ['physical', 'emotional', 'cognitive'];
    }
    // Post-diagnostic / experienced
    else if (stage === 'experienced' || exposure === 'seen_professionals' || menstrual === 'stopped') {
      analysis.estimatedPosition = 'post_diagnostic';
      analysis.recommendedDepth = 'detailed';
      analysis.toneAdjustment = 'collaborative_informed';
      analysis.symptomGroupPriority = ['physical', 'cognitive', 'emotional'];
    }

    // Adjust for overwhelming experience
    if (change === 'overwhelming') {
      analysis.toneAdjustment = 'extra_gentle_validating';
      analysis.recommendedDepth = 'gentle';
    }

    return analysis;
  }
}

module.exports = FreedaProfilerCrew;
