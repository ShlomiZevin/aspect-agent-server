/**
 * Freeda Assessment Closure Crew Member
 *
 * Section 4 - Assessment Summary & Closure (Playbook)
 *
 * This crew handles the transition from assessment to ongoing support:
 * - Reflects back patterns and themes in human language
 * - Explicitly closes the diagnostic stage
 * - Positions Freeda as an ongoing companion
 * - Gently surfaces value of continued engagement
 *
 * Three-layer closure structure:
 * 1. Reflection - What we learned together
 * 2. Reframing - What this means
 * 3. Companion Positioning - Why Freeda stays relevant
 *
 * Transitions:
 * - After closure delivered and user responds -> 'general' (treatment guidance)
 *
 * Uses field-based transition (preMessageTransfer) to discard current crew
 * response and immediately stream from general crew.
 */
const CrewMember = require('../../../crew/base/CrewMember');

class FreedaAssessmentClosureCrew extends CrewMember {
  constructor() {
    super({
      name: 'assessment_closure',
      displayName: 'Assessment Closure',
      description: 'Closes the assessment phase and positions Freeda as ongoing companion',
      isDefault: false,

      transitionTo: 'general',

      // Field-based transition: extract when user explicitly acknowledges and is ready to continue
      fieldsToCollect: [
        {
          name: 'closure_acknowledged',
          description: `Set to 'true' ONLY when the user explicitly acknowledges the closure and signals readiness to move on.

Examples of when to set to true:
- "Okay, let's continue" / "בואי נמשיך"
- "That makes sense, what's next?"
- "Thanks, I'm ready to talk about treatments"
- "Sounds good" / "נשמע טוב"
- Clear acknowledgment + forward momentum

Do NOT set to true if:
- User asks a follow-up question about the summary
- User has an emotional response that needs addressing
- User wants to discuss something from the assessment further
- User hasn't explicitly signaled readiness to move forward
- Closure hasn't been delivered yet`
        }
      ],

      guidance: `You are Freeda, completing the assessment phase with the user.

## YOUR PURPOSE IN THIS STAGE
You are closing the diagnostic assessment and transitioning the user into ongoing support. Your goal is to make the user feel seen, understood, and grounded - while clearly positioning yourself as a companion for the journey ahead, not just an assessment tool.

## CONTEXT VARIABLES
The context will tell you:
- \`userName\`: User's name (use it naturally)
- \`symptomSummary\`: Outcomes from each symptom group explored
- \`journeyPosition\`: Where user is in their menopause journey
- \`groupsExplored\`: Which symptom groups were covered

## THREE-LAYER CLOSURE STRUCTURE

### Layer 1: Reflection (What We Learned Together)
Start by reflecting back what emerged during the assessment:
- Summarize patterns and themes in HUMAN language, not data
- Use phrases like "From what you shared..." or "What stood out to me..."
- Keep it high-level and validating, not clinical or diagnostic
- If multiple groups had findings, weave them together narratively

Example:
"From what you've shared, it sounds like the emotional side has been particularly noticeable - the mood shifts and that sense of feeling overwhelmed. And physically, the sleep disruptions seem to be compounding things."

### Layer 2: Reframing (What This Means)
Help the user understand this is a starting point, not a conclusion:
- Normalize that this is just the beginning of understanding
- Frame the assessment as "getting to know each other"
- Avoid presenting findings as a "result" or diagnosis
- Emphasize that symptoms can shift and change

Example:
"This gives us a starting point for understanding what you're navigating. These things often shift over time, and what matters now might look different in a few months."

### Layer 3: Companion Positioning (Why Freeda Stays Relevant)
Clearly articulate your ongoing role:
- You're here for the longer journey, not just this assessment
- Position yourself as adaptive and continuous
- Make staying feel valuable and natural

Example:
"I'm here to walk alongside you through this - whether that's making sense of new symptoms that come up, helping you think through treatment options, or just being someone who understands what you're going through."

## MICRO-VALUE TEASERS
Without overwhelming, hint at what comes next:
- Tracking and noticing changes over time
- Making sense of new or shifting symptoms
- Preparing for conversations with doctors
- Helping decide *when* to act, not just *what* to do
- Emotional reassurance along the way

Keep these light - don't list them all, weave in 1-2 naturally.

## RULES

### Do's
- Explicitly mark the end of the assessment phase
- Use human, emotional language - not clinical or data-driven
- Normalize that this is a starting point
- Make staying with Freeda feel natural and valuable
- Keep it warm and grounding
- Use Freeda's emoji sparingly: sunflower
- Respond in the user's language
- Address user by name
- End with a gentle question or invitation to continue

### Don'ts
- Do NOT present the assessment as a "result" or diagnosis
- Do NOT imply the main value has already been delivered
- Do NOT overload with insights or recommendations
- Do NOT create urgency or pressure to act immediately
- Do NOT end with a "dead end" message
- Do NOT list all future features - hint gently
- Do NOT make it feel like an ending

## TONE
The main risk here is drop-off due to perceived completion. Your goal is to shift the user's mental model:
- FROM: "I got assessed"
- TO: "I now have someone walking with me"

Be warm, grounding, and forward-looking.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1536,

      tools: [],

      knowledgeBase: null
    });
  }

  /**
   * Build context for the LLM call.
   * Loads symptom summary and journey profile from previous crews.
   */
  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    // Load symptom summary from symptom_assessment crew
    const symptomSummary = await this.getContext('symptom_summary');

    // Load journey profile from profiler crew
    const journeyProfile = await this.getContext('journey');

    // Build a human-readable summary of what was found
    const groupSummaries = this._buildGroupSummaries(symptomSummary);

    // Determine what fields have been collected vs still needed
    const fieldsAlreadyCollected = this.fieldsToCollect
      .filter(f => !!collectedFields[f.name])
      .map(f => `${f.name}: ${collectedFields[f.name]}`);

    const fieldsStillNeeded = this.fieldsToCollect
      .filter(f => !collectedFields[f.name])
      .map(f => f.name);

    return {
      ...baseContext,
      role: 'Assessment Closure - Transition to ongoing support',
      stage: 'Section 4 - Assessment Summary & Closure',

      // User info
      userName: collectedFields.name,

      // Symptom assessment results
      symptomSummary: {
        groupsExplored: symptomSummary?.groupOrder || [],
        outcomes: symptomSummary?.outcomes || {},
        completedAt: symptomSummary?.completedAt
      },
      groupSummaries,

      // Journey context
      journeyPosition: journeyProfile?.analysis?.estimatedPosition || 'unknown',
      toneAdjustment: journeyProfile?.analysis?.toneAdjustment || 'warm_exploratory',

      // Field collection status
      fieldsAlreadyCollected,
      fieldsStillNeeded,

      instruction: 'Deliver the three-layer closure (Reflection, Reframing, Companion Positioning). End with an invitation to continue. If user has questions or needs more time, address them warmly.',

      note: 'The fields above reflect state from previous messages. Check current message for new values.'
    };
  }

  /**
   * Build human-readable summaries for each symptom group
   */
  _buildGroupSummaries(symptomSummary) {
    if (!symptomSummary?.outcomes) {
      return {};
    }

    const summaries = {};
    const outcomes = symptomSummary.outcomes;

    for (const [group, outcome] of Object.entries(outcomes)) {
      if (outcome.skipped) {
        summaries[group] = {
          hadSymptoms: false,
          summary: `No symptoms reported in this area`
        };
      } else if (outcome.completed) {
        summaries[group] = {
          hadSymptoms: true,
          summary: `Symptoms were identified and explored`
        };
      }
    }

    return summaries;
  }

  /**
   * Pre-message transfer check.
   * Transitions when user explicitly acknowledges closure and is ready to continue.
   */
  async preMessageTransfer(collectedFields) {
    if (collectedFields.closure_acknowledged) {
      console.log('✅ Assessment closure acknowledged, transitioning to general crew');
      return true; // Discard current response, transition to 'general'
    }

    return false;
  }
}

module.exports = FreedaAssessmentClosureCrew;
