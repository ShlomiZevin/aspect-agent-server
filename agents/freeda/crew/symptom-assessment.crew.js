/**
 * Freeda Symptom Assessment Crew Member
 *
 * Structured Symptom Group Assessment (Section 3 of Playbook)
 *
 * This crew handles exploration of 3 symptom groups:
 * - Emotional (anxiety, mood swings, irritability, etc.)
 * - Cognitive (brain fog, memory issues, concentration, etc.)
 * - Physical (hot flashes, sleep issues, fatigue, etc.)
 *
 * The order is determined by the profiler's journey analysis.
 * Each group follows the same pattern:
 * 1. Introduce the group with relatable examples
 * 2. Help user recognize and name experiences
 * 3. For identified symptoms: capture impact and timing
 * 4. Provide micro-insights (validation, normalization)
 * 5. Move to next group when complete
 *
 * Transitions:
 * - After all 3 groups explored -> 'assessment_closure' (summary & companion positioning)
 */
const CrewMember = require('../../../crew/base/CrewMember');
const symptomTracker = require('../../../functions/symptom-tracker');
const symptomGroupCompletion = require('../../../functions/symptom-group-completion');

class FreedaSymptomAssessmentCrew extends CrewMember {
  constructor() {
    super({
      name: 'symptom_assessment',
      displayName: 'Symptom Assessment',
      description: 'Structured symptom exploration across emotional, cognitive, and physical groups',
      isDefault: false,

      transitionTo: 'assessment_closure',

      guidance: `You are Freeda, continuing your warm conversation with the user who has just completed the profiling stage.

## YOUR PURPOSE IN THIS STAGE
You are conducting a structured symptom assessment across three groups: Emotional, Cognitive, and Physical.
Your goal is to help the user recognize, name, and share symptoms they may be experiencing.

## CONTEXT VARIABLES
The context will tell you:
- \`currentGroup\`: Which symptom group to explore now (emotional, cognitive, or physical)
- \`groupsCompleted\`: Which groups have already been explored
- \`userName\`: User's name (use it naturally)

## HOW TO EXPLORE EACH SYMPTOM GROUP

### 1. Introduce the Group
Start by explaining what this group includes with relatable examples:

**Emotional:**
"Let's talk about how things have been emotionally. Many women notice changes like feeling more anxious, having mood swings, or feeling irritable over things that wouldn't have bothered them before."

**Cognitive:**
"Now let's explore how things have been mentally. Some women describe it as 'brain fog' - difficulty concentrating, forgetting words mid-sentence, or feeling like their mind isn't as sharp."

**Physical:**
"Let's look at physical changes. This can include things like hot flashes, night sweats, trouble sleeping, fatigue, or changes in your body."

### 2. Help Recognition
- Use examples that help users recognize experiences they may not have named
- Normalize ambiguity: "Sometimes it's hard to tell if something is a symptom or just life"
- Give language to fuzzy feelings: "Some women describe it as..."

### 3. For Each Symptom Identified
When the user mentions a symptom:
1. Call \`report_symptom\` with their exact words and the current group
2. Ask about impact: "How much does this affect your daily life?"
3. Ask about timing: "Is this something recent, or has it been ongoing?"
4. Provide a brief micro-insight (validation)

### 4. Micro-Insights (Keep Brief)
After capturing a symptom, offer a short validating insight:
- "Many women experience exactly this during this phase"
- "This is one of the most commonly reported symptoms"
- "It makes sense that this would feel overwhelming"
Do NOT give medical advice or interpret symptoms clinically.

### 5. Completing a Group
Use the correct tool based on what happened:

**If symptoms WERE identified:**
- Call \`complete_symptom_group\` after you've recorded symptoms with report_symptom
- Use when user says "that covers it", "nothing else", etc.

**If NO symptoms in this group:**
- Call \`skip_symptom_group\` IMMEDIATELY when user confirms no symptoms
- Use when user says "I don't have any of those", "none apply", "אין לי", "לא", "I feel fine there"
- Include what the user said in user_statement

After either tool, naturally transition to the next group.

## RULES

### Do's
- Explore ONE group at a time (check currentGroup in context)
- Use experiential language, not clinical terms
- Allow "none of these apply" responses - that's valid
- Keep responses to 2-4 sentences
- Use Freeda's emoji sparingly: 🌻
- Respond in the user's language
- Call the tools appropriately:
  - \`report_symptom\`: For each symptom mentioned
  - \`complete_symptom_group\`: After recording symptoms, when group is done
  - \`skip_symptom_group\`: When user confirms NO symptoms in this group (call immediately!)

### Don'ts
- Do NOT interpret symptoms medically
- Do NOT jump between groups (finish one before starting the next)
- Do NOT compare user to averages or norms
- Do NOT overwhelm with long lists of symptoms
- Do NOT skip the micro-insight after symptoms are shared
- Do NOT push if user says "none apply" - accept and move on

## ASSESSMENT COMPLETION
When completing the LAST (3rd) group, keep your response very brief and subtle:
- Give a warm 1-2 sentence acknowledgment ("Great to hear" / "Thanks for sharing")
- Do NOT ask any questions
- Do NOT announce a transition or "next step"
- Do NOT summarize what was discussed
- The next crew member will provide the main response
- Simply close your part gently, like a natural pause in conversation

Example for final group when user confirms no symptoms:
"מעולה שלומית 🌺 טוב לדעת שאת מרגישה טוב גם מהבחינה הקוגניטיבית."

That's it - short, warm, done. Another crew will continue.`,

      model: 'gpt-5-chat-latest',
      maxTokens: 1536,

      // Tools are set up with context wrappers in the constructor
      tools: [],

      knowledgeBase: null
    });

    // Set up tools with context wrappers
    // The wrapper passes userId, conversationId, and crewMember to the handler
    this.tools = [
      {
        name: 'report_symptom',
        description: symptomTracker.schema.description,
        parameters: symptomTracker.schema.parameters,
        handler: async (params) => {
          return symptomTracker.handler(params, {
            userId: this._userId,
            conversationId: this._conversationId,
            crewMember: this.name
          });
        }
      },
      {
        name: 'complete_symptom_group',
        description: symptomGroupCompletion.completeGroupSchema.description,
        parameters: symptomGroupCompletion.completeGroupSchema.parameters,
        handler: async (params) => {
          // Get the group order from journey profile
          const journeyProfile = await this.getContext('journey');
          const groupOrder = journeyProfile?.analysis?.symptomGroupPriority ||
            ['emotional', 'cognitive', 'physical'];

          return symptomGroupCompletion.handleCompleteGroup(params, {
            getContext: this.getContext.bind(this),
            writeContext: this.writeContext.bind(this),
            groupOrder
          });
        }
      },
      {
        name: 'skip_symptom_group',
        description: symptomGroupCompletion.skipGroupSchema.description,
        parameters: symptomGroupCompletion.skipGroupSchema.parameters,
        handler: async (params) => {
          // Get the group order from journey profile
          const journeyProfile = await this.getContext('journey');
          const groupOrder = journeyProfile?.analysis?.symptomGroupPriority ||
            ['emotional', 'cognitive', 'physical'];

          return symptomGroupCompletion.handleSkipGroup(params, {
            getContext: this.getContext.bind(this),
            writeContext: this.writeContext.bind(this),
            groupOrder
          });
        }
      }
    ];
  }

  /**
   * Build context for the LLM call.
   * Loads journey profile and assessment state.
   */
  async buildContext(params) {
    const baseContext = await super.buildContext(params);
    const collectedFields = params.collectedFields || {};

    // Load journey profile from profiler crew
    const journeyProfile = await this.getContext('journey');

    // Determine group order from profiler's analysis
    const groupOrder = journeyProfile?.analysis?.symptomGroupPriority ||
      ['emotional', 'cognitive', 'physical'];

    // Load or initialize assessment state
    let assessmentState = await this.getContext('symptom_assessment', true);

    if (!assessmentState) {
      // Initialize state on first call
      assessmentState = {
        currentGroup: groupOrder[0],
        groupsCompleted: [],
        groupOrder,
        groupOutcomes: {},
        startedAt: new Date().toISOString()
      };
      await this.writeContext('symptom_assessment', assessmentState, true);
      console.log(`📋 Initialized symptom assessment state, starting with: ${groupOrder[0]}`);
    }

    // Determine current group (first uncompleted in order)
    const currentGroup = groupOrder.find(g => !assessmentState.groupsCompleted.includes(g))
      || assessmentState.currentGroup;

    // Get symptom examples for current group
    const groupExamples = this._getGroupExamples(currentGroup);

    return {
      ...baseContext,
      role: 'Symptom Assessment - Structured exploration',
      stage: 'Section 3 - Symptom Group Assessment',

      // User info
      userName: collectedFields.name,

      // Assessment state
      currentGroup,
      groupsCompleted: assessmentState.groupsCompleted,
      groupOrder,
      totalGroups: 3,
      remainingGroups: 3 - assessmentState.groupsCompleted.length,

      // Group-specific context
      groupExamples,

      // Journey context for tone adjustment
      journeyPosition: journeyProfile?.analysis?.estimatedPosition || 'unknown',
      toneAdjustment: journeyProfile?.analysis?.toneAdjustment || 'warm_exploratory',

      isLastGroup: assessmentState.groupsCompleted.length === 2,
      instruction: assessmentState.groupsCompleted.length === 2
        ? `You are exploring the FINAL symptom group ("${currentGroup}"). When this group is complete, give only a brief warm acknowledgment - no questions, no summary.`
        : `You are exploring the "${currentGroup}" symptom group. ${assessmentState.groupsCompleted.length} of 3 groups complete.`
    };
  }

  /**
   * Get example symptoms for each group (for context, not strict list)
   */
  _getGroupExamples(group) {
    const examples = {
      emotional: [
        'anxiety or feeling on edge',
        'mood swings',
        'irritability',
        'feeling low or down',
        'emotional sensitivity',
        'feeling overwhelmed'
      ],
      cognitive: [
        'brain fog',
        'difficulty concentrating',
        'memory lapses',
        'word-finding difficulty',
        'mental fatigue',
        'feeling less sharp'
      ],
      physical: [
        'hot flashes',
        'night sweats',
        'sleep disturbances',
        'fatigue',
        'joint or muscle pain',
        'changes in weight or appetite'
      ]
    };

    return examples[group] || [];
  }

  /**
   * Post-message transfer check.
   * Transitions when all 3 groups have been completed.
   *
   * NOTE: Must be postMessageTransfer (not pre) because the tool calls
   * (skip_symptom_group, complete_symptom_group) update the state during
   * the LLM response. We need to check AFTER those tools have run.
   */
  async postMessageTransfer(collectedFields) {
    const state = await this.getContext('symptom_assessment', true);

    if (state?.groupsCompleted?.length >= 3) {
      console.log('✅ All symptom groups complete, preparing to transition');

      // Save summary to user-level context for General crew
      await this.writeContext('symptom_summary', {
        outcomes: state.groupOutcomes,
        groupOrder: state.groupOrder,
        completedAt: new Date().toISOString(),
        assessedBy: this.name
      });

      return true; // Trigger transition to 'general'
    }

    return false;
  }
}

module.exports = FreedaSymptomAssessmentCrew;
