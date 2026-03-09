/**
 * Thinking Advisor Micro-Agent
 *
 * A general-purpose reasoning agent that any crew can use to get strategic
 * advice before responding. Runs a thinking LLM (default: Claude) via
 * sendOneShot and returns structured advice.
 *
 * Usage in any crew's buildContext():
 *   const advice = await thinkingAdvisor.think({
 *     thinkingPrompt: 'You are a strategic advisor...',
 *     context: 'conversation history + data...'
 *   });
 *
 * Input: thinking prompt (system), context string (user message)
 * Output: parsed JSON advice (or raw string if jsonOutput: false)
 */
const llmService = require('../../services/llm');

class ThinkingAdvisorAgent {
  /**
   * Run a thinking/reasoning step and return structured advice.
   *
   * @param {Object} params
   * @param {string} params.thinkingPrompt - System prompt defining the reasoning task
   * @param {string} params.context - Formatted context string (conversation, data, etc.)
   * @param {Object} [options]
   * @param {string} [options.model] - Model to use (default: claude-sonnet-4-20250514)
   * @param {number} [options.maxTokens] - Max tokens (default: 1024)
   * @param {boolean} [options.jsonOutput] - Request JSON output (default: true)
   * @returns {Promise<Object|string>} Parsed JSON advice or raw string
   */
  async think({ thinkingPrompt, context }, options = {}) {
    const {
      model = 'claude-sonnet-4-20250514',
      maxTokens = 1024,
      jsonOutput = true
    } = options;

    try {
      console.log(`   🧠 [ThinkingAdvisor] Running with model: ${model}`);

      const responseText = await llmService.sendOneShot(
        thinkingPrompt,
        context,
        { model, maxTokens, jsonOutput, context: 'thinking-advisor' }
      );

      console.log(`   🧠 [ThinkingAdvisor] Response received (${responseText.length} chars)`);

      if (jsonOutput) {
        const result = JSON.parse(responseText);
        // Enforce _thinkingDescription for UI display
        if (!result._thinkingDescription) {
          result._thinkingDescription = 'Analysis complete';
        }
        return result;
      }
      return responseText;
    } catch (error) {
      console.error('   ❌ [ThinkingAdvisor] Error:', error.message);
      return jsonOutput ? { error: true, fallback: true } : '';
    }
  }
}

module.exports = new ThinkingAdvisorAgent();
