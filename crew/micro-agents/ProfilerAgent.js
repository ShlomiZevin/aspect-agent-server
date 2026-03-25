/**
 * Profiler Micro-Agent
 *
 * A generic, async background LLM that runs after each user message to build
 * a structured user profile. Completely decoupled from the conversation flow.
 *
 * Simple design:
 * - Takes a profiler prompt (plain text with fields baked in) + conversation history + existing profile
 * - Returns a full profile JSON — whatever the LLM learned so far
 * - No schema injection, no delta merging — the prompt IS the source of truth
 */
const llmService = require('../../services/llm');

class ProfilerAgent {
  /**
   * Run the profiler and return the profile JSON.
   *
   * @param {Object} params
   * @param {string} params.profilerPrompt - The full profiler prompt (with fields defined inside)
   * @param {Array} params.conversationHistory - Recent messages [{role, content}]
   * @param {Object} [params.existingProfile] - Current profile data from context
   * @returns {Promise<Object>} Profile JSON as returned by the LLM
   */
  async run({ profilerPrompt, conversationHistory, existingProfile }, options = {}) {
    const {
      model = 'claude-sonnet-4-6',
      maxTokens = 4096,
    } = options;

    // Build the user context message
    const contextParts = [];

    // 1. Existing profile
    if (existingProfile && Object.keys(existingProfile).length > 0) {
      contextParts.push(`## Existing Profile\n${JSON.stringify(existingProfile, null, 2)}`);
    } else {
      contextParts.push(`## Existing Profile\nEmpty — this is the first profiling run.`);
    }

    // 2. Conversation history
    if (conversationHistory && conversationHistory.length > 0) {
      const historyText = conversationHistory
        .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`)
        .join('\n\n');
      contextParts.push(`## Recent Conversation\n${historyText}`);
    }

    const contextMessage = contextParts.join('\n\n---\n\n');

    try {
      console.log(`   📊 [Profiler] Running with model: ${model}`);

      const responseText = await llmService.sendOneShot(
        profilerPrompt,
        contextMessage,
        { model, maxTokens, jsonOutput: true, context: 'profiler' }
      );

      console.log(`   📊 [Profiler] Response received (${responseText.length} chars)`);

      // Parse JSON response
      const cleaned = responseText
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
      const result = JSON.parse(cleaned);

      return result;
    } catch (error) {
      console.error('   ❌ [Profiler] Error:', error.message);
      return { _error: true, _message: error.message };
    }
  }
}

module.exports = new ProfilerAgent();
