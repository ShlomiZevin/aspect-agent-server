/**
 * HQ — the agent loop. This is what makes a worker feel like an employee
 * rather than a chatbot.
 *
 * Four mechanics, and only the last one is new:
 *
 *   1. A TOOL LOOP, not one completion. The model calls a tool, sees the
 *      result, and decides what to do next — repeatedly, until it's done.
 *   2. NARRATION while working, streamed as it happens.
 *   3. WORK THAT SURVIVES YOU LEAVING. The loop runs server-side and writes
 *      progress to the database; the browser is a window onto it, never the
 *      thing keeping it alive.
 *   4. A PLAN YOU CAN SEE. The model writes its own step list via `start_job`
 *      and ticks items off with `update_step`. This is the whole trick: an
 *      agent doesn't feel capable because it's clever mid-task, it feels
 *      capable because it says what it's going to do and then shows you it
 *      doing it.
 *
 * Nothing here knows what a worker DOES. Tools are passed in; the marketing
 * employee is just the first set.
 */

const claude = require('../../services/llm.claude');
const log = require('./log.service');
const db = require('../../services/db.pg');

/** Hard stop. A loop that can call tools forever must not be able to. */
const MAX_TURNS = 40;

/**
 * Run one exchange to completion.
 *
 * @param {Object}   opts
 * @param {string}   opts.system        - the worker's role definition
 * @param {Array}    opts.messages      - conversation so far, Anthropic shape
 * @param {Array}    opts.tools         - [{ name, description, input_schema, handler }]
 * @param {string}   opts.model
 * @param {Function} opts.onEvent       - ({type, ...}) for streaming to the UI
 * @param {Function} opts.shouldStop    - () => boolean, checked between turns
 * @returns {Promise<{ messages, text, toolCalls, usage }>}
 */
async function run({
  system,
  messages,
  tools = [],
  model = 'claude-sonnet-4-6',
  onEvent = null,
  shouldStop = () => false,
  workerName = 'hq-worker',
  conversationId = null,
} = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const schemas = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

  const working = [...messages];
  const toolCalls = [];
  let finalText = '';
  const usage = { inputTokens: 0, outputTokens: 0 };

  const who = workerName || 'worker';
  const runStarted = Date.now();
  let turnsUsed = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (shouldStop()) {
      onEvent?.({ type: 'stopped', reason: 'cancelled' });
      break;
    }

    turnsUsed = turn + 1;
    log.turn(who, turnsUsed, model);

    const startedAt = Date.now();
    const reply = await claude.sendAgentTurn({ system, messages: working, tools: schemas, model });
    usage.inputTokens += reply.usage.inputTokens;
    usage.outputTokens += reply.usage.outputTokens;
    await logUsage({
      model, usage: reply.usage, workerName, conversationId,
      durationMs: Date.now() - startedAt,
    });

    // Anything the model said out loud this turn.
    for (const block of reply.content) {
      if (block.type === 'text' && block.text.trim()) {
        finalText = block.text;
        log.said(who, block.text);
        onEvent?.({ type: 'text', text: block.text });
      }
    }

    // The assistant turn must be echoed back verbatim — Anthropic requires the
    // original tool_use blocks to sit alongside their tool_result replies.
    working.push({ role: 'assistant', content: reply.content });

    if (reply.stopReason !== 'tool_use') break;

    const requests = reply.content.filter(b => b.type === 'tool_use');
    const results = [];

    for (const call of requests) {
      const tool = byName.get(call.name);
      log.toolStart(who, call.name, call.input);
      onEvent?.({ type: 'tool_start', tool: call.name, input: call.input, id: call.id });

      const toolStartedAt = Date.now();
      let result;
      try {
        if (!tool) throw new Error(`No such tool: ${call.name}`);
        result = await tool.handler(call.input, { onEvent, conversationId });
        log.toolDone(who, call.name, Date.now() - toolStartedAt, result);
        onEvent?.({ type: 'tool_done', tool: call.name, id: call.id, result });
      } catch (err) {
        // A failing tool is information, not a crash: hand the model the error
        // so it can adapt, exactly as a person would on hitting a wall.
        result = { error: err.message };
        log.toolFailed(who, call.name, Date.now() - toolStartedAt, err.message);
        onEvent?.({ type: 'tool_failed', tool: call.name, id: call.id, error: err.message });
      }

      toolCalls.push({ name: call.name, input: call.input, result });

      // A tool can hand back content BLOCKS rather than a string — which is how
      // an image gets in front of the model. Without this, a worker that makes
      // pictures can never look at one, and "check your own work" is not
      // possible however it is worded in the prompt.
      const blocks = result && result.__content;
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: blocks
          ? blocks
          : (typeof result === 'string' ? result : JSON.stringify(result ?? null)),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }

    working.push({ role: 'user', content: results });

    // The model now has every result and is composing. This is the gap the UI
    // used to sit blank through — after finish_job especially, where the job
    // card has gone quiet and the answer has not arrived yet.
    onEvent?.({
      type: 'composing',
      after: requests[requests.length - 1]?.name || null,
    });
  }

  log.finished(who, turnsUsed, toolCalls.length, Date.now() - runStarted, usage);
  return { messages: working, text: finalText, toolCalls, usage };
}

/**
 * Attribute spend to HQ so it shows on the usage page alongside everything else.
 *
 * The column is `process`, not `context` — getting that wrong made every insert
 * throw into the catch below, so a worker's entire spend went unrecorded while
 * looking fine. If this ever stops logging, check the column names against
 * llm_usage before anything else.
 *
 * Still never allowed to break a run: losing a usage row is bad, losing the
 * work is worse.
 */
async function logUsage({ model, usage, workerName, conversationId, durationMs }) {
  try {
    await db.query(
      `INSERT INTO llm_usage
         (agent_name, crew_member, process, model, provider,
          input_tokens, output_tokens, conversation_id, duration_ms, created_at)
       VALUES ('hq', $1, 'hq_worker', $2, 'anthropic', $3, $4, $5, $6, NOW())`,
      [workerName, model, usage.inputTokens, usage.outputTokens,
       conversationId ?? null, durationMs ?? null]
    );
  } catch (err) {
    console.warn('[hq] usage logging FAILED:', err.message);
  }
}

module.exports = { run, MAX_TURNS };
