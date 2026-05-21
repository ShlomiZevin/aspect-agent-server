/**
 * LLM Usage Logger
 *
 * Fire-and-forget logging of token usage per LLM call.
 * Never throws, never blocks — just inserts a row and moves on.
 */
const db = require('./db.pg');
const { llmUsage } = require('../db/schema');
const modelsService = require('./models.service');

/**
 * Derive provider name from model id by consulting the central
 * models registry. Falls back to 'openai' for unknown ids so a
 * one-off log line never throws.
 *
 * @param {string} model
 * @returns {string} 'anthropic' | 'google' | 'openai'
 */
function getProviderFromModel(model) {
  return modelsService.tryProviderOf(model) || 'openai';
}

/**
 * Log an LLM usage record.
 * Provider is auto-derived from model name if not explicitly passed.
 *
 * @param {Object} params
 * @param {string} params.process - "conversation" | "thinker" | "field_extractor" | "profiler"
 * @param {string} params.model - Model used (e.g., "claude-sonnet-4-6")
 * @param {string} [params.provider] - Optional — auto-derived from model if omitted
 * @param {number} params.inputTokens - Input/prompt tokens
 * @param {number} params.outputTokens - Output/completion tokens
 * @param {string} [params.agentName] - Agent name
 * @param {string} [params.crewMember] - Crew member name
 * @param {string} [params.conversationId] - Conversation external ID
 * @param {number|string} [params.userId] - User ID
 */
function logUsage({ process, model, provider, inputTokens, outputTokens, durationMs, agentName, crewMember, conversationId, userId }) {
  try {
    const drizzle = db.getDrizzle();
    drizzle.insert(llmUsage).values({
      process,
      model: model || 'unknown',
      provider: provider || getProviderFromModel(model),
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      durationMs: durationMs || null,
      agentName: agentName || null,
      crewMember: crewMember || null,
      conversationId: conversationId || null,
      userId: userId || null,
    }).execute().catch(err => {
      console.warn('⚠️ [UsageLogger] DB insert failed:', err.message);
    });
  } catch (err) {
    console.warn('⚠️ [UsageLogger] Error:', err.message);
  }
}

module.exports = { logUsage, getProviderFromModel };
