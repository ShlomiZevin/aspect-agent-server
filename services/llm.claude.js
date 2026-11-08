const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const providerConfigService = require('./provider-config.service');
const webSearchLib = require('./webSearch');

/**
 * Newer Claude models reject `temperature` with a 400 (sampling settings
 * were removed: Opus 4.7+, Sonnet 5+, Haiku 5.5, Fable, Mythos). Callers
 * that pass one keep working — it is simply not sent to those models.
 */
function acceptsTemperature(model) {
  return !/^claude-(opus-4-[78]|opus-5|sonnet-5|haiku-5|fable|mythos)/.test(String(model || ''));
}

/** Agent display name ("ZolStock") -> per-customer key scope ("zolstock").
 *  Matches the ENV_FALLBACKS naming in provider-config.service.js exactly. */
function normalizeScope(agentName) {
  return agentName ? String(agentName).toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

/** Drop underscore-prefixed top-level keys from a tool result before it goes
 *  into the model's context — see the tool_result push below. */
function stripInternal(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const keys = Object.keys(result);
  if (!keys.some(k => k.startsWith('_'))) return result;
  const rest = {};
  for (const k of keys) { if (!k.startsWith('_')) rest[k] = result[k]; }
  return rest;
}

/**
 * Claude/Anthropic LLM Service
 *
 * Provides Claude API integration for:
 * - One-shot completions (for crew generation)
 * - Streaming responses with prompt (for future chat use)
 * - Specialized crew generation from natural language descriptions
 */
class ClaudeService {
  constructor() {
    // Keyed by the resolved API key rather than a single cached client, so
    // a per-customer key (task #61) and the shared default key each get
    // their own SDK instance instead of thrashing one cached client.
    this._clients = new Map();

    // Default model - can be overridden per request
    this.model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
  }

  /**
   * Resolve the Anthropic client for this call. `agentName`, when given and
   * a `<scope>_anthropic_api_key` is configured for it, uses that customer's
   * own key ("Thinking module", task #61) — otherwise the shared key, byte
   * -identical to before this existed.
   */
  _clientFor(agentName) {
    const scope = normalizeScope(agentName);
    const apiKey = providerConfigService.getScopedCached('anthropic_api_key', scope) || process.env.ANTHROPIC_API_KEY;
    let client = this._clients.get(apiKey);
    if (!client) {
      client = new Anthropic({ apiKey });
      this._clients.set(apiKey, client);
    }
    return client;
  }


  /**
   * One turn of an agentic tool loop.
   *
   * `sendOneShot` with `tools` is built for a single forced tool call: it
   * returns the first tool_use block and discards everything else. An agent
   * that plans, narrates and calls several tools needs the whole reply —
   * text AND every tool_use block AND the stop reason — so it can append the
   * assistant turn verbatim and feed tool results back. Hence this, rather
   * than bending the existing method and changing its contract.
   *
   * Purely additive: no existing caller is affected.
   *
   * @returns {Promise<{ content: Array, stopReason: string, usage: Object }>}
   */
  async sendAgentTurn({ system, messages, tools = [], model, maxTokens = 8192, temperature } = {}) {
    const params = {
      model: model || this.model,
      max_tokens: maxTokens,
      system,
      messages,
    };
    if (tools.length) params.tools = tools;
    if (temperature !== undefined && acceptsTemperature(model)) params.temperature = temperature;

    const response = await this._clientFor(null).messages.create(params);

    return {
      // Raw blocks, so the caller can push this straight back as the
      // assistant message — Anthropic requires the tool_use blocks to be
      // echoed exactly alongside their tool_result replies.
      content: response.content,
      stopReason: response.stop_reason,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  /**
   * Send a stateless, non-streaming one-shot request.
   * Similar to OpenAI's sendOneShot method.
   *
   * @param {string} systemPrompt - System instructions/prompt
   * @param {string} message - The user message content
   * @param {Object} options - Configuration options
   * @param {string} options.model - Model to use (default: claude-sonnet-4-20250514)
   * @param {number} options.maxTokens - Max output tokens (default: 4096)
   * @param {boolean} options.jsonOutput - Request JSON output (adds instruction to respond with JSON)
   * @returns {Promise<string>} - The response text
   */
  async sendOneShot(systemPrompt, message, options = {}) {
    const {
      model = this.model,
      maxTokens = 4096,
      jsonOutput = false,
      knowledgeBase,
      historyMessages,
      /**
       * Optional tool-use mode. When `tools` is provided, the response
       * is expected to be a tool_use block (often forced via toolChoice).
       * Return shape switches to `{ toolUse: { name, input }, usage }`.
       * Callers without `tools` see the unchanged `{ text, usage }` shape.
       */
      tools,
      toolChoice,
      /**
       * Optional sampling temperature. Anthropic's own default is 1.0, so
       * every sendOneShot caller was previously running fully sampled —
       * including deterministic, single-correct-answer steps like NL->SQL
       * generation, where it meant the SAME question produced materially
       * DIFFERENT SQL (and therefore different numbers) run to run. Callers
       * that want reproducibility pass temperature: 0; omitting it keeps the
       * previous behaviour exactly, so no existing caller changes.
       */
      temperature,
      // Per-customer key routing (task #61) — see _clientFor. Every existing
      // caller that doesn't pass this keeps using the shared key.
      agentName,
      /**
       * Stream the request instead of buffering it. The response object and
       * therefore this method's return shape are IDENTICAL either way — the
       * stream is drained to a final message before anything is read.
       *
       * Why it matters: a non-streaming call with a large `maxTokens` dies
       * with "Request timed out" well before the model finishes, because the
       * whole reply must arrive within one HTTP response. Streaming removes
       * that ceiling, which is the only reason the Apply patch cap sat at
       * 21000. Callers generating big bodies should pass this.
       */
      stream = false,
    } = options;

    try {
      const anthropicFileIds = knowledgeBase?.anthropicFileIds || [];

      // Build system prompt: instructions + JSON instruction. The
      // current user message used to be appended here as `## Context`
      // — that's been replaced with a real user turn at the tail of
      // the messages array below, so the model treats it like every
      // other turn.
      let promptText = systemPrompt;
      if (jsonOutput) {
        promptText += '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no code blocks, no explanation - just the raw JSON object.';
      }

      // Build messages: history + the current user message + a
      // trailing code-level prod that tells the model what to return.
      // The prod is what callers' prompts implicitly rely on for
      // output format ("respond in JSON"); keeping it as the last
      // message preserves backward compat.
      let messages = [];
      if (historyMessages && historyMessages.length > 0) {
        messages = historyMessages.map(m => ({ role: m.role, content: m.content }));
      }
      if (message) {
        messages.push({ role: 'user', content: message });
      }
      // Code-level "what to return" prod. For jsonOutput, always
      // append (reinforces the format the model has to emit). For
      // plain text, only append when there's nothing for the model
      // to respond to — same condition as before.
      if (jsonOutput) {
        messages.push({ role: 'user', content: 'Respond in valid JSON only.' });
      } else if (messages.length === 0 || messages[messages.length - 1].role === 'assistant') {
        messages.push({ role: 'user', content: 'Analyze the conversation and respond.' });
      }
      console.log(`📜 Claude OneShot: ${messages.length} messages (history=${historyMessages?.length ?? 0} + current=${message ? 1 : 0} + prod=${messages.length - (historyMessages?.length ?? 0) - (message ? 1 : 0)})`);

      // Inject KB document blocks into the first user message
      if (anthropicFileIds.length > 0) {
        const firstUserIdx = messages.findIndex(m => m.role === 'user');
        if (firstUserIdx >= 0) {
          const msg = messages[firstUserIdx];
          const textContent = typeof msg.content === 'string' ? msg.content : msg.content;
          messages[firstUserIdx] = {
            role: 'user',
            content: [
              ...anthropicFileIds.map(fileId => ({ type: 'document', source: { type: 'file', file_id: fileId } })),
              { type: 'text', text: textContent }
            ]
          };
        }
        console.log(`📚 Claude OneShot: ${anthropicFileIds.length} document block(s) injected`);
      }

      console.log(`📜 Claude OneShot: system prompt ${promptText.length} chars, ${messages.length} messages, jsonOutput=${jsonOutput}`);

      const requestParams = {
        model,
        max_tokens: maxTokens,
        system: promptText,
        messages
      };

      // Only sent when the caller explicitly asked for it — leaving it off
      // preserves Anthropic's default (1.0) for every pre-existing caller.
      if (temperature != null && acceptsTemperature(model)) requestParams.temperature = Math.max(0, Math.min(1, temperature));

      // Tool-use mode — when the caller provides a tool definition
      // (and typically a tool_choice forcing it), the response is a
      // structured tool_use block rather than free text.
      if (Array.isArray(tools) && tools.length > 0) {
        requestParams.tools = tools;
        if (toolChoice) requestParams.tool_choice = toolChoice;
      }

      // Use beta API when document blocks are present (requires Files API beta)
      const useFilesApi = anthropicFileIds.length > 0;
      if (useFilesApi) {
        requestParams.betas = ['files-api-2025-04-14'];
      }
      const client = this._clientFor(agentName);
      const messagesApi = useFilesApi ? client.beta.messages : client.messages;

      // `.stream().finalMessage()` yields the same Message object as
      // `.create()`, so every extraction path below is untouched. Guarded
      // because the beta (Files API) namespace is the one most likely to
      // lack `.stream` on an older SDK — falling back is better than
      // failing an apply over it.
      const canStream = stream && typeof messagesApi.stream === 'function';
      if (stream && !canStream) {
        console.warn('⚠️ Claude OneShot: streaming requested but unavailable on this API surface; buffering instead');
      }
      // Web search switch (task #967) — not in tool-use mode (that call is
      // one forced tool, by design).
      const webSearch = options.webSearch && !(Array.isArray(tools) && tools.length > 0) ? options.webSearch : null;
      if (webSearch) {
        const ws = await this._oneShotWithWebSearch(messagesApi, requestParams, webSearch, options.onWebSearch);
        return { text: ws.text, usage: ws.usage, stopReason: ws.response.stop_reason };
      }

      const response = canStream
        ? await messagesApi.stream(requestParams).finalMessage()
        : await messagesApi.create(requestParams);

      const usage = response.usage ? {
        inputTokens: response.usage.input_tokens || 0,
        outputTokens: response.usage.output_tokens || 0,
      } : null;

      // Tool-use response: pull the (first) tool_use block out and
      // return its parsed input. The text path is bypassed.
      if (Array.isArray(tools) && tools.length > 0) {
        // A tool call cut off by the output cap yields an empty/partial
        // input that downstream code would misread as "model returned
        // nothing". Fail loudly with the real cause instead. The usage
        // rides on the error — the truncated output was still billed,
        // so callers can log it (a 16K truncation is real money).
        if (response.stop_reason === 'max_tokens') {
          const err = new Error(
            `Tool-use response truncated: hit the ${maxTokens}-token output limit before the tool call completed.`,
          );
          err.usage = usage;
          throw err;
        }
        const toolBlock = response.content.find(c => c.type === 'tool_use');
        if (!toolBlock) {
          throw new Error('Tool-use call returned no tool_use block.');
        }
        return {
          toolUse: { name: toolBlock.name, input: toolBlock.input },
          usage,
        };
      }

      // Default: text response. `stopReason` lets callers distinguish a
      // complete answer from one cut off by the max_tokens cap —
      // critical for JSON-returning callers, where truncation otherwise
      // surfaces as a misleading "malformed JSON" parse error.
      const textContent = response.content.find(c => c.type === 'text');
      const text = textContent?.text || '';
      return { text, usage, stopReason: response.stop_reason };
    } catch (error) {
      console.error('❌ Claude OneShot Error:', error.message);
      const wrapped = new Error(`Failed to get Claude response: ${error.message}`);
      // Preserve billed usage across the wrap (set on truncation errors).
      if (error && error.usage) wrapped.usage = error.usage;
      // Keep the provider's HTTP status (429 = rate limit) for the error center / retry.
      wrapped.status = error.status || error.statusCode || null;
      throw wrapped;
    }
  }

  /**
   * One-shot call with the web search server tool on (task #967). Always
   * streamed, so each search reaches `onWebSearch` live. Handles the two
   * things a server tool adds: `pause_turn` (the server's own loop paused —
   * send the turn back and it resumes) and a 400 for allowed sites that
   * block Anthropic's crawler (dropped, asked again; no site left = no
   * search, never "search everywhere").
   *
   * @returns {{ text, usage: { inputTokens, outputTokens, webSearches,
   *   webCitations, webEvents, webBlockedDomains? }, response }}
   */
  async _oneShotWithWebSearch(messagesApi, baseParams, webSearchIn, onWebSearch) {
    let webSearch = { allowedDomains: [...webSearchIn.allowedDomains], maxSearches: webSearchIn.maxSearches };
    const tell = ev => { if (typeof onWebSearch === 'function') { try { onWebSearch(ev); } catch { /* listener */ } } };
    const events = new Map();
    const citations = [];
    const blockedDomains = [];
    let messages = baseParams.messages;
    let inputTokens = 0;
    let outputTokens = 0;
    let searches = 0;
    let response = null;

    for (let round = 0; round < 6; round++) {
      const params = { ...baseParams, messages };
      if (webSearch) {
        params.tools = [...(baseParams.tools || []), webSearchLib.anthropicTool(webSearch, baseParams.model, webSearch.maxSearches - searches)];
      }
      const stream = messagesApi.stream(params);
      const blocks = {};
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            const cb = event.content_block || {};
            blocks[event.index] = { type: cb.type, name: cb.name, id: cb.id, json: '' };
            if (cb.type === 'server_tool_use' && cb.name === 'web_search' && cb.input?.query) {
              blocks[event.index].announced = true;
              events.set(cb.id, { type: 'web_search', phase: 'started', id: cb.id, query: cb.input.query, kind: 'search' });
              tell(events.get(cb.id));
            }
            if (cb.type === 'web_search_tool_result') {
              const r = webSearchLib.anthropicResult(cb);
              const ev = {
                type: 'web_search', phase: 'done', id: cb.tool_use_id,
                query: events.get(cb.tool_use_id)?.query || null, kind: 'search',
                sources: r.sources, ...(r.error ? { error: r.error } : {}),
              };
              events.set(cb.tool_use_id, ev);
              tell(ev);
            }
          }
          if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && blocks[event.index]) {
            blocks[event.index].json += event.delta.partial_json || '';
          }
          if (event.type === 'content_block_stop') {
            const b = blocks[event.index];
            if (b && b.type === 'server_tool_use' && b.name === 'web_search' && !b.announced) {
              let query = null;
              try { query = JSON.parse(b.json || '{}').query || null; } catch { /* partial */ }
              b.announced = true;
              events.set(b.id, { type: 'web_search', phase: 'started', id: b.id, query, kind: 'search' });
              tell(events.get(b.id));
            }
          }
        }
        response = await stream.finalMessage();
      } catch (err) {
        const blocked = webSearch ? webSearchLib.blockedDomainsFromError(err) : null;
        if (blocked) {
          console.warn(`⚠️ Claude web search: sites Anthropic cannot reach, dropped: ${blocked.join(', ')}`);
          blockedDomains.push(...blocked);
          webSearch.allowedDomains = webSearch.allowedDomains.filter(d => !blocked.includes(d));
          if (!webSearch.allowedDomains.length) webSearch = null;
          continue;
        }
        throw err;
      }

      inputTokens += response.usage?.input_tokens || 0;
      outputTokens += response.usage?.output_tokens || 0;
      searches += response.usage?.server_tool_use?.web_search_requests || 0;
      for (const b of response.content) {
        if (b.type === 'text') webSearchLib.addCitations(citations, webSearchLib.anthropicCitations(b.citations));
      }
      if (response.stop_reason !== 'pause_turn') break;
      messages = [...messages, { role: 'assistant', content: response.content }];
    }
    if (!response) throw new Error('Claude web search: no response');

    // The answer is the text AFTER the last search step; the text before it
    // ("Let me look that up.") is not part of it. Citations split one answer
    // into several text blocks — joined back.
    let lastTool = -1;
    response.content.forEach((b, i) => {
      if (b.type === 'server_tool_use' || /_tool_result$/.test(b.type)) lastTool = i;
    });
    const text = response.content.slice(lastTool + 1).filter(b => b.type === 'text').map(b => b.text).join('');

    const doneEvents = [...events.values()].map(e => (e.phase === 'done' ? e : { ...e, phase: 'done', sources: [] }));
    return {
      text,
      response,
      usage: {
        inputTokens,
        outputTokens,
        webSearches: searches,
        webCitations: citations,
        webEvents: doneEvents,
        ...(blockedDomains.length ? { webBlockedDomains: blockedDomains } : {}),
      },
    };
  }

  /**
   * Send a message with conversation history and get a streaming response.
   * Similar to OpenAI's sendMessageStreamWithPrompt.
   *
   * @param {string} message - The user message
   * @param {string} conversationId - Conversation ID to fetch history from
   * @param {Object} config - Configuration object
   * @param {string} config.prompt - System instructions
   * @param {string} config.model - Model to use
   * @param {number} config.maxTokens - Max tokens
   * @param {Array} config.tools - Tool definitions (crew member tools)
   * @param {Object} config.toolHandlers - Map of tool name -> handler function
   * @param {Object} config.context - Additional context to inject
   * @returns {AsyncGenerator} - Stream of text chunks or tool events
   */
  async *sendMessageStreamWithPrompt(message, conversationId, config = {}) {
    const _streamStart = Date.now();
    const {
      prompt: systemPrompt = '',
      model = this.model,
      maxTokens = 4096,
      tools: crewTools = [],
      toolHandlers = {},
      anthropicDocuments = [], // Anthropic file IDs to inject as document blocks
      temperature,
      topK,
      // Per-customer key routing (task #61) — see _clientFor.
      agentName,
    } = config;
    // Web search switch (task #967): normalized { allowedDomains, maxSearches }
    // from services/webSearch.js, or null. Copied — a site Anthropic cannot
    // reach is dropped from it below.
    let webSearch = config.webSearch
      ? { allowedDomains: [...config.webSearch.allowedDomains], maxSearches: config.webSearch.maxSearches }
      : null;

    try {

      // Convert tools from OpenAI format to Claude format
      const tools = [];
      if (crewTools && crewTools.length > 0) {
        tools.push(...crewTools.map(tool => {
          // OpenAI: {type: "function", name: "call_X", description, parameters}
          // Claude: {name: "X", description, input_schema}
          const claudeTool = {
            name: tool.name.replace(/^call_/, ''), // Remove "call_" prefix
            description: tool.description || '',
            input_schema: tool.parameters || { type: 'object', properties: {} }
          };
          return claudeTool;
        }));
      }

      // Ensure message is a string
      const messageText = typeof message === 'string' ? message : String(message);

      // Ensure system prompt is a string
      const systemText = typeof systemPrompt === 'string' ? systemPrompt : String(systemPrompt);

      // Conversation history.
      //
      // V2 (builder) path: the caller pre-loads history per the addon's
      //   context.history config (none / last_n / full) and passes it
      //   in `config.historyMessages` as [{ role, content }]. Use that
      //   directly — re-fetching would override the V2 history mode
      //   (and would fail anyway, because conversation.service looks
      //   up by externalId, while V2 passes a numeric id).
      //
      // V1 path: no historyMessages provided → keep the legacy
      //   "fetch the last 100 messages" behavior.
      const conversationService = require('./conversation.service');
      let historyMessages = [];
      if (Array.isArray(config.historyMessages)) {
        historyMessages = config.historyMessages.map(m => ({
          role: m.role,
          content: m.role === 'assistant' ? conversationService.stripUIMarkup(m.content) : m.content,
        }));
      } else {
        try {
          const history = await conversationService.getConversationHistory(conversationId, 100);
          if (history.length > 0 && history[history.length - 1].role === 'user') {
            history.pop();
          }
          historyMessages = history.map(m => ({
            role: m.role,
            content: m.role === 'assistant' ? conversationService.stripUIMarkup(m.content) : m.content
          }));
        } catch (err) {
          console.warn('⚠️ Could not load conversation history from DB:', err.message);
        }
      }

      // Clean history for Claude (only user/assistant roles)
      const cleanedHistory = this._cleanHistoryForClaude(historyMessages);

      // Build user message content — prepend document blocks for Anthropic KB
      let userContent;
      if (anthropicDocuments && anthropicDocuments.length > 0) {
        userContent = [
          ...anthropicDocuments.map(fileId => ({
            type: 'document',
            source: { type: 'file', file_id: fileId }
          })),
          { type: 'text', text: messageText }
        ];
        console.log(`📎 Injecting ${anthropicDocuments.length} document block(s) into Claude request`);
      } else {
        userContent = messageText;
      }

      // Build messages array: history + current message
      const messages = [
        ...cleanedHistory,
        { role: 'user', content: userContent }
      ];

      console.log(`🤖 Claude streaming with prompt (${systemText.length} chars), ${tools.length} tools, ${cleanedHistory.length}/${historyMessages.length} history messages`);

      let maxIterations = 10;
      let currentMessages = messages;

      // Accumulated ACROSS every iteration of the tool loop, not reset per
      // iteration — a turn that calls a tool (every BI chat agent's single
      // crew always does) used to log only the FINAL iteration's usage,
      // silently dropping the tokens spent on the call that decided to
      // invoke the tool in the first place (#62).
      let claudeInputTokens = 0;
      let claudeOutputTokens = 0;
      // Web search (#967): searches billed this turn, cited pages, sites
      // Anthropic refused, and the reply so far (for paragraph breaks).
      let webSearchCount = 0;
      const webCitations = [];
      const webBlockedDomains = [];
      let replySoFar = '';

      while (maxIterations > 0) {
        maxIterations--;

        const requestParams = {
          model,
          max_tokens: maxTokens,
          system: systemText,
          messages: currentMessages
        };

        if (temperature != null && acceptsTemperature(model)) requestParams.temperature = Math.min(temperature, 1.0); // Claude max is 1.0
        if (topK != null) requestParams.top_k = topK;

        // Add tools if provided (+ the web search server tool, #967)
        const requestTools = webSearch
          ? [...tools, webSearchLib.anthropicTool(webSearch, model, webSearch.maxSearches - webSearchCount)]
          : tools;
        if (requestTools.length > 0) {
          requestParams.tools = requestTools;
        }

        // Use beta.messages when document blocks are present (requires Files API beta)
        const client = this._clientFor(agentName);
        const messagesApi = anthropicDocuments && anthropicDocuments.length > 0
          ? client.beta.messages
          : client.messages;
        if (anthropicDocuments && anthropicDocuments.length > 0) {
          requestParams.betas = ['files-api-2025-04-14'];
        }

        const stream = await messagesApi.stream(requestParams);

        let fullReply = '';
        const pendingToolCalls = [];
        // Per content-block index: what the block is (#967 — a server tool's
        // input must never be glued onto a client tool's input).
        const blocks = {};
        const searchQueries = new Map();
        let afterToolResult = false;
        let yieldedThisRequest = false;
        // This message's usage. message_delta carries CUMULATIVE totals for
        // the message (input included — with server tools the input grows
        // past what message_start said), so it replaces, never adds.
        let msgIn = 0;
        let msgOut = 0;
        let msgSearches = 0;
        let stopReason = null;

        try {
          for await (const event of stream) {
            // Track usage from message events
            if (event.type === 'message_start' && event.message?.usage) {
              msgIn = event.message.usage.input_tokens || 0;
              msgOut = event.message.usage.output_tokens || 0;
            }
            if (event.type === 'message_delta') {
              if (event.usage) {
                if (event.usage.input_tokens != null) msgIn = event.usage.input_tokens;
                if (event.usage.output_tokens != null) msgOut = event.usage.output_tokens;
                const ws = event.usage.server_tool_use?.web_search_requests;
                if (typeof ws === 'number') msgSearches = ws;
              }
              if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            }

            if (event.type === 'content_block_start') {
              const cb = event.content_block || {};
              blocks[event.index] = { type: cb.type, name: cb.name, id: cb.id, json: '' };

              if (cb.type === 'tool_use') {
                pendingToolCalls.push({ id: cb.id, name: cb.name, input: {} });
              }

              // Web search started. Called from the model's own code
              // (dynamic filtering) the query is already here; called
              // directly it streams in — announced at content_block_stop.
              if (cb.type === 'server_tool_use' && cb.name === 'web_search' && cb.input?.query) {
                searchQueries.set(cb.id, cb.input.query);
                blocks[event.index].announced = true;
                yieldedThisRequest = true;
                yield { type: 'web_search', phase: 'started', id: cb.id, query: cb.input.query, kind: 'search' };
              }
              if (cb.type === 'web_search_tool_result') {
                const r = webSearchLib.anthropicResult(cb);
                afterToolResult = true;
                yieldedThisRequest = true;
                yield {
                  type: 'web_search', phase: 'done', id: cb.tool_use_id,
                  query: searchQueries.get(cb.tool_use_id) || null, kind: 'search',
                  sources: r.sources, ...(r.error ? { error: r.error } : {}),
                };
              }
              if (cb.type === 'text') {
                webSearchLib.addCitations(webCitations, webSearchLib.anthropicCitations(cb.citations));
                // The answer after a search starts a new paragraph — the
                // text before it ("Let me look that up.") must not run into it.
                if (afterToolResult && replySoFar && !/\s$/.test(replySoFar)) {
                  fullReply += '\n\n';
                  replySoFar += '\n\n';
                  yieldedThisRequest = true;
                  yield '\n\n';
                }
                afterToolResult = false;
              }
            }

            // Handle text delta
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              const text = event.delta.text;
              if (text) {
                fullReply += text;
                replySoFar += text;
                yieldedThisRequest = true;
                yield text; // Yield string for backward compatibility
              }
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'citations_delta') {
              webSearchLib.addCitations(webCitations, webSearchLib.anthropicCitations([event.delta.citation]));
            }

            // Accumulate tool input — on the block it belongs to.
            if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
              const b = blocks[event.index];
              if (b) b.json += event.delta.partial_json || '';
            }

            // Block complete
            if (event.type === 'content_block_stop') {
              const b = blocks[event.index];
              if (b && b.type === 'tool_use' && b.json) {
                const tool = pendingToolCalls.find(t => t.id === b.id);
                try {
                  if (tool) tool.input = JSON.parse(b.json);
                } catch (e) {
                  console.warn('⚠️ Failed to parse tool input:', e.message);
                }
              }
              if (b && b.type === 'server_tool_use' && b.name === 'web_search' && !b.announced) {
                let query = null;
                try { query = JSON.parse(b.json || '{}').query || null; } catch { /* partial */ }
                if (query) searchQueries.set(b.id, query);
                b.announced = true;
                yieldedThisRequest = true;
                yield { type: 'web_search', phase: 'started', id: b.id, query, kind: 'search' };
              }
            }
          }
        } catch (err) {
          // A site in allowed_domains that blocks Anthropic's crawler fails
          // the whole request (400). Drop those sites and ask again; with no
          // site left, run without web search rather than search everywhere.
          const blocked = webSearch && !yieldedThisRequest ? webSearchLib.blockedDomainsFromError(err) : null;
          if (blocked && maxIterations > 0) {
            console.warn(`⚠️ Claude web search: sites Anthropic cannot reach, dropped: ${blocked.join(', ')}`);
            webBlockedDomains.push(...blocked);
            webSearch.allowedDomains = webSearch.allowedDomains.filter(d => !blocked.includes(d));
            if (!webSearch.allowedDomains.length) webSearch = null;
            continue;
          }
          throw err;
        }

        claudeInputTokens += msgIn;
        claudeOutputTokens += msgOut;
        webSearchCount += msgSearches;

        // The server's own search loop paused (its 10-step limit): send the
        // turn back as it is and it resumes where it stopped.
        if (stopReason === 'pause_turn') {
          const paused = await stream.finalMessage();
          currentMessages = [...currentMessages, { role: 'assistant', content: paused.content }];
          continue;
        }

        // Handle tool calls
        if (pendingToolCalls.length > 0) {
          const toolResults = [];

          for (const toolCall of pendingToolCalls) {
            yield {
              type: 'function_call',
              name: toolCall.name,
              params: toolCall.input
            };

            try {
              // Try with call_ prefix first (matches dispatcher convention), then without
              const handler = toolHandlers[`call_${toolCall.name}`] || toolHandlers[toolCall.name];
              if (!handler) {
                throw new Error(`No handler for tool: ${toolCall.name}`);
              }

              const result = await handler(toolCall.input);

              yield {
                type: 'function_result',
                name: toolCall.name,
                result
              };

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                // Underscore-prefixed keys are internal by contract (_fullData,
                // _chatAction): they ride the raw function_result event above
                // but never enter the model's context. Same rule as
                // llm.openai.js#stripInternalFields.
                content: JSON.stringify(stripInternal(result))
              });
            } catch (error) {
              console.error(`❌ Tool call failed: ${toolCall.name}`, error.message);

              yield {
                type: 'function_error',
                name: toolCall.name,
                error: error.message
              };

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: JSON.stringify({ error: error.message }),
                is_error: true
              });
            }
          }

          // Continue conversation with tool results. With web search on the
          // assistant turn also holds server-tool blocks that must go back
          // as they came, so the whole message is echoed (#967).
          const assistantContent = config.webSearch
            ? (await stream.finalMessage()).content
            : pendingToolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input }));
          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: assistantContent },
            { role: 'user', content: toolResults }
          ];
        } else {
          // No tool calls - done
          console.log(`✅ Claude streaming complete. Total reply length: ${fullReply.length}`);
          // Yield usage event for tracking
          if (claudeInputTokens || claudeOutputTokens) {
            yield {
              type: 'usage',
              inputTokens: claudeInputTokens,
              outputTokens: claudeOutputTokens,
              durationMs: Date.now() - _streamStart,
              ...(config.webSearch ? {
                webSearches: webSearchCount,
                webCitations,
                ...(webBlockedDomains.length ? { webBlockedDomains } : {}),
              } : {}),
            };
          }
          break;
        }
      }
    } catch (error) {
      console.error('❌ Claude Streaming Error:', error.message);
      const err = new Error(`Failed to stream Claude response: ${error.message}`);
      err.status = error.status || error.statusCode || null;
      throw err;
    }
  }

  /**
   * Generate a crew member configuration from a natural language description.
   * Loads context files (guides, examples) and uses Claude to generate the config.
   *
   * @param {string} description - Natural language description of the crew member
   * @param {string} agentName - The agent this crew will belong to
   * @param {Object} options - Additional options
   * @param {Array<string>} options.existingCrews - Names of existing crews (for transition options)
   * @param {Array<string>} options.availableTools - Available tool names
   * @param {Array<{id: string, name: string}>} options.knowledgeBases - Available KB stores
   * @returns {Promise<Object>} - The generated crew configuration object
   */
  async generateCrewFromDescription(description, agentName, options = {}) {
    const {
      existingCrews = [],
      availableTools = [],
      knowledgeBases = []
    } = options;

    try {
      // Load context documents
      const guideContent = this._loadContextFile('docs/guides/AGENT_BUILDING_GUIDE.md');
      const architectureContent = this._loadContextFile('docs/guides/DYNAMIC_CREW_ARCHITECTURE.md');
      const exampleCrew = this._loadExampleCrew();

      // Build the system prompt
      const systemPrompt = this._buildGenerationSystemPrompt();

      // Build the user message with all context
      const userMessage = this._buildGenerationUserMessage({
        description,
        agentName,
        guideContent,
        architectureContent,
        exampleCrew,
        existingCrews,
        availableTools,
        knowledgeBases
      });

      console.log(`🤖 Generating crew config for agent "${agentName}" (description: ${description.length} chars)`);

      // Call Claude for generation
      const result = await this.sendOneShot(systemPrompt, userMessage, {
        maxTokens: 8192,
        jsonOutput: true
      });
      const response = (result && typeof result === 'object' && 'text' in result) ? result.text : result;

      // Parse and validate the response
      const crewConfig = this._parseAndValidateCrewConfig(response);

      console.log(`✅ Generated crew config: ${crewConfig.name} (${crewConfig.displayName})`);

      return crewConfig;
    } catch (error) {
      console.error('❌ Crew generation failed:', error.message);
      throw new Error(`Failed to generate crew: ${error.message}`);
    }
  }

  /**
   * Clean message history for Claude compatibility
   * Claude only supports 'user' and 'assistant' roles
   * @param {Array} history - OpenAI-format message history
   * @returns {Array} - Cleaned history with only user/assistant messages
   * @private
   */
  _cleanHistoryForClaude(history) {
    return history
      .map(msg => {
        // Skip if no message or no role
        if (!msg || !msg.role) {
          console.warn('⚠️ Skipping invalid message (no role):', msg);
          return null;
        }

        // Skip system messages (they should be in systemPrompt instead)
        if (msg.role === 'system') {
          return null;
        }

        // Convert developer role to user (highest authority)
        if (msg.role === 'developer') {
          const content = this._ensureStringContent(msg.content);
          return content ? { role: 'user', content } : null;
        }

        // Convert function/tool messages to assistant
        if (msg.role === 'function' || msg.role === 'tool') {
          const content = this._ensureStringContent(msg.content);
          return content ? { role: 'assistant', content } : null;
        }

        // Keep user and assistant as-is
        if (msg.role === 'user' || msg.role === 'assistant') {
          const content = this._ensureStringContent(msg.content);
          return content ? { role: msg.role, content } : null;
        }

        // Skip unknown roles
        console.warn('⚠️ Skipping message with unknown role:', msg.role);
        return null;
      })
      .filter(msg => msg !== null); // Remove nulls
  }

  /**
   * Ensure content is a valid non-empty string
   * @private
   */
  _ensureStringContent(content) {
    // Handle null/undefined
    if (content === null || content === undefined) {
      return null;
    }

    // Handle empty string
    if (content === '') {
      return null;
    }

    // Handle strings
    if (typeof content === 'string') {
      return content.trim() || null;
    }

    // Handle objects/arrays - stringify them
    try {
      const stringified = JSON.stringify(content);
      // Don't return empty objects/arrays
      if (stringified === '{}' || stringified === '[]') {
        return null;
      }
      return stringified;
    } catch (err) {
      console.warn('⚠️ Could not stringify content:', err.message);
      return null;
    }
  }

  /**
   * Load a context file from the server root
   * @private
   */
  _loadContextFile(filename) {
    try {
      const filePath = path.join(__dirname, '..', filename);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
      console.warn(`⚠️ Context file not found: ${filename}`);
      return '';
    } catch (error) {
      console.warn(`⚠️ Failed to load context file ${filename}:`, error.message);
      return '';
    }
  }

  /**
   * Load an example crew file for reference
   * @private
   */
  _loadExampleCrew() {
    try {
      // Try to load a simple example crew
      const examplePath = path.join(__dirname, '..', 'agents', 'sample', 'crew', 'default.crew.js');
      if (fs.existsSync(examplePath)) {
        return fs.readFileSync(examplePath, 'utf8');
      }

      // Fallback: try freeda general
      const freedaPath = path.join(__dirname, '..', 'agents', 'freeda', 'crew', 'general.crew.js');
      if (fs.existsSync(freedaPath)) {
        return fs.readFileSync(freedaPath, 'utf8');
      }

      return '';
    } catch (error) {
      console.warn('⚠️ Failed to load example crew:', error.message);
      return '';
    }
  }

  /**
   * Build the system prompt for crew generation
   * @private
   */
  _buildGenerationSystemPrompt() {
    return `You are an expert AI agent architect. Your task is to generate crew member configurations for a multi-agent chat platform.

A crew member is a specialized role within an AI agent. Each crew handles a specific part of a conversation flow.

You will be given:
1. Documentation about how crew members work (the architecture guide)
2. An example of an existing crew member
3. A natural language description of what the new crew should do
4. Context about the agent and its existing crews

Your job is to generate a complete, valid JSON configuration for the new crew member.

OUTPUT RULES:
- Output ONLY valid JSON - no markdown, no code blocks, no explanation
- The JSON must match the crew member schema exactly
- Generate appropriate field names (snake_case)
- Write detailed, professional guidance prompts
- Be conservative with tools - only include if clearly needed
- Only reference existing crews for transitions`;
  }

  /**
   * Build the user message with all context for generation
   * @private
   */
  _buildGenerationUserMessage(params) {
    const {
      description,
      agentName,
      guideContent,
      architectureContent,
      exampleCrew,
      existingCrews,
      availableTools,
      knowledgeBases
    } = params;

    return `## ARCHITECTURE GUIDE
${architectureContent || guideContent || 'No guide available - use best practices for conversational AI crews.'}

## EXAMPLE CREW MEMBER FILE
\`\`\`javascript
${exampleCrew || '// No example available'}
\`\`\`

## AGENT CONTEXT
- Agent Name: ${agentName}
- Existing Crews: ${existingCrews.length > 0 ? existingCrews.join(', ') : 'None yet (this may be the first crew)'}
- Available Tools: ${availableTools.length > 0 ? availableTools.join(', ') : 'None available'}
- Knowledge Bases: ${knowledgeBases.length > 0 ? knowledgeBases.map(kb => `${kb.name} (${kb.id})`).join(', ') : 'None available'}

## USER DESCRIPTION
${description}

## OUTPUT SCHEMA
Generate a JSON object with these fields:
{
  "name": "string - unique identifier, snake_case (e.g., 'billing_support')",
  "displayName": "string - human readable name (e.g., 'Billing Support')",
  "description": "string - brief description of what this crew does",
  "isDefault": "boolean - true if this is the entry point crew",
  "guidance": "string - the full system prompt/instructions for this crew",
  "model": "string - LLM model to use (default: 'gpt-4o')",
  "maxTokens": "number - max response tokens (default: 2048)",
  "fieldsToCollect": "array - fields to extract from conversation, each: { name: string, description: string }",
  "transitionTo": "string | null - name of crew to transition to when done",
  "transitionSystemPrompt": "string | null - message injected when transitioning TO this crew",
  "tools": "array - tool names to enable (from available tools list)",
  "knowledgeBase": "object | null - { enabled: boolean, storeId: string } if using KB"
}

Now generate the crew configuration JSON:`;
  }

  /**
   * Parse and validate the generated crew config
   * @private
   */
  _parseAndValidateCrewConfig(response) {
    // Clean up response - remove any markdown code blocks if present
    let cleanResponse = response.trim();
    if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Parse JSON
    let config;
    try {
      config = JSON.parse(cleanResponse);
    } catch (error) {
      throw new Error(`Invalid JSON response from Claude: ${error.message}`);
    }

    // Validate required fields
    const required = ['name', 'displayName', 'guidance'];
    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Apply defaults
    const defaults = {
      description: '',
      isDefault: false,
      model: 'gpt-4o',
      maxTokens: 2048,
      fieldsToCollect: [],
      transitionTo: null,
      transitionSystemPrompt: null,
      tools: [],
      knowledgeBase: null
    };

    return { ...defaults, ...config };
  }

  /**
   * Generate the .crew.js file code from a config object.
   * Used for "Export to File" feature.
   *
   * @param {Object} config - The crew configuration object
   * @param {string} agentName - The agent name (for class naming)
   * @returns {string} - The generated JavaScript code
   */
  generateCrewFileCode(config, agentName) {
    // Convert name to PascalCase for class name (no agent prefix)
    const className = config.name
      .split('_')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('') + 'Crew';

    // Build the file content
    const code = `/**
 * ${config.displayName}
 *
 * ${config.description || 'Auto-generated crew member'}
 * Generated by Crew Builder
 */
const CrewMember = require('../../../crew/base/CrewMember');

class ${className} extends CrewMember {
  constructor() {
    super({
      name: '${config.name}',
      displayName: '${config.displayName}',
      description: '${(config.description || '').replace(/'/g, "\\'")}',
      isDefault: ${config.isDefault},

      guidance: \`${config.guidance.replace(/`/g, '\\`')}\`,

      model: '${config.model}',
      maxTokens: ${config.maxTokens},

      fieldsToCollect: ${JSON.stringify(config.fieldsToCollect || [], null, 6).replace(/\n/g, '\n      ')},

      transitionTo: ${config.transitionTo ? `'${config.transitionTo}'` : 'null'},
      ${config.transitionSystemPrompt ? `transitionSystemPrompt: \`${config.transitionSystemPrompt.replace(/`/g, '\\`')}\`,` : '// transitionSystemPrompt: null,'}

      tools: [],  // TODO: Add tools if needed
      knowledgeBase: ${config.knowledgeBase ? JSON.stringify(config.knowledgeBase) : 'null'}
    });
  }

  // TODO: Override buildContext() if you need custom context
  // async buildContext(params) {
  //   const baseContext = await super.buildContext(params);
  //   return {
  //     ...baseContext,
  //     // Add custom context here
  //   };
  // }

  // TODO: Override preMessageTransfer() if you need custom transition logic
  // async preMessageTransfer(collectedFields) {
  //   // Return true to trigger transition to this.transitionTo
  //   return false;
  // }
}

module.exports = ${className};
`;

    return code;
  }
}

module.exports = new ClaudeService();
