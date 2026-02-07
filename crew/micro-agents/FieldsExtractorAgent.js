/**
 * Fields Extractor Micro-Agent
 *
 * A lightweight, stateless agent that extracts structured field data from
 * conversation messages. Runs in parallel with the main crew response.
 *
 * Supports two extraction modes:
 * - 'conversational' (default): Uses recent messages, contextual extraction (GPT-4o-mini)
 * - 'form': Strict mode, only extracts from last user message, better for forms (GPT-4o)
 *
 * Input: recent messages, fields to collect, already collected fields, mode
 * Output: extracted fields (JSON), remaining fields
 */
const llmService = require('../../services/llm');

// Default conversational mode prompt (existing behavior)
const CONVERSATIONAL_SYSTEM_PROMPT = `You are a field extraction agent. Your ONLY job is to extract specific fields from a conversation.

RULES:
- Extract field values from USER messages only
- Use ASSISTANT messages for CONTEXT to understand what the user is responding to
- Do not infer or guess values - but DO understand conversational context
- For acknowledgement/confirmation fields: if the assistant asks a yes/no question and the user responds affirmatively (yes, okay, sure, כן, בסדר, etc.), that counts as acknowledgement
- If a field was already collected, only update it if the user explicitly provides a new value
- Support multiple languages (Hebrew, English, etc.)

CONTEXTUAL EXTRACTION:
When extracting fields like "tos_acknowledged" or similar confirmation fields:
- Look at what the assistant said/asked immediately before the user's response
- If the assistant presented terms/disclaimer and asked for confirmation, and the user responds with ANY affirmative response (yes, okay, sure, I understand, כן, בסדר, מתאים לי, etc.), extract as "true"

You MUST respond with a JSON object in this exact format:
{
  "extractedFields": { "fieldName": "value" },
  "remainingFields": ["fieldName1", "fieldName2"]
}

- "extractedFields": only include fields that were found in the conversation (can be empty {})
- "remainingFields": list field names that have NOT been collected yet (can be empty [])`;

// Form mode prompt - stricter, only last message, captures negative answers and corrections
const FORM_SYSTEM_PROMPT = `You are a STRICT field extraction agent for form-like data collection. Your ONLY job is to extract specific fields from the user's LAST message.

CRITICAL RULES:
1. ONLY extract from the LAST USER MESSAGE - ignore all previous messages
2. The assistant's previous message provides context for what was asked
3. Extract EXACTLY what the user said - do not guess or infer
4. NEGATIVE ANSWERS ARE VALID VALUES:
   - "No", "None", "N/A", "Not applicable", "We don't have that" → Extract as provided
   - "No" is a complete, valid answer - extract it
   - Don't leave a field empty if the user answered with a negative
5. YES/NO QUESTIONS:
   - If asked a yes/no question and user says "yes"/"no" → Extract "Yes" or "No"
   - If user says "we do" or "we don't" → Extract "Yes" or "No" accordingly
6. For multi-part questions answered together, extract all applicable fields

CORRECTIONS:
- If the user EXPLICITLY corrects a previously collected field, include it in "corrections"
- Correction signals: "actually...", "I meant...", "correction:", "sorry, it's...", "let me fix that", "that should be..."
- ONLY add to corrections if user is clearly fixing a previous answer
- Do NOT add to corrections just because a value appears in the message

EXTRACTION GUIDELINES:
- User says "no" or "none" → Extract "No" or "None" (this IS a valid collected value)
- User says "we don't have any" → Extract "None"
- User says "not applicable" → Extract "N/A"
- User provides details → Extract the details
- User doesn't address a field at all → Don't extract anything for that field

You MUST respond with a JSON object in this exact format:
{
  "extractedFields": { "fieldName": "value" },
  "corrections": { "fieldName": "newValue" },
  "remainingFields": ["fieldName1", "fieldName2"]
}

- "extractedFields": NEW fields with values from this message (from Fields to Extract list)
- "corrections": previously collected fields that user EXPLICITLY corrected (can be empty {})
- "remainingFields": fields from Fields to Extract list NOT addressed in this message`;

class FieldsExtractorAgent {
  /**
   * Extract fields from recent conversation messages
   *
   * @param {Object} params - Extraction parameters
   * @param {Array} params.recentMessages - Recent messages [{role, content}, ...]
   * @param {Array} params.fieldsToCollect - Fields to extract [{name, description}, ...]
   * @param {Object} params.collectedFields - Already collected fields {name: value, ...}
   * @param {string} params.extractionMode - 'conversational' (default) or 'form'
   * @returns {Promise<Object>} - { extractedFields: {}, corrections: {}, remainingFields: [] }
   */
  async extract({ recentMessages, fieldsToCollect, collectedFields, extractionMode = 'conversational' }) {
    const isFormMode = extractionMode === 'form';
    const systemPrompt = isFormMode ? FORM_SYSTEM_PROMPT : CONVERSATIONAL_SYSTEM_PROMPT;

    // Build the field descriptions
    const fieldDescriptions = fieldsToCollect
      .map(f => `- ${f.name}: ${f.description}`)
      .join('\n');

    // For form mode, we only care about the last exchange
    // For conversational mode, we use all recent messages
    let relevantMessages = recentMessages;
    if (isFormMode && recentMessages.length >= 2) {
      // Get only the last assistant message (for context) and last user message
      const lastUserIdx = recentMessages.map(m => m.role).lastIndexOf('user');
      if (lastUserIdx > 0) {
        // Include the assistant message before the last user message
        relevantMessages = recentMessages.slice(lastUserIdx - 1);
      } else if (lastUserIdx === 0) {
        relevantMessages = [recentMessages[lastUserIdx]];
      }
    }

    const collectedSummary = Object.keys(collectedFields).length > 0
      ? Object.entries(collectedFields).map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : '(none collected yet)';

    const messagesText = relevantMessages
      .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
      .join('\n\n');

    // Different user message formatting for form mode
    const userMessage = isFormMode
      ? `## Fields to Extract (from LAST user message only)
${fieldDescriptions}

## Already Collected (can be corrected if user EXPLICITLY fixes them)
${collectedSummary}

## Conversation (focus on LAST USER message)
${messagesText}

Extract field values from the LAST USER message above. Remember: "No", "None", "N/A" are VALID values to extract. If user explicitly corrects a previously collected field, include it in "corrections". Return JSON.`
      : `## Fields to Extract
${fieldDescriptions}

## Already Collected
${collectedSummary}

## Recent Conversation
${messagesText}

Extract any field values from the conversation above. Return JSON.`;

    // Use gpt-4o for form mode (more precise), gpt-4o-mini for conversational (faster/cheaper)
    const model = isFormMode ? 'gpt-4o' : 'gpt-4o-mini';

    try {
      const responseText = await llmService.sendOneShot(
        systemPrompt,
        userMessage,
        { model, maxTokens: 512, jsonOutput: true }
      );

      const parsed = JSON.parse(responseText);

      return {
        extractedFields: parsed.extractedFields || {},
        corrections: parsed.corrections || {},
        remainingFields: parsed.remainingFields || []
      };
    } catch (error) {
      console.error('❌ Fields extractor error:', error.message);
      // On failure, return empty result (don't block the main response)
      return {
        extractedFields: {},
        corrections: {},
        remainingFields: fieldsToCollect.map(f => f.name)
      };
    }
  }
}

// Export singleton instance
module.exports = new FieldsExtractorAgent();
