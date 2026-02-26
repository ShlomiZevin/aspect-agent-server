/**
 * Compass Coach Crew
 *
 * Ongoing career change coaching with Knowledge Base access.
 * Reads seeker_profile and assessment_results from context to
 * personalize every answer without the user repeating themselves.
 *
 * Demo capabilities: Knowledge Base (RAG) + context reads across crews
 */
const CrewMember = require('../../../crew/base/CrewMember');

class CompassCoachCrew extends CrewMember {
  constructor() {
    super({
      name: 'coach',
      displayName: 'Career Coach',
      description: 'Personalized career coaching with knowledge base access',
      isDefault: false,

      guidance: `You are Compass, acting as a knowledgeable and personalized career coach.

## YOUR PURPOSE
The user has received their Compass Report. You are now their ongoing career coach — answering any questions about their transition with expertise drawn from the knowledge base.

## CONTEXT
You have access to the user's full profile (current role, target industry, assessment findings, readiness score). Use this to make every answer personal — never give generic advice that ignores what you know about them.

## WHAT YOU CAN HELP WITH
- Resume and LinkedIn optimization for career changers
- Networking strategies (especially into unfamiliar industries)
- Certifications, courses, and credentials worth pursuing
- Salary expectations and negotiation for career changers
- Interview preparation when pivoting industries
- How to position their transferable skills
- Specific questions about their target industry

## HOW TO USE THE KNOWLEDGE BASE
Use your knowledge base to give specific, evidence-based answers. When the KB provides relevant content, reference it naturally — "Based on what works for career changers into [industry]..."

## RULES
- Always personalize to their specific transition — reference their role and target industry
- Keep responses focused and actionable
- If you don't know something specific, say so and suggest how to find out
- Be honest about what's hard — don't oversell easy paths`,

      model: 'gpt-5-chat-latest',
      maxTokens: 2048,

      knowledgeBase: {
        enabled: true,
        sources: ['Compass Career KB']
      },

      tools: []
    });
  }

  async buildContext(params) {
    const base = await super.buildContext(params);
    const f = params.collectedFields || {};

    // Read accumulated context from previous crews
    const seekerProfile = await this.getContext('seeker_profile');
    const assessmentResults = await this.getContext('assessment_results');

    const seekerName = seekerProfile?.seekerName || f.seeker_name || 'the user';
    const currentRole = seekerProfile?.currentRole || f.current_role || 'unknown';
    const targetIndustry = seekerProfile?.targetIndustry || f.target_industry || 'unknown';

    return {
      ...base,
      role: 'Personalized career coach with knowledge base access',

      // Profile (so LLM can personalize without re-asking)
      seekerName,
      currentRole,
      targetIndustry,
      transition: `${currentRole} → ${targetIndustry}`,

      // Assessment summary (so LLM knows their strengths/gaps)
      assessmentSummary: assessmentResults ? {
        transferableSkills: assessmentResults.dimensions?.transferable_skills,
        gaps: assessmentResults.dimensions?.gaps,
        motivation: assessmentResults.dimensions?.motivation,
        readinessScore: assessmentResults.readinessScore,
        readinessLevel: assessmentResults.readinessLevel
      } : null,

      instruction: `You know ${seekerName} is transitioning from "${currentRole}" to "${targetIndustry}". Use the knowledge base + their profile to give specific, personalized guidance. Never ask them to repeat what you already know.`
    };
  }
}

module.exports = CompassCoachCrew;
