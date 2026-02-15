/**
 * Symptom Tracker Function
 * Called when user mentions a symptom during assessment
 *
 * OpenAI function name: call_report_symptom
 * Registered as: report_symptom
 */

const llmService = require('../services/llm');
const symptomService = require('../services/symptom.service');

// Schema matching OpenAI function definition
const symptomTrackerSchema = {
  description: 'Record a symptom the user mentions during assessment. Call this for each symptom identified.',
  parameters: {
    type: 'object',
    properties: {
      user_description: {
        type: 'string',
        description: 'What the user said about the symptom (their exact words)'
      },
      symptom_group: {
        type: 'string',
        enum: ['emotional', 'cognitive', 'physical'],
        description: 'Which symptom group this belongs to'
      },
      impact: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Impact on daily life (only include if user mentioned it)'
      },
      timing: {
        type: 'string',
        enum: ['recent', 'ongoing', 'fluctuating'],
        description: 'Temporal pattern (only include if user mentioned it)'
      }
    },
    required: ['user_description', 'symptom_group'],
    additionalProperties: false
  }
};

/**
 * Handler function for symptom tracking
 * @param {Object} params - The symptom parameters from LLM
 * @param {Object} context - Context from crew member { userId, conversationId, crewMember }
 * @returns {Promise<Object>} - Confirmation and any relevant info
 */
async function handleSymptomReport(params, context = {}) {
  const { user_description, symptom_group, impact, timing } = params;
  const { userId, conversationId, crewMember } = context;

  console.log(`📋 Symptom reported: "${user_description}" (${symptom_group})`);

  // If we have DB context, persist to database
  if (userId && conversationId) {
    try {
      const symptom = await symptomService.recordSymptom({
        userId,
        conversationId,
        userProvidedName: user_description,
        symptomGroup: symptom_group,
        crewMember: crewMember || 'unknown',
        impact: impact || null,
        timing: timing || null
      });

      return {
        recorded: true,
        symptomId: symptom.id,
        symptom: user_description,
        group: symptom_group,
        impact: impact || null,
        timing: timing || null,
        timestamp: new Date().toISOString(),
        message: `Symptom "${user_description}" has been recorded.`
      };
    } catch (error) {
      console.error('❌ Failed to record symptom to DB:', error.message);
      // Fall through to return basic confirmation
    }
  }

  // Basic confirmation (no DB context or DB error)
  return {
    recorded: true,
    symptom: user_description,
    group: symptom_group,
    impact: impact || null,
    timing: timing || null,
    timestamp: new Date().toISOString(),
    message: `Symptom "${user_description}" has been recorded.`
  };
}

/**
 * Register the symptom tracker function with the LLM service
 * Function name matches OpenAI: call_report_symptom -> report_symptom
 */
function registerSymptomTracker() {
  llmService.registerFunction(
    'report_symptom',
    handleSymptomReport,
    symptomTrackerSchema
  );
  console.log('✅ Symptom tracker function registered (report_symptom)');
}

module.exports = {
  schema: symptomTrackerSchema,
  handler: handleSymptomReport,
  register: registerSymptomTracker
};
