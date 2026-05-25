/**
 * Brainstorm Alfred — Claude Sonnet 4.6 streaming.
 *
 * P5.1: no tools, no proposals. Just an LLM call that takes the
 * system prompt + the human-readable project summary + recent chat
 * history and streams text tokens back through an `emit` callback.
 *
 * Caller (alfredRoute) is responsible for SSE plumbing — this module
 * only deals with the LLM. P5.2 will add the `propose` tool, P5.3
 * will add spec-doc tools.
 */

const claudeService = require('../../services/llm.claude');
const { logUsage } = require('../../services/usageLogger');
const { SYSTEM_PROMPT, buildProjectSummary } = require('./alfredContext');
const alfredChats = require('./alfredChats');

const ALFRED_MODEL    = 'claude-sonnet-4-6';
const ALFRED_PROCESS  = 'alfred-brainstorm';
const HISTORY_LIMIT   = 20;   // last N messages (~10 turns) per turn
const MAX_TOKENS      = 4096;

/**
 * Stream a response for a freshly-appended user message.
 *
 * Precondition: the caller has already inserted the user's message
 * into the chat — this function reads it back as the last entry in
 * the history before calling Claude.
 *
 * @param {object} args
 * @param {number} args.chatId      - conversations.id (kind='alfred')
 * @param {string} args.agentSlug
 * @param {string} args.ownerUserId
 * @param {(type: string, payload: object) => void} args.emit
 * @returns {Promise<{ assistantText: string }>}
 */
async function runBrainstormTurn({ chatId, agentSlug, ownerUserId, emit }) {
  const start = Date.now();

  // 1. Recent history (last N), already in chronological order.
  const all = await alfredChats.listMessages(chatId);
  const recent = all.slice(-HISTORY_LIMIT);

  // The latest user message lives at the end; we pass earlier turns
  // as `messages` and the latest one is implicit in that array.
  // Claude requires `messages` to start with 'user' and alternate.
  // We trust the schema: alfred chat history is strictly user/assistant.
  const messagesForClaude = recent
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  if (messagesForClaude.length === 0 || messagesForClaude[messagesForClaude.length - 1].role !== 'user') {
    // Shouldn't happen — caller appends the user message before invoking us.
    throw new Error('alfredRunner: last history message must be from the user');
  }

  // 2. Build the system prompt — static intro + dynamic project summary.
  const summary = await buildProjectSummary({ agentSlug, ownerUserId });
  const systemPrompt = `${SYSTEM_PROMPT}\n\n## Current project state\n${summary}`;

  // 3. Stream from Claude.
  let collected   = '';
  let firstTokenMs = null;
  let inputTokens  = 0;
  let outputTokens = 0;

  const client = claudeService.client;

  let stream;
  try {
    stream = await client.messages.stream({
      model:      ALFRED_MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      messages:   messagesForClaude,
    });
  } catch (err) {
    emit('alfred.error', { error: { code: 'stream_failed', message: err.message } });
    throw err;
  }

  try {
    for await (const event of stream) {
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens  += event.message.usage.input_tokens  || 0;
        outputTokens += event.message.usage.output_tokens || 0;
      }
      if (event.type === 'message_delta' && event.usage) {
        outputTokens += event.usage.output_tokens || 0;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        if (text) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - start;
          collected += text;
          emit('alfred.token', { token: text });
        }
      }
    }
  } catch (err) {
    emit('alfred.error', { error: { code: 'stream_aborted', message: err.message } });
    throw err;
  }

  const durationMs = Date.now() - start;

  // 4. Log usage. Fire-and-forget (logUsage swallows its own errors).
  logUsage({
    process:        ALFRED_PROCESS,
    model:          ALFRED_MODEL,
    inputTokens,
    outputTokens,
    durationMs,
    agentName:      agentSlug,
    conversationId: String(chatId),
    userId:         ownerUserId,
  });

  return {
    assistantText: collected,
    firstTokenMs,
    durationMs,
    tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
  };
}

module.exports = { runBrainstormTurn };
