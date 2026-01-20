/**
 * Symptom Tracker Function
 * Called when user mentions a symptom during conversation
 *
 * OpenAI function name: call_report_symptom
 * Registered as: report_symptom
 */

const llmService = require('../services/llm');

// Schema matching OpenAI function definition
const symptomTrackerSchema = {
  description: 'Everytime a user mentioning any symptom he has',
  parameters: {
    type: 'object',
    properties: {
      symptom_name: {
        type: 'string',
        description: 'Name or description of the symptom or health issue reported by the user.'
      }
    },
    required: ['symptom_name'],
    additionalProperties: false
  }
};

/**
 * Handler function for symptom tracking
 * Matches OpenAI schema: { symptom_name: string }
 * @param {Object} params - The symptom parameters from OpenAI
 * @returns {Promise<Object>} - Confirmation and any relevant info
 */
async function handleSymptomReport(params) {
  const { symptom_name } = params;

  console.log(`📋 Symptom reported: ${symptom_name}`);

  // TODO: Save to database, trigger notifications, etc.
  // This is where you'd integrate with your symptom tracking system

  return {
    recorded: true,
    symptom: symptom_name,
    timestamp: new Date().toISOString(),
    message: `Symptom "${symptom_name}" has been recorded.`
  };
}

/**
 * Register the symptom tracker function with the LLM service
 * Function name matches OpenAI: call_report_symptom -> report_symptom
 */
function registerSymptomTracker() {
  llmService.registerFunction(
    'report_symptom',  // Matches "call_report_symptom" from OpenAI
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
