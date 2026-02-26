/**
 * Compass Intake Crew
 *
 * Entry point for the Compass career change navigator.
 * Collects: seeker_name, current_role, target_industry
 * Then transitions → self_assessment
 *
 * Demo capability: Field extraction + preMessageTransfer
 */
const CrewMember = require('../../../crew/base/CrewMember');

class CompassIntakeCrew extends CrewMember {
  constructor() {
    super({
      name: 'intake',
      displayName: 'Compass - Navigator',
      description: 'Welcome and initial profile collection',
      isDefault: true,

      fieldsToCollect: [
        {
          name: 'seeker_name',
          description: "The user's first name or preferred name"
        },
        {
          name: 'current_role',
          description: "What they do now — job title, profession, or general situation (e.g. 'software engineer', 'teacher', 'stay-at-home parent')"
        },
        {
          name: 'target_industry',
          description: "The industry or field they want to move into — e.g. tech, finance, healthcare, nonprofit, creative, entrepreneurship"
        }
      ],
      transitionTo: 'self_assessment',

      guidance: `You are Compass — a warm, sharp career change navigator.

## YOUR PURPOSE
You are the welcome agent. Your sole job is to introduce Compass and collect three pieces of information:
1. The user's name
2. Their current role or situation
3. The direction they want to move toward

## HOW TO COLLECT
- **First message:** Introduce yourself warmly. Explain that Compass helps people navigate career transitions — it'll run a quick self-assessment and deliver a personalized plan. Then ask for their name.
- **Once you have their name:** Ask what they do currently (or have done most recently).
- **Once you have their role:** Ask what industry or direction they're drawn to.
- If they give multiple pieces at once — great, acknowledge everything and move forward.

## RULES
- 2–3 sentences max per message
- Be warm, curious, and encouraging — career changes take courage
- Do NOT dive into advice or assessment yet
- Do NOT ask for multiple fields in one message
- The system will transition automatically once all 3 are collected`,

      model: 'gpt-5-chat-latest',
      maxTokens: 512,
      tools: [],
      knowledgeBase: null
    });
  }

  /**
   * Transition when all 3 fields are collected.
   * Persists seeker_profile to user-level context before transitioning.
   */
  async preMessageTransfer(collectedFields) {
    const { seeker_name, current_role, target_industry } = collectedFields;
    if (!seeker_name || !current_role || !target_industry) return false;

    // Persist profile to user-level context for downstream crews
    await this.writeContext('seeker_profile', {
      seekerName: seeker_name,
      currentRole: current_role,
      targetIndustry: target_industry,
      profiledAt: new Date().toISOString()
    });

    console.log(`🧭 Compass: Seeker profile saved — ${seeker_name} (${current_role} → ${target_industry})`);
    return true;
  }

  async buildContext(params) {
    const base = await super.buildContext(params);
    const f = params.collectedFields || {};

    const missing = this.fieldsToCollect.filter(field => !f[field.name]);
    const collected = this.fieldsToCollect.filter(field => !!f[field.name]);

    return {
      ...base,
      role: 'Welcome and profile collection',
      fieldsAlreadyCollected: collected.map(field => `${field.name}: ${f[field.name]}`),
      fieldsStillNeeded: missing.map(field => `${field.name} — ${field.description}`),
      instruction: missing.length > 0
        ? `Still need: ${missing.map(field => field.name).join(', ')}. Ask naturally, one at a time.`
        : 'All fields collected. System will transition automatically.',
      note: 'Check the current message for new values before asking for anything already mentioned.'
    };
  }
}

module.exports = CompassIntakeCrew;
