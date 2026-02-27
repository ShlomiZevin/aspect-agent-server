/**
 * Freeda General Crew Member
 *
 * The main menopause guidance crew member for Freeda.
 * Handles all general menopause-related conversations, symptom profiling,
 * treatment discussions, and emotional support.
 */
const CrewMember = require('../../../crew/base/CrewMember');
const { getPersona } = require('../freeda-persona');
const symptomTracker = require('../../../functions/symptom-tracker');

class FreedaGeneralCrew extends CrewMember {
  constructor() {
    super({
      persona: getPersona(),
      name: 'general',
      displayName: 'Freeda - Guide',
      description: 'Menopause expert and personal wellness guide',
      isDefault: false,

      guidance: `## Your Role in This Stage
You are Freeda's main conversation crew. The user has completed the assessment phase and is now in ongoing support. This is where the real value lives - helping the user understand, manage, and treat her menopause symptoms over time.

## Your Goals
Cover these topics over the course of the conversation, one by one:
1. Explain the different types of treatments for menopause - both medical and non-medical
2. Understand what types of treatments the user is interested in
3. Discover if the user has tried any treatments before, what they were, and what the outcome was
4. Understand what symptoms she is trying to treat the most
5. Make sure the user is not scared of HRT but understands the risks in context. Whenever HRT risks are mentioned, dive into it - dissect where the fear is coming from and use your expertise to reduce panic while maintaining objectiveness

Your task is to cover each topic one by one, then move on to the next.

## FILE SEARCH
When the user asks about menopause, symptoms, treatments, HRT, or health — call file_search BEFORE answering. Never mention files or searching.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2048,

      tools: [
        {
          name: 'report_symptom',
          description: symptomTracker.schema.description,
          parameters: symptomTracker.schema.parameters,
          handler: symptomTracker.handler
        }
      ],

      knowledgeBase: {
        enabled: true,
        sources: ['Freeda 2.0']
      },

      collectFields: [
        'symptoms',
        'treatments_tried',
        'treatment_preferences',
        'hrt_concerns',
        'lifestyle_factors'
      ]
    });
  }

  /**
   * Build context for the LLM call.
   * Loads journey profile from context to adapt approach based on profiler's analysis.
   */
  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    // Load journey profile from profiler crew (if available)
    const journeyProfile = await this.getContext('journey');

    // Build user profile from collected fields
    const userProfile = {};
    if (collectedFields.name) userProfile.userName = collectedFields.name;
    if (collectedFields.age) userProfile.userAge = collectedFields.age;

    // Add journey info to user profile
    if (journeyProfile) {
      userProfile.menstrualStatus = journeyProfile.menstrualStatus;
      userProfile.treatmentHistory = journeyProfile.treatmentHistory;
      userProfile.journeyPosition = journeyProfile.analysis?.estimatedPosition;
    }

    // Adapt conversation approach based on journey analysis
    const journeyGuidance = this._buildJourneyGuidance(journeyProfile);

    return {
      ...baseContext,
      role: 'Menopause wellness expert and personal guide',
      userProfile,
      journeyGuidance,
      conversationGoals: [
        'Build symptom profile',
        'Discuss treatment options (medical and non-medical)',
        'Address HRT concerns with empathy',
        'Provide actionable wellness tips'
      ]
    };
  }

  /**
   * Build guidance based on journey profile analysis.
   * Helps adapt tone, depth, and focus areas.
   */
  _buildJourneyGuidance(journeyProfile) {
    if (!journeyProfile?.analysis) {
      return null;
    }

    const { estimatedPosition, symptomGroupPriority, recommendedDepth, toneAdjustment } = journeyProfile.analysis;

    const guidance = {
      approachNote: '',
      symptomPriority: symptomGroupPriority || ['emotional', 'physical', 'cognitive'],
      depth: recommendedDepth || 'moderate'
    };

    // Set approach note based on journey position
    switch (estimatedPosition) {
      case 'early_awareness':
        guidance.approachNote = 'User is early in their journey. Be educational and reassuring. Explain concepts clearly without overwhelming.';
        break;
      case 'active_transition':
        guidance.approachNote = 'User is actively experiencing transition. Focus on practical support and validation. They likely have specific concerns.';
        break;
      case 'post_diagnostic':
        guidance.approachNote = 'User is experienced with menopause. Can be more detailed and collaborative. They may want specific information.';
        break;
    }

    // Adjust for tone
    if (toneAdjustment === 'extra_gentle_validating') {
      guidance.approachNote += ' User indicated feeling overwhelmed - be extra gentle and validating.';
    }

    return guidance;
  }
}

module.exports = FreedaGeneralCrew;
