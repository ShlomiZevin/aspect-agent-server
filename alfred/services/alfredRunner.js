/**
 * Brainstorm Alfred — Claude Sonnet 4.6 streaming with tool use.
 *
 * Streams text tokens through an `emit` callback. Alfred sees the
 * current agent JSON on every turn; when he needs more (change
 * history, an addon's runtime source), he calls a tool —
 * `read_change_log` / `read_addon_code`. Tool calls round-trip
 * through the streaming loop without breaking the token stream.
 *
 * Caller (alfredRoute) handles SSE plumbing; this module owns the
 * LLM interaction and produces the assistant text.
 */

const fs = require('fs');
const path = require('path');
const claudeService = require('../../services/llm.claude');
const { logUsage } = require('../../services/usageLogger');
const { SYSTEM_PROMPT, buildProjectSummary } = require('./alfredContext');
const alfredChats = require('./alfredChats');
const changeLog = require('./changeLog');
const { hydrateProject } = require('../../builder/services/builderProjects');

const ALFRED_MODEL    = 'claude-sonnet-4-6';
const ALFRED_PROCESS  = 'alfred-brainstorm';
const HISTORY_LIMIT   = 20;   // last N messages (~10 turns) per turn
const MAX_TOKENS      = 4096;
const MAX_TOOL_ITERATIONS = 4; // safety: cap recursion so a misbehaving model can't loop forever

// ─── Tool definitions ────────────────────────────────────────────

/**
 * pluginId → { descriptorPath, sourcePath }. Built once at module load
 * by scanning builder/addons/*.addon.json — the same files the addon
 * catalogue and the patch generator read, so the tool automatically
 * covers every installed plugin. The runtime implementation lives at
 * builder/plugins/<base>/addon.<base>.js (same basename convention).
 */
const ADDON_CODE_PATHS = (() => {
  const map = {};
  const addonsDir = path.join(__dirname, '..', '..', 'builder', 'addons');
  try {
    for (const f of fs.readdirSync(addonsDir).filter(f => f.endsWith('.addon.json'))) {
      try {
        const desc = JSON.parse(fs.readFileSync(path.join(addonsDir, f), 'utf8'));
        if (!desc.pluginId) continue;
        const base = f.replace(/\.addon\.json$/, '');
        map[desc.pluginId] = {
          descriptorPath: path.join(addonsDir, f),
          sourcePath: path.join(__dirname, '..', '..', 'builder', 'plugins', base, `addon.${base}.js`),
        };
      } catch { /* skip unparseable descriptor */ }
    }
  } catch (err) {
    console.warn('[alfred] failed to scan addon descriptors for read_addon_code:', err.message);
  }
  return map;
})();

const TOOLS = [
  {
    name: 'read_change_log',
    description:
      'Read this agent\'s change history (Alfred applies + manual "Validate & Log" entries). ' +
      'Use when the user asks what was changed, when something was added, who did what, etc. ' +
      'Returns plain text — newest entries first.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max entries to return. Default 20, max 100.',
        },
      },
    },
  },
  {
    name: 'read_addon_code',
    description:
      'Read an addon plugin\'s full descriptor (defaults) and its server-side runtime ' +
      'implementation source code. Use when the agent JSON isn\'t enough — e.g. the user ' +
      'asks exactly HOW an addon behaves at runtime (when it fires, how its output is ' +
      'parsed, what its config knobs really do). ' +
      `Available pluginIds: ${Object.keys(ADDON_CODE_PATHS).join(', ') || '(none found)'}.`,
    input_schema: {
      type: 'object',
      properties: {
        pluginId: {
          type: 'string',
          description: 'The plugin id, e.g. "field-extractor", "kb-retriever", "talker".',
        },
      },
      required: ['pluginId'],
    },
  },
];

function formatChangeLogForLLM(rows) {
  if (rows.length === 0) return 'No log entries yet for this agent.';
  return rows.map(r => {
    const when = new Date(r.appliedAt).toLocaleString();
    const actor = r.actor === 'alfred' ? 'Alfred' : 'manual edit';
    const what  = (r.whatChanged || '').trim() || '(no description)';
    const why   = (r.reason || '').trim();
    const head  = `[${when}] ${actor} · ${r.entity}: ${r.entityName}`;
    return why ? `${head}\n  ${what}\n  Why: ${why}` : `${head}\n  ${what}`;
  }).join('\n\n');
}

async function runTool(name, input, ctx) {
  if (name === 'read_change_log') {
    const limit = Math.min(Math.max(Number(input?.limit) || 20, 1), 100);
    const rows = await changeLog.listForAgent(ctx.agentId, limit);
    return formatChangeLogForLLM(rows);
  }
  if (name === 'read_addon_code') {
    const pluginId = String(input?.pluginId || '').trim();
    const paths = ADDON_CODE_PATHS[pluginId];
    if (!paths) {
      return `Unknown pluginId "${pluginId}". Available: ${Object.keys(ADDON_CODE_PATHS).join(', ')}.`;
    }
    const parts = [];
    try {
      parts.push(`## Descriptor (defaults) — ${path.basename(paths.descriptorPath)}`);
      parts.push('```json\n' + fs.readFileSync(paths.descriptorPath, 'utf8').trim() + '\n```');
    } catch (err) {
      parts.push(`(descriptor unreadable: ${err.message})`);
    }
    try {
      parts.push(`## Runtime implementation — ${path.basename(paths.sourcePath)}`);
      parts.push('```js\n' + fs.readFileSync(paths.sourcePath, 'utf8').trim() + '\n```');
    } catch (err) {
      parts.push(`(runtime source unreadable: ${err.message})`);
    }
    return parts.join('\n\n');
  }
  return `Unknown tool: ${name}`;
}

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

  // Build the messages array Claude expects. Alfred chats are strictly
  // user/assistant. Other roles get filtered out defensively.
  let messagesForClaude = recent
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  if (messagesForClaude.length === 0 || messagesForClaude[messagesForClaude.length - 1].role !== 'user') {
    throw new Error('alfredRunner: last history message must be from the user');
  }

  // 2. Resolve agentId (for tool handlers) and build the system prompt.
  const project = await hydrateProject({ agentSlug, ownerUserId });
  if (!project || !project.agents[0]) {
    throw new Error(`No project found for slug "${agentSlug}".`);
  }
  const agentId = project.agents[0].id;
  const toolCtx = { agentId };

  const summary = await buildProjectSummary({ agentSlug, ownerUserId });
  const systemPrompt = `${SYSTEM_PROMPT}\n\n## Current project state\n${summary}`;

  // 3. Streaming loop with tool support. Each iteration: stream the
  //    model's response; if it ended with tool_use blocks, run them
  //    and append both the assistant turn and the tool results, then
  //    loop. Otherwise we're done.
  const client = claudeService.client;
  let collected    = '';
  let firstTokenMs = null;
  let inputTokens  = 0;
  let outputTokens = 0;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let stream;
    try {
      stream = await client.messages.stream({
        model:      ALFRED_MODEL,
        max_tokens: MAX_TOKENS,
        system:     systemPrompt,
        messages:   messagesForClaude,
        tools:      TOOLS,
      });
    } catch (err) {
      emit('alfred.error', { error: { code: 'stream_failed', message: err.message } });
      throw err;
    }

    // Track content blocks as the model emits them — needed both to
    // stream text tokens out AND to reconstruct the assistant turn
    // for the next iteration when a tool is called.
    const assistantBlocks = [];

    try {
      for await (const event of stream) {
        if (event.type === 'message_start' && event.message?.usage) {
          inputTokens  += event.message.usage.input_tokens  || 0;
          outputTokens += event.message.usage.output_tokens || 0;
        }
        if (event.type === 'message_delta' && event.usage) {
          outputTokens += event.usage.output_tokens || 0;
        }

        if (event.type === 'content_block_start') {
          const cb = event.content_block;
          if (cb?.type === 'text') {
            assistantBlocks.push({ type: 'text', text: '' });
          } else if (cb?.type === 'tool_use') {
            assistantBlocks.push({
              type:      'tool_use',
              id:        cb.id,
              name:      cb.name,
              input:     {},
              _inputStr: '',
            });
          }
        }

        if (event.type === 'content_block_delta') {
          const last = assistantBlocks[assistantBlocks.length - 1];
          if (event.delta?.type === 'text_delta' && last?.type === 'text') {
            const text = event.delta.text;
            if (text) {
              last.text += text;
              if (firstTokenMs === null) firstTokenMs = Date.now() - start;
              collected += text;
              emit('alfred.token', { token: text });
            }
          }
          if (event.delta?.type === 'input_json_delta' && last?.type === 'tool_use') {
            last._inputStr += event.delta.partial_json || '';
          }
        }

        if (event.type === 'content_block_stop') {
          const last = assistantBlocks[assistantBlocks.length - 1];
          if (last?.type === 'tool_use' && last._inputStr) {
            try { last.input = JSON.parse(last._inputStr); }
            catch { last.input = {}; }
            delete last._inputStr;
          }
        }
      }
    } catch (err) {
      emit('alfred.error', { error: { code: 'stream_aborted', message: err.message } });
      throw err;
    }

    const toolUses = assistantBlocks.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // No tool calls — the model is done.
      break;
    }

    // Execute every tool the model requested, append the assistant
    // turn (text + tool_use blocks) and the user turn (tool_result
    // blocks) to the messages array, then loop.
    const toolResultsContent = [];
    for (const tu of toolUses) {
      emit('alfred.tool-use', {
        tool:      tu.name,
        input:     tu.input || {},
        toolUseId: tu.id,
      });

      let result;
      try {
        result = await runTool(tu.name, tu.input || {}, toolCtx);
      } catch (err) {
        result = `Tool error: ${err.message}`;
      }

      emit('alfred.tool-result', {
        toolUseId: tu.id,
        // Truncated preview just for the client SSE; the model
        // receives the full result via tool_result below.
        preview: String(result).slice(0, 300),
      });

      toolResultsContent.push({
        type:         'tool_result',
        tool_use_id:  tu.id,
        content:      String(result),
      });
    }

    // Re-emit the assistant turn faithfully. Strip our internal
    // bookkeeping (_inputStr) — already deleted above for each tool.
    messagesForClaude = [
      ...messagesForClaude,
      {
        role:    'assistant',
        content: assistantBlocks.map(b => {
          if (b.type === 'text')     return { type: 'text', text: b.text };
          if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
          return b;
        }),
      },
      { role: 'user', content: toolResultsContent },
    ];
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
