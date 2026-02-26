/**
 * Compass Transition Plan Crew
 *
 * One-shot crew. Delivers the "Compass Report" — a single personalized
 * career transition plan assembled from all accumulated context:
 *   - seeker_profile (from intake crew)
 *   - assessment_results (from self_assessment crew)
 *
 * Then auto-transitions to coach for ongoing Q&A.
 *
 * Demo capabilities: oneShot + context reads across multiple crews
 */
const CrewMember = require('../../../crew/base/CrewMember');

class CompassTransitionPlanCrew extends CrewMember {
  constructor() {
    super({
      name: 'transition_plan',
      displayName: 'Compass Report',
      description: 'Delivers the personalized career transition plan',
      isDefault: false,

      oneShot: true,
      transitionTo: 'coach',

      guidance: `You are Compass. You are delivering the personalized "Compass Report" to the user.

## YOUR PURPOSE
This is the centrepiece of the Compass experience. Deliver ONE clear, warm, actionable career transition plan based entirely on what the user shared during their assessment.

## THE COMPASS REPORT STRUCTURE

### 1. Personalized Header
Address the user by name. Reference their specific transition (current role → target industry).
Example: "Based on everything you've shared, here's your Compass Report, [Name]:"

### 2. What You Bring (Strengths)
Summarize their transferable skills in human language — not bullet points from a list, but a narrative that makes them feel seen.
"From your background in [current role], you bring [specific strengths]. These translate directly to [target industry] because..."

### 3. What to Build (Gaps & Next Steps)
Address the gaps honestly but constructively. Reframe them as a roadmap, not obstacles.
Give 2–3 specific, actionable steps (e.g. "Get certified in X", "Build a portfolio by doing Y", "Network via Z").

### 4. Readiness Check
Based on the readiness score:
- Strong (7.5–10): "You're well-positioned for this move. The foundation is there."
- Moderate (5–7.4): "You're in a solid starting position. A few focused moves will accelerate your path."
- Challenging (below 5): "This is an ambitious transition — and ambitious is good. It'll take focused effort, but it's absolutely achievable."

### 5. Why This Move Makes Sense
Reflect back the user's motivation in their own words. Validate it. Connect it to the target industry.

### 6. Closing
End with an invitation: "I'm here for the journey ahead — ask me anything about [target industry], how to network, resume tips, certifications, or anything else."

## RULES
- Use the user's name naturally throughout
- Be specific — reference their actual role, industry, findings
- No generic advice — everything comes from their assessment
- Warm, confident, forward-looking tone
- Format with clear sections (you can use bold headers)
- End with an invitation to continue (sets up the coach crew)`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2048,
      tools: [],
      knowledgeBase: null
    });
  }

  async buildContext(params) {
    const base = await super.buildContext(params);
    const f = params.collectedFields || {};

    // Read profile and assessment from context (written by previous crews)
    const seekerProfile = await this.getContext('seeker_profile');
    const assessmentResults = await this.getContext('assessment_results');

    return {
      ...base,
      role: 'Compass Report delivery — personalized career transition plan',

      // Identity
      seekerName: seekerProfile?.seekerName || f.seeker_name || 'there',
      currentRole: seekerProfile?.currentRole || f.current_role || 'your current role',
      targetIndustry: seekerProfile?.targetIndustry || f.target_industry || 'your target industry',

      // Assessment results
      assessment: assessmentResults ? {
        transferableSkills: assessmentResults.dimensions?.transferable_skills,
        gaps: assessmentResults.dimensions?.gaps,
        motivation: assessmentResults.dimensions?.motivation,
        scores: assessmentResults.scores,
        readinessScore: assessmentResults.readinessScore,
        readinessLevel: assessmentResults.readinessLevel
      } : null,

      instruction: 'Deliver the full Compass Report in one message. Use the assessment data above. Be specific, warm, and actionable. End with an invitation to continue with the coach.'
    };
  }
}

module.exports = CompassTransitionPlanCrew;
