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
  async run({ profilerPrompt, conversationHistory, collectedFields, existingProfile, processStatus }, options = {}) {
    const {
      model = 'claude-sonnet-4-6',
      maxTokens = 4096,
    } = options;

    // Build the user context message
    const parts = [];

    // Process status — tells the profiler whether the customer completed the onboarding or is still in progress
    // Drives the recommendations cluster scenario (in_progress = gap-closing actions, completed = product recommendations)
    if (processStatus) {
      parts.push(`## Process Status\n${processStatus}`);
    }

    // Current profile state — so the LLM knows what's already collected and can skip unchanged fields
    if (existingProfile && Object.keys(existingProfile).length > 0) {
      parts.push(`## Current Profile\n${JSON.stringify(existingProfile, null, 2)}`);
    }

    // Collected fields from crew extraction (captures data from older messages beyond the history window)
    if (collectedFields && Object.keys(collectedFields).length > 0) {
      parts.push(`## Collected Fields\n${JSON.stringify(collectedFields, null, 2)}`);
    }

    // Conversation history
    const historyText = (conversationHistory || [])
      .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`)
      .join('\n\n');
    parts.push(historyText || 'No messages yet.');

    const contextMessage = parts.join('\n\n---\n\n');

    try {
      console.log(`   📊 [Profiler] Running with model: ${model} (prompt: ${profilerPrompt.length} chars, context: ${contextMessage.length} chars)`);

      const { agentName, crewMember, conversationId, userId } = options;
      const responseText = await llmService.sendOneShot(
        profilerPrompt,
        contextMessage,
        { model, maxTokens, jsonOutput: true, context: 'profiler', agentName, crewMember, conversationId, userId }
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

  /**
   * Ask a question about the profile.
   *
   * @param {Object} params
   * @param {string} params.question - The question to ask
   * @param {Object} params.profileData - Current profile data
   * @param {Array} params.conversationHistory - Recent messages [{role, content}]
   * @param {Object} [options]
   * @param {string} [options.model] - Model to use
   * @returns {Promise<string>} The answer
   */
  async ask({ question, profileData, conversationHistory }, options = {}) {
    const { model = 'claude-sonnet-4-6' } = options;

    const systemPrompt = `You are a profile analyst. You have access to a user's profile data and their conversation history.
Answer the question based on the data provided. Be concise and specific.
Answer in the same language as the question.
If the data doesn't contain enough information to answer, say so.`;

    const historyText = conversationHistory
      .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`)
      .join('\n\n');

    const contextMessage = [
      '## Profile Data',
      profileData ? JSON.stringify(profileData, null, 2) : 'No profile data yet.',
      '',
      '## Conversation History',
      historyText || 'No messages yet.',
      '',
      '## Question',
      question,
    ].join('\n');

    const answer = await llmService.sendOneShot(
      systemPrompt,
      contextMessage,
      { model, maxTokens: 1024, jsonOutput: false, context: 'profiler-ask' }
    );

    return answer;
  }
}

module.exports = new ProfilerAgent();
