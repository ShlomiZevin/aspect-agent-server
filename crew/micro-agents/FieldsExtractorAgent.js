/**
 * Fields Extractor Micro-Agent
 *
 * A lightweight, stateless agent that extracts structured field data from
 * conversation messages. Runs in parallel with the main crew response
 * using a smaller/faster model (GPT-4o-mini) for cost efficiency.
 *
 * Input: recent messages, fields to collect, already collected fields
 * Output: extracted fields (JSON), remaining fields
 */
const llmService = require('../../services/llm');

const EXTRACTOR_SYSTEM_PROMPT = `You are a field extraction agent. Your ONLY job is to extract specific fields from a conversation.

RULES:
- Only extract fields that are clearly and explicitly stated by the user
- Do not infer, guess, or assume values
- If a field value is ambiguous, do not extract it
- Only look at user messages for field values (ignore assistant messages)
- If a field was already collected, only update it if the user explicitly provides a new value

You MUST respond with a JSON object in this exact format:
{
  "extractedFields": { "fieldName": "value" },
  "remainingFields": ["fieldName1", "fieldName2"]
}

- "extractedFields": only include fields that were found in the conversation (can be empty {})
- "remainingFields": list field names that have NOT been collected yet (can be empty [])`;

class FieldsExtractorAgent {
  /**
   * Extract fields from recent conversation messages
   *
   * @param {Object} params - Extraction parameters
   * @param {Array} params.recentMessages - Recent messages [{role, content}, ...]
   * @param {Array} params.fieldsToCollect - Fields to extract [{name, description}, ...]
   * @param {Object} params.collectedFields - Already collected fields {name: value, ...}
   * @returns {Promise<Object>} - { extractedFields: {}, remainingFields: [] }
   */
  async extract({ recentMessages, fieldsToCollect, collectedFields }) {
    // Build the user message with context
    const fieldDescriptions = fieldsToCollect
      .map(f => `- ${f.name}: ${f.description}`)
      .join('\n');

    const collectedSummary = Object.keys(collectedFields).length > 0
      ? Object.entries(collectedFields).map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : '(none collected yet)';

    const messagesText = recentMessages
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n');

    const userMessage = `## Fields to Extract
${fieldDescriptions}

## Already Collected
${collectedSummary}

## Recent Conversation
${messagesText}

Extract any field values from the conversation above. Return JSON.`;

    try {
      const responseText = await llmService.sendOneShot(
        EXTRACTOR_SYSTEM_PROMPT,
        userMessage,
        { model: 'gpt-4o-mini', maxTokens: 512, jsonOutput: true }
      );

      const parsed = JSON.parse(responseText);

      return {
        extractedFields: parsed.extractedFields || {},
        remainingFields: parsed.remainingFields || []
      };
    } catch (error) {
      console.error('❌ Fields extractor error:', error.message);
      // On failure, return empty result (don't block the main response)
      return {
        extractedFields: {},
        remainingFields: fieldsToCollect.map(f => f.name)
      };
    }
  }
}

// Export singleton instance
module.exports = new FieldsExtractorAgent();
