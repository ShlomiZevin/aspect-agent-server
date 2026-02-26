/**
 * Compass Self Assessment Crew
 *
 * Guides the user through a 3-dimension self-assessment:
 *   1. transferable_skills — what they're already good at
 *   2. gaps               — what they'd need to learn / acquire
 *   3. motivation         — why this change, what success looks like
 *
 * Tool: record_assessment(dimension, findings, strength_score)
 * postMessageTransfer: fires when all 3 dimensions are recorded,
 *   computes readiness_score and persists assessment_results to context.
 *
 * Demo capabilities: Tool calls + postMessageTransfer + context system
 */
const CrewMember = require('../../../crew/base/CrewMember');

const DIMENSIONS = ['transferable_skills', 'gaps', 'motivation'];

const DIMENSION_LABELS = {
  transferable_skills: 'Transferable Skills',
  gaps: 'Skill Gaps',
  motivation: 'Motivation & Goals'
};

const DIMENSION_PROMPTS = {
  transferable_skills: "What skills, experiences, or strengths from your current role could carry over to your new direction?",
  gaps: "What skills, credentials, or experience would you need to acquire for this transition?",
  motivation: "Why do you want to make this change — and what would success look like to you?"
};

class CompassSelfAssessmentCrew extends CrewMember {
  constructor() {
    super({
      name: 'self_assessment',
      displayName: 'Self Assessment',
      description: 'Structured 3-dimension career change self-assessment',
      isDefault: false,

      transitionTo: 'transition_plan',

      guidance: `You are Compass, conducting a focused career change self-assessment.

## YOUR PURPOSE
Guide the user through 3 assessment dimensions, one at a time:
1. **Transferable Skills** — what they bring from their current role
2. **Skill Gaps** — what they'd need to learn or acquire
3. **Motivation & Goals** — why they want this change and what success looks like

## HOW TO WORK
- The context will tell you: \`currentDimension\` (what to explore now)
- Start by asking the question for that dimension in a warm, open-ended way
- Let the user respond. Ask 1-2 follow-up questions to get richer input.
- When you have enough to form a good summary: call \`record_assessment\` with:
  - dimension: the current dimension name
  - findings: a 2-3 sentence summary of what the user shared
  - strength_score: your honest estimate (1–10) of how strong/positive this looks for career change readiness
- After calling the tool, transition naturally to the next dimension

## SCORING GUIDE
- 8–10: Strong. Clear strengths, minimal risk, high motivation
- 5–7: Moderate. Some gaps or uncertainty, but workable
- 1–4: Challenging. Significant gaps, unclear motivation, or risk factors

## RULES
- One dimension at a time (check \`currentDimension\` in context)
- Don't mention scores or numbers to the user — just assess internally
- Keep responses to 2–4 sentences
- Be encouraging — this is a safe space for honest reflection
- Don't give advice yet — save it for the Compass Report`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1024,
      tools: [] // overridden below
    });

    // Tools need this.getContext / this.writeContext — set after super()
    this.tools = [
      {
        name: 'record_assessment',
        description: 'Record the self-assessment for one dimension. Call after the user has shared their thoughts.',
        parameters: {
          type: 'object',
          properties: {
            dimension: {
              type: 'string',
              enum: DIMENSIONS,
              description: 'The dimension being assessed: transferable_skills | gaps | motivation'
            },
            findings: {
              type: 'string',
              description: 'A 2–3 sentence summary of what the user shared for this dimension'
            },
            strength_score: {
              type: 'number',
              minimum: 1,
              maximum: 10,
              description: 'Readiness score for this dimension (1–10)'
            }
          },
          required: ['dimension', 'findings', 'strength_score']
        },
        handler: async ({ dimension, findings, strength_score }) => {
          const state = await this.getContext('assessment_state') || {
            completed: [],
            scores: {},
            findings: {}
          };

          if (!state.completed.includes(dimension)) {
            state.completed.push(dimension);
          }
          state.scores[dimension] = strength_score;
          state.findings[dimension] = findings;

          await this.writeContext('assessment_state', state);
          console.log(`🧭 Compass: Recorded "${dimension}" (score: ${strength_score})`);

          const remaining = DIMENSIONS.filter(d => !state.completed.includes(d));
          if (remaining.length === 0) {
            return {
              status: 'all_complete',
              message: 'All 3 dimensions recorded. The assessment is complete.'
            };
          }
          return {
            status: 'recorded',
            next_dimension: remaining[0],
            next_question: DIMENSION_PROMPTS[remaining[0]],
            remaining_count: remaining.length
          };
        }
      }
    ];
  }

  /**
   * postMessageTransfer: fires after each LLM response.
   * Transitions to transition_plan when all 3 dimensions are complete.
   * Computes readiness score and persists final assessment_results.
   */
  async postMessageTransfer(collectedFields, llmResponse) {
    const state = await this.getContext('assessment_state') || {};
    const completed = state.completed || [];

    if (completed.length < DIMENSIONS.length) return false;

    // Compute readiness score
    const scores = state.scores || {};
    const values = Object.values(scores);
    const avg = values.length > 0
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 5;
    const readinessScore = Math.round(avg * 10) / 10;

    // Classify readiness
    let readinessLevel;
    if (readinessScore >= 7.5) readinessLevel = 'strong';
    else if (readinessScore >= 5) readinessLevel = 'moderate';
    else readinessLevel = 'challenging';

    // Persist to user-level context for transition_plan and coach
    await this.writeContext('assessment_results', {
      completed: true,
      dimensions: state.findings || {},
      scores: state.scores || {},
      readinessScore,
      readinessLevel,
      completedAt: new Date().toISOString()
    });

    console.log(`🧭 Compass: Assessment complete. Readiness: ${readinessScore} (${readinessLevel})`);
    return true;
  }

  async buildContext(params) {
    const base = await super.buildContext(params);
    const f = params.collectedFields || {};
    const state = await this.getContext('assessment_state') || { completed: [], scores: {}, findings: {} };

    const completed = state.completed || [];
    const remaining = DIMENSIONS.filter(d => !completed.includes(d));
    const currentDimension = remaining[0] || null;

    return {
      ...base,
      role: 'Career self-assessment guide',
      seekerName: f.seeker_name,
      currentRole: f.current_role,
      targetIndustry: f.target_industry,

      currentDimension,
      currentDimensionLabel: currentDimension ? DIMENSION_LABELS[currentDimension] : null,
      currentDimensionQuestion: currentDimension ? DIMENSION_PROMPTS[currentDimension] : null,

      completedDimensions: completed.map(d => ({
        name: d,
        label: DIMENSION_LABELS[d],
        score: state.scores?.[d]
      })),
      remainingCount: remaining.length,

      instruction: currentDimension
        ? `Explore the "${DIMENSION_LABELS[currentDimension]}" dimension. Ask: "${DIMENSION_PROMPTS[currentDimension]}". After the user responds, call record_assessment.`
        : 'All dimensions recorded. Wrap up warmly — the Compass Report is on its way.'
    };
  }
}

module.exports = CompassSelfAssessmentCrew;
