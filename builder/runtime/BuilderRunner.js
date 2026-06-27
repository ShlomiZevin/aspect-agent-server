/**
 * Builder V2 — BuilderRunner (engine).
 *
 * Plugin-agnostic. One run per HTTP request. Loops the crew's
 * blocking-lane addons in order, looks each plugin up in the
 * registry, and delegates the LLM-shape concerns (streaming vs
 * one-shot, output parsing, memory write extraction) to the plugin
 * descriptor's `run()`.
 *
 * The engine owns:
 *   - resolving the addons list for the requested version
 *   - loading the conversation memory blob (builderMemory)
 *   - fetching message history per addon's context.history config
 *   - assembling the prompt (promptAssembler)
 *   - emitting SSE events (addon.start / .prompt / .output / .error)
 *   - merging memory writes back into the blob and persisting it
 *   - persisting an addon_runs row per execution (P2)
 *
 * Plugins own:
 *   - the LLM call shape (which provider method, streaming vs not)
 *   - usage logging when the call streams (one-shot is auto-logged by llm.js)
 *   - output parsing
 *   - memoryWrites extraction from the parsed output
 *
 * See docs/guides/BUILDER_V2_ADDONS.md for the full plugin contract.
 *
 * SSE events emitted by the engine (per turn):
 *   conversation, addon.start, addon.prompt, addon.token (from plugin),
 *   addon.output, addon.error, assistant.message, done
 */

const llmService = require('../../services/llm');
const { eq } = require('drizzle-orm');
const db = require('../../services/db.pg');
const { conversations, messages } = require('../../db/schema');
const { resolveRunnable } = require('../services/builderProjects');
const { logUsage } = require('../../services/usageLogger');
const builderMemory = require('./builderMemory');
const { seedPinnedFields } = require('./pinnedFields');
const { runAddon } = require('./addonRunner');
const { dispatchOfflineAddons } = require('./offlineDispatcher');
const modelsService = require('../../services/models.service');

// Provider-id → display label, pre-indexed so the per-addon resolve
// is O(1). Source of truth is services/models.service.js; mirror in
// the addon-run payload so the chat UI can show "OpenAI · GPT-4o mini"
// without a separate lookup.
const PROVIDER_LABELS_BY_ID = Object.fromEntries(
  modelsService.PROVIDERS.map(p => [p.id, p.label]),
);

function resolveModelLabel(modelRef) {
  if (!modelRef || !modelRef.modelId) return null;
  const m = modelsService.getModel(modelRef.modelId);
  if (!m) return null;
  return {
    providerName: PROVIDER_LABELS_BY_ID[m.providerId] || m.providerId,
    modelName:    m.name,
  };
}

// Side-effect: ensure built-in plugins are registered.
require('../plugins');

/**
 * Run one turn end-to-end.
 *
 * @param {object} args
 * @param {string} args.agentSlug
 * @param {string} args.ownerUserId
 * @param {number} args.userId — internal DB user id; required for memory persistence
 * @param {number} args.conversationId — internal (DB) conversation id; required for usage logs
 * @param {number} args.userMessageId — DB id of THIS turn's just-inserted user message.
 *   Used to cap `historyService` queries so blocking addons don't see the current
 *   turn's own rows.
 * @param {number} args.assistantMessageId — DB id of the (pending) assistant message; addon_runs FK
 * @param {string} args.userMessage
 * @param {'viewing'|'active'} args.version
 * @param {string|null} [args.overrideCrewId] — explicit override (e.g. the user
 *   picked a different crew from the chat header dropdown). When provided, takes
 *   precedence over `conversation.metadata.currentCrewId` and is persisted as the
 *   new pointer so subsequent turns default to it.
 * @param {object|null} [args.overrideAgentBody] — working-copy agent body sent
 *   by the builder UI so unsaved edits run against the draft state. Falls back
 *   to the saved viewing version body when null/missing.
 * @param {object|null} [args.overrideCrewBody] — working-copy crew body. Same
 *   purpose as overrideAgentBody but scoped to the routed crew.
 * @param {function} args.emit — (eventType, payload) → void; writes an SSE event
 * @returns {Promise<{ assistantText: string }>}
 */
async function runOnce({
  agentSlug,
  ownerUserId,
  userId,
  conversationId,
  userMessageId,
  assistantMessageId,
  userMessage,
  version,
  overrideCrewId = null,
  overrideAgentBody = null,
  overrideCrewBody  = null,
  // Map of crewId → working-copy crew body. Used by the cascade loop so
  // a Transition Router hop into a non-current crew sees that crew's
  // UNSAVED edits, not the saved DB body. The current crew is still
  // covered by `overrideCrewBody` (backward compat) — we merge it in
  // below so the lookup is uniform.
  overrideCrewBodies = null,
  emit,
}) {
  const totalStart = Date.now();

  // Resolve the current-crew pointer. Priority:
  //   1. explicit per-turn override from the request (user-picked crew)
  //   2. conversation.metadata.currentCrewId (set by a prior Transition Router firing)
  //   3. null → resolver falls back to the agent's defaultCrewId
  const drizzle = db.getDrizzle();
  const [convRow] = await drizzle.select().from(conversations)
    .where(eq(conversations.id, Number(conversationId))).limit(1);
  const metaCrewId = (convRow?.metadata && convRow.metadata.currentCrewId) || null;
  const currentCrewId = overrideCrewId || metaCrewId;

  // Persist the override into metadata so subsequent turns default to it.
  // (The route handler also pre-persists before emitting `conversation`
  // so the SSE event already reflects this — kept here as a defensive
  // idempotent retry in case that pre-persist failed.)
  if (overrideCrewId && overrideCrewId !== metaCrewId) {
    try {
      const currentMeta = convRow?.metadata || {};
      const nextMeta = { ...currentMeta, currentCrewId: overrideCrewId };
      await drizzle.update(conversations)
        .set({ metadata: nextMeta, updatedAt: new Date() })
        .where(eq(conversations.id, Number(conversationId)));
      if (convRow) convRow.metadata = nextMeta;
    } catch (err) {
      console.error('[BuilderRunner] override crew persist failed:', err.message);
    }
  }

  // Build a uniform crewId → body map. `overrideCrewBody` (the legacy
  // single-crew override) gets folded in under the resolved current
  // crew id so the cascade lookup below covers it without special
  // cases. Map wins over individual when both exist (caller intent).
  const crewBodyOverrides = { ...(overrideCrewBodies || {}) };
  if (overrideCrewBody && currentCrewId && !crewBodyOverrides[currentCrewId]) {
    crewBodyOverrides[currentCrewId] = overrideCrewBody;
  }

  // ── 1. Resolve runnable: which crew + addons for this version. ──
  const runnable = await resolveRunnable({
    agentSlug,
    ownerUserId,
    mode: version === 'active' ? 'active' : 'viewing',
    overrideCrewId: currentCrewId,
    overrideAgentBody,
    overrideCrewBody: (currentCrewId && crewBodyOverrides[currentCrewId]) || overrideCrewBody,
  });

  // Multi-persona: prefer the named `personas[]`; fall back to the
  // legacy single `persona` string (seeded as one general persona
  // applied to all addons) so agents saved before multi-persona keep
  // working. The assembler picks which apply per addon via `appliesTo`.
  const agentPersonas    = Array.isArray(runnable.agent.body?.personas)
    ? runnable.agent.body.personas
    : (runnable.agent.body?.persona
        ? [{ id: 'persona_main', name: 'main', content: runnable.agent.body.persona, appliesTo: ['*'] }]
        : []);
  const agentParameters  = Array.isArray(runnable.agent.body?.parameters) ? runnable.agent.body.parameters : [];
  const agentEnums       = Array.isArray(runnable.agent.body?.enums)      ? runnable.agent.body.enums      : [];
  const agentNameForLogs = runnable.agent.body?.name || agentSlug;
  const crewLabel        = runnable.crew.body?.name || 'crew';
  // Agent-level cortex runs BEFORE the crew's cortex on every turn.
  // Sees the same memory / brain / history; outputs feed into the crew
  // chain that follows. Restricted plugins (Talker, Transition Router)
  // are filtered out at the picker level on the client, but a defensive
  // filter here keeps a hand-edited body from spawning a forbidden one.
  const RESTRICTED_AT_AGENT = new Set(['talker', 'transition-router']);
  const agentCortex = Array.isArray(runnable.agent.body?.cortex) ? runnable.agent.body.cortex : [];
  const allAddons   = [
    ...agentCortex.filter(a => !RESTRICTED_AT_AGENT.has(a?.pluginId)),
    ...(Array.isArray(runnable.crew.body?.addons) ? runnable.crew.body.addons : []),
  ];
  const blockingAddons = allAddons.filter(a => a.lane === 'main' && a.enabled !== false);

  // ── 2. Load accumulated brain state + accessors for the prompt. ──
  //
  // The blob is normalized to `{ memory, thinking }` by loadMemory.
  // Extractors write to memory; Thinker writes to thinking; Talker /
  // other prompt-bearing addons read from both. Dynamic Context is
  // resolved against memory field values inside the assembler — no
  // separate brain section.
  const memory = await builderMemory.loadMemory(userId, conversationId);
  // Seed `source: 'pinned'` fields' defaults into memory BEFORE any
  // readers (prompt assembler, addon prompts, …) close over the
  // accessor closures below. Idempotent — only writes when the slot is
  // empty, so existing conversation memory and the chat-header swap
  // chip's per-conversation overrides always win.
  try {
    const seeded = seedPinnedFields(memory, runnable);
    if (seeded > 0) {
      await builderMemory.saveMemory(userId, conversationId, memory);
    }
  } catch (err) {
    console.error('[BuilderRunner] pinned-field seed failed:', err.message);
  }
  const fieldValueOf           = (name)   => builderMemory.findFieldValue(memory, name, 'memory');
  const memoryValuesByDomain   = (domain) => builderMemory.valuesForDomain(memory, domain, 'memory');
  const thinkingValuesByDomain = (domain) => builderMemory.valuesForDomain(memory, domain, 'thinking');
  const memoryDomainList       = ()       => builderMemory.listDomainsWithValues(memory, 'memory');
  const thinkingDomainList     = ()       => builderMemory.listDomainsWithValues(memory, 'thinking');
  // KB Retriever slots — read by the {{kb-retrieve:NAME}} token. Closes
  // over the live blob so a Retriever upstream this turn is visible.
  const retrievalValueOf       = (name)   => builderMemory.getRetrieval(memory, name);

  // ── 3. Build the shared per-turn execution context. ──
  // `addonRunner` and `offlineDispatcher` both consume this shape.
  // Anything stable across all addons in this turn lives here so the
  // per-addon callsites stay tiny.
  //
  // `historyExcludeFromMessageId` scopes `historyService` queries to
  // messages strictly BEFORE the current turn's user message id. The
  // route handler inserts BOTH the user message AND an empty
  // assistant placeholder before this function is called (the
  // placeholder is needed up-front so `addon_runs.message_id` has a
  // valid FK target). Without the cutoff, any blocking addon's
  // `history` would see both current-turn rows — the placeholder
  // even arrives empty, which is worse than just being extra context.
  // We FLIP the cutoff between phases below: blocking gets the cap,
  // offline gets none (it runs after we persist the assistant text,
  // so including the current turn is both correct and desired).
  const ctx = {
    runnable,
    agentSlug,
    ownerUserId,
    userId,
    conversationId,
    assistantMessageId,
    userMessage,
    crewLabel,
    agentNameForLogs,
    agentPersonas,
    agentParameters,
    agentEnums,
    memory,
    memoryValuesByDomain,
    memoryDomainList,
    thinkingValuesByDomain,
    thinkingDomainList,
    retrievalValueOf,
    fieldValueOf,
    drizzle,
    convRow,
    emit,
    llm: llmService,
    logUsage,
    resolveModelLabel,
    // Blocking-phase cutoff. Flipped to `undefined` before the
    // offline phase (see below).
    historyExcludeFromMessageId: Number.isFinite(userMessageId) && userMessageId > 0
      ? Number(userMessageId)
      : undefined,
  };

  let assistantText = '';
  let anyTransition = false;

  /** Max transition cascades we'll follow in one turn. A guard against
   *  loops, not a soft limit — authors shouldn't be relying on chained
   *  transitions to do anything more sophisticated than "A → B → C". */
  const MAX_TRANSITION_HOPS = 4;

  /**
   * Run one crew's main-lane chain. Returns:
   *   - assistantText (last talker's reply, or '')
   *   - anyTransition (true if any Transition Router fired)
   *   - cascadeTo (next crew id when fireImmediately + matched; else null)
   *
   * The cascade target is the LAST transition that fired with
   * fireImmediately set during this chain — same convention the
   * conversation metadata uses (last writer wins).
   */
  async function runChain(blockingForChain) {
    let chainText = '';
    let chainTransition = false;
    let cascadeTo = null;
    for (const instance of blockingForChain) {
      const { result, didTransition, broke } = await runAddon({ ctx, instance });
      if (didTransition) {
        chainTransition = true;
        const fireImmediately = result?.transition?.fireImmediately !== false;
        if (fireImmediately && result?.transition?.to) {
          cascadeTo = result.transition.to;
        }
      }
      if (result && typeof result.assistantText === 'string' && result.assistantText) {
        chainText = result.assistantText;
      }
      if (broke) break;
    }
    return { chainText, chainTransition, cascadeTo };
  }

  // ── 4. Run the blocking chain. addonRunner is the SINGLE source of ──
  // truth for "how one addon executes" — same code path the offline
  // dispatcher uses below. The orchestration here (sequential,
  // honouring `breakChain`) is what makes this the blocking lane.
  //
  // First pass: agent.cortex (filtered) → current crew's main-lane
  // chain. Then, while the last chain finished with a fireImmediately
  // cascade target, swap to that crew's main-lane chain and run it.
  // Agent cortex does NOT re-run on cascades — it already produced its
  // outputs in the first pass, and its purpose is "pre-crew" work.
  {
    const first = await runChain(blockingAddons);
    if (first.chainText) assistantText = first.chainText;
    if (first.chainTransition) anyTransition = true;

    let cascadeTo = first.cascadeTo;
    let hops = 0;
    while (cascadeTo && hops < MAX_TRANSITION_HOPS) {
      hops += 1;
      // Reset crew-transition-scoped system fields (e.g. `moveOn`)
      // BEFORE the next crew's chain runs. Otherwise the new crew's
      // Thinker / Router would see the stale signal from the crew
      // we just left and might trigger again unwarranted.
      const { resetSystemFields } = require('./systemFields');
      resetSystemFields(memory, 'crew-transition');
      try {
        await builderMemory.saveMemory(userId, conversationId, memory);
      } catch (err) {
        console.error('[BuilderRunner] system-field reset save failed:', err.message);
      }

      // Resolve the new crew's runnable and reseat the shared ctx so
      // addonRunner sees the right crew body (fields, name, etc.).
      const nextRunnable = await resolveRunnable({
        agentSlug,
        ownerUserId,
        mode: version === 'active' ? 'active' : 'viewing',
        overrideCrewId: cascadeTo,
        overrideAgentBody,
        // Pick this crew's working body from the map so cascades respect
        // unsaved edits to the target. `null` falls back to the DB body.
        overrideCrewBody: crewBodyOverrides[cascadeTo] || null,
      });
      ctx.runnable  = nextRunnable;
      ctx.crewLabel = nextRunnable.crew.body?.name || ctx.crewLabel;
      const nextBlocking = (Array.isArray(nextRunnable.crew.body?.addons) ? nextRunnable.crew.body.addons : [])
        .filter(a => a.lane === 'main' && a.enabled !== false);

      const next = await runChain(nextBlocking);
      // CONCATENATE cascade-chain talker text instead of clobbering it.
      // Each chain may have its own Talker; both stream tokens into the
      // same chat bubble live (one row per turn), so the persisted /
      // history-reload text MUST mirror what the user already saw — both
      // talkers' contributions, in order, separated by a blank line.
      // Previously `assistantText = next.chainText` dropped the prior
      // crew's reply silently, so the persisted message + history reload
      // only carried the last talker's text.
      if (next.chainText) {
        assistantText = assistantText
          ? `${assistantText}\n\n${next.chainText}`
          : next.chainText;
      }
      if (next.chainTransition) anyTransition = true;
      cascadeTo = next.cascadeTo;
    }

    if (cascadeTo) {
      // Hit the cap — emit a warning so authors see the cascade was
      // truncated rather than silently stopping mid-loop.
      try {
        emit('warning', {
          code:    'transition_cascade_limit',
          message: `Stopped transition cascade at ${MAX_TRANSITION_HOPS} hops in one turn. ` +
                   `The last hop wanted to fire crew "${cascadeTo}" but the guard kicked in.`,
        });
      } catch { /* emit is best-effort */ }
    }
  }

  // ── 5. Persist the assistant text and announce the turn's reply. ──
  // We do this BEFORE the offline phase so:
  //   - the user sees the reply land in the chat right away (the
  //     stream stays open until offline addons finish, but
  //     `assistant.message` already happened)
  //   - offline addons (Summarizer, …) see the FULL assistant message
  //     when they query history, not the empty placeholder the route
  //     handler reserved up-front
  //
  // Best-effort: a DB hiccup here shouldn't break the conversation —
  // the route handler has a fallback cleanup path for an empty
  // placeholder. Errors are logged; the offline phase still runs.
  if (assistantText && Number.isFinite(assistantMessageId) && assistantMessageId > 0) {
    try {
      await drizzle.update(messages)
        .set({ content: assistantText })
        .where(eq(messages.id, Number(assistantMessageId)));
      emit('assistant.message', {
        messageId: Number(assistantMessageId),
        text:      assistantText,
      });
    } catch (err) {
      console.error('[BuilderRunner] assistant text persist failed:', err.message);
    }
  }

  // ── 6. Dispatch the OFFLINE lane. ──
  // Offline addons run AFTER the user-facing reply streams + lands in
  // the DB. They see the full turn (current user message + filled
  // assistant message) — that's the point of the offline phase. We
  // flip the cutoff to `undefined` so `historyService` returns
  // everything up to the present. Each offline addon emits the same
  // SSE event family as a blocking addon via `addonRunner`; only the
  // `addon.start.lane` field distinguishes them on the client. Runs
  // in parallel; awaited here so the request stays open until they
  // finish — which is what lets the chat UI render their cards in
  // the same timeline.
  ctx.historyExcludeFromMessageId = undefined;
  await dispatchOfflineAddons({ ctx, didTransition: anyTransition });

  return { assistantText, totalMs: Date.now() - totalStart };
}

module.exports = { runOnce };
