/**
 * Symptom Group Completion Functions
 * Two separate tools for clarity:
 * 1. complete_symptom_group - after exploring symptoms with the user
 * 2. skip_symptom_group - when user confirms NO symptoms in a group
 */

const llmService = require('../services/llm');

// Shared helper to update assessment state
async function updateAssessmentState(symptom_group, outcome, user_statement, context) {
  const { getContext, writeContext, groupOrder } = context;
  const defaultGroupOrder = ['emotional', 'cognitive', 'physical'];
  const order = groupOrder || defaultGroupOrder;

  if (!getContext || !writeContext) {
    // Basic response without persistence
    const nextGroup = order.find(g => g !== symptom_group);
    return {
      recorded: true,
      completedGroup: symptom_group,
      outcome,
      nextGroup: nextGroup || null,
      allGroupsComplete: false,
      message: `${symptom_group} group noted. Continue with the assessment.`
    };
  }

  try {
    // Get current assessment state
    let state = await getContext('symptom_assessment', true) || {
      currentGroup: null,
      groupsCompleted: [],
      groupOrder: order,
      groupOutcomes: {},
      startedAt: new Date().toISOString()
    };

    // Mark this group as completed
    if (!state.groupsCompleted.includes(symptom_group)) {
      state.groupsCompleted.push(symptom_group);
    }

    // Record the outcome
    state.groupOutcomes = state.groupOutcomes || {};
    state.groupOutcomes[symptom_group] = {
      outcome,
      userStatement: user_statement || null,
      completedAt: new Date().toISOString()
    };

    // Determine next group
    const nextGroup = state.groupOrder.find(g => !state.groupsCompleted.includes(g));
    state.currentGroup = nextGroup || null;

    // Save updated state
    await writeContext('symptom_assessment', state, true);

    const allGroupsComplete = state.groupsCompleted.length >= 3;

    console.log(`📊 Assessment progress: ${state.groupsCompleted.length}/3 groups complete`);
    if (allGroupsComplete) {
      console.log('🎉 All symptom groups complete!');
    } else if (nextGroup) {
      console.log(`➡️ Next group: ${nextGroup}`);
    }

    return {
      recorded: true,
      completedGroup: symptom_group,
      outcome,
      nextGroup: nextGroup || null,
      allGroupsComplete,
      groupsCompleted: state.groupsCompleted,
      message: allGroupsComplete
        ? 'All symptom groups have been explored. Ready to transition to the next phase.'
        : `${symptom_group} group complete. Moving to ${nextGroup} symptoms.`
    };
  } catch (error) {
    console.error('❌ Failed to update assessment state:', error.message);
    const nextGroup = order.find(g => g !== symptom_group);
    return {
      recorded: true,
      completedGroup: symptom_group,
      outcome,
      nextGroup: nextGroup || null,
      allGroupsComplete: false,
      message: `${symptom_group} group noted. Continue with the assessment.`
    };
  }
}

// ============================================================================
// TOOL 1: complete_symptom_group
// For when symptoms WERE identified and explored
// ============================================================================

const completeGroupSchema = {
  description: `Call this AFTER you have recorded symptoms using report_symptom and finished exploring this group.
Use this when the user HAS identified symptoms and you've discussed them.
Example triggers: "that's all for this area", "I think we covered it", after user confirms no more symptoms to add.`,
  parameters: {
    type: 'object',
    properties: {
      symptom_group: {
        type: 'string',
        enum: ['emotional', 'cognitive', 'physical'],
        description: 'The symptom group that was just explored'
      }
    },
    required: ['symptom_group'],
    additionalProperties: false
  }
};

async function handleCompleteGroup(params, context = {}) {
  const { symptom_group } = params;
  console.log(`✅ Completing symptom group (symptoms found): ${symptom_group}`);
  return updateAssessmentState(symptom_group, 'symptoms_identified', null, context);
}

// ============================================================================
// TOOL 2: skip_symptom_group
// For when user confirms NO symptoms in this group
// ============================================================================

const skipGroupSchema = {
  description: `Call this when the user confirms they have NO symptoms in this group.
IMPORTANT: Call this tool when user says things like:
- "I don't have any of those"
- "None of those apply to me"
- "No, I feel fine in that area"
- "I'm good there"
- "לא" / "אין לי" / "אני בסדר"
- Any clear confirmation that this symptom category doesn't affect them

Do NOT wait - call this immediately when user confirms no symptoms.`,
  parameters: {
    type: 'object',
    properties: {
      symptom_group: {
        type: 'string',
        enum: ['emotional', 'cognitive', 'physical'],
        description: 'The symptom group where user has no symptoms'
      },
      user_statement: {
        type: 'string',
        description: 'What the user said (e.g., "I don\'t have any of those", "אין לי")'
      }
    },
    required: ['symptom_group', 'user_statement'],
    additionalProperties: false
  }
};

async function handleSkipGroup(params, context = {}) {
  const { symptom_group, user_statement } = params;
  console.log(`⏭️ Skipping symptom group (no symptoms): ${symptom_group} - "${user_statement}"`);
  return updateAssessmentState(symptom_group, 'no_symptoms_reported', user_statement, context);
}

// ============================================================================
// Registration
// ============================================================================

function registerCompleteSymptomGroup() {
  llmService.registerFunction(
    'complete_symptom_group',
    handleCompleteGroup,
    completeGroupSchema
  );
  console.log('✅ complete_symptom_group registered (for when symptoms were found)');
}

function registerSkipSymptomGroup() {
  llmService.registerFunction(
    'skip_symptom_group',
    handleSkipGroup,
    skipGroupSchema
  );
  console.log('✅ skip_symptom_group registered (for when NO symptoms in group)');
}

function registerAll() {
  registerCompleteSymptomGroup();
  registerSkipSymptomGroup();
}

module.exports = {
  // Schemas
  completeGroupSchema,
  skipGroupSchema,
  // Handlers
  handleCompleteGroup,
  handleSkipGroup,
  // Registration
  registerCompleteSymptomGroup,
  registerSkipSymptomGroup,
  register: registerAll
};
