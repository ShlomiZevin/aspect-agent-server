/**
 * liveBrainDispatcher — compute the agent's Live Brain panels for one
 * turn, AFTER the user-facing reply (same non-blocking phase as the
 * offline lane).
 *
 * Two kinds of panel (see docs/guides/BUILDER_V2_LIVE_BRAIN.md):
 *
 *   - TEXT panels  — the author's free text with `{{tokens}}`. Resolved
 *     every turn via the same `promptAssembler` the addons use (no LLM),
 *     then stored to `brain.panels[panelId]`. Cheap + deterministic.
 *
 *   - AI (prompt) panels — a dedicated LLM call. Gated by a cadence
 *     trigger (`every_n_messages` / `on_transition`), then run through
 *     the standard `addonRunner` (which also applies the panel's Filter,
 *     logs the run + LLM usage, and emits SSE). The `live-brain-panel`
 *     plugin validates the answer and writes / clears the panel slot.
 *
 * Panels are agent-level (`agent.liveBrain.panels`), so they run for
 * every crew. Their runs carry `pluginId: 'live-brain-panel'` — the tag
 * that keeps brain activity distinguishable from chat addons in the run
 * inspector and usage dashboard. At the end of the turn ONE
 * `brain.snapshot` SSE event carries the render-ready panel list, so an
 * open Live Brain view updates live off the same stream as the chat (no
 * refetch). `resolvePanelsForClient` is shared with the `/live-brain`
 * endpoint used for initial load / history.
 */

const { assemblePrompt } = require('./promptAssembler');
const { parseOutput } = require('./outputParser');
const { validatePanelValues } = require('./panelShapes');
const builderMemory = require('./builderMemory');
const offlineTriggerState = require('./offlineTriggerState');
const { runAddon } = require('./addonRunner');
const addonRunsStore = require('./addonRunsStore');
const { evaluateConditions } = require('./conditionMatcher');

/** Trigger evaluation — mirrors offlineDispatcher.shouldFire. */
function shouldFire(trigger, nextCounter, didTransition) {
  if (!trigger || typeof trigger !== 'object') return false;
  if (trigger.kind === 'every_n_messages') {
    const n = Math.max(1, Math.floor(trigger.n || 0));
    return nextCounter >= n;
  }
  if (trigger.kind === 'on_transition') return !!didTransition;
  return false;
}

/** Resolve a TEXT panel's `{{tokens}}` against the live brain, reusing the
 *  addon prompt assembler (the template IS the panel's text). */
function resolveText(ctx, panel) {
  const runnable = ctx.runnable;
  const agentFields = Array.isArray(runnable.agent.body?.fields) ? runnable.agent.body.fields : [];
  const crewFields  = Array.isArray(runnable.crew.body?.fields)  ? runnable.crew.body.fields  : [];
  const synthetic = {
    instanceId:     panel.id,
    pluginId:       'live-brain-text',
    lane:           'offline',
    config:         { prompt: '' },
    context:        { history: { mode: 'none' } },
    outputType:     'json-to-memory',
    promptTemplate: String(panel.source?.text || ''),
  };
  return assemblePrompt({
    instance:               synthetic,
    personas:               ctx.agentPersonas,
    memoryValuesByDomain:   ctx.memoryValuesByDomain,
    memoryDomainList:       ctx.memoryDomainList,
    thinkingValuesByDomain: ctx.thinkingValuesByDomain,
    thinkingDomainList:     ctx.thinkingDomainList,
    retrievalValueOf:       ctx.retrievalValueOf,
    fieldValueOf:           ctx.fieldValueOf,
    extractorFields:        [],
    parameters:             ctx.agentParameters,
    enums:                  ctx.agentEnums,
    fieldsForDc:            [...agentFields, ...crewFields],
    summaries:              ctx.memory?.summary || {},
    snippets:               Array.isArray(runnable.agent.body?.snippets) ? runnable.agent.body.snippets : [],
    brain:                  ctx.memory,
    onEnumResolved:         () => {},
    onDcResolved:           () => {},
  });
}

/** Turn a resolved text string into a stored panel entry, or null (hide).
 *  A `text` render stores the string; a structured render tries to parse
 *  the resolved string as that shape (so a power user can compose JSON
 *  with tokens). */
function shapeTextEntry(render, resolved) {
  // `text` (Markdown) and `html` are free-form string renders — store the
  // resolved string as-is under the actual render so the client draws it
  // with the right renderer.
  if (render === 'text' || render === 'html' || !render) {
    const text = (resolved || '').trim();
    return text ? { render: render || 'text', text, ranAt: Date.now() } : null;
  }
  const { parsed } = parseOutput('json-to-memory', resolved || '');
  const values = validatePanelValues(render, parsed);
  return values ? { render, values, ranAt: Date.now() } : null;
}

/** Build the synthetic AddonInstance an AI panel runs as. The cadence
 *  trigger is handled here (not by addonRunner); the panel's Filter goes
 *  on `context.filter` so addonRunner's gate applies it. */
function toPromptInstance(panel) {
  const src = panel.source || {};
  return {
    instanceId:     panel.id,
    pluginId:       'live-brain-panel',
    lane:           'offline',
    enabled:        true,
    config:         { name: panel.title, prompt: src.prompt || '', model: src.model, render: panel.render },
    context:        { history: src.history || { mode: 'last_n', n: 10 }, ...(panel.filter ? { filter: panel.filter } : {}) },
    outputType:     'json-to-memory',
    promptTemplate: '{{prompt}}',
  };
}

/**
 * Resolve the agent's panels into the render-ready, filter-applied list
 * the client renders — the customer Live Brain AND the builder preview.
 * A panel is omitted when its filter fails (hidden) or it holds no valid
 * value. Shared by the SSE `brain.snapshot` (live) and the `/live-brain`
 * endpoint (initial load / history) so both surfaces agree exactly.
 */
function resolvePanelsForClient(panels, brain) {
  const out = [];
  for (const panel of panels || []) {
    if (!panel || !panel.id) continue;

    // Filter → the panel hides when its conditions don't pass.
    const filter = panel.filter;
    if (filter && Array.isArray(filter.conditions) && filter.conditions.length > 0) {
      const evalResult = evaluateConditions(brain, filter.conditions, { instanceId: panel.id });
      const passes = filter.mode === 'exclude' ? !evalResult.ok : evalResult.ok;
      if (!passes) continue;
    }

    // No stored value → never produced a valid result → hidden.
    const entry = builderMemory.getPanel(brain, panel.id);
    if (!entry) continue;

    out.push({
      id:     panel.id,
      title:  panel.title,
      render: entry.render || panel.render,
      ...(entry.text   !== undefined ? { text:   entry.text }   : {}),
      ...(entry.values !== undefined ? { values: entry.values } : {}),
      ranAt:  entry.ranAt,
    });
  }
  return out;
}

/** Log a TEXT panel's resolution as a run so the builder's run inspector
 *  shows a full picture. Text panels don't call an LLM, but the author
 *  still wants to see what each produced — so we mirror the addon.output
 *  run shape (input = the token template, output = the resolved string)
 *  and the builder renders it in the SAME AddonRunCard as an AI panel. */
async function logTextRun(ctx, panel, entry, resolved) {
  const runData = {
    instanceId:   panel.id,
    label:        panel.title || panel.id,
    kind:         'text',
    modelLabel:   null,
    // The author's template (with {{tokens}}) is the "input" for a text
    // panel — showing it beside the resolved output is how you debug a
    // token that didn't resolve the way you expected.
    prompt:       String(panel.source?.text || ''),
    rawOutput:    typeof resolved === 'string' ? resolved : '',
    parsedOutput: entry ? (entry.text !== undefined ? entry.text : (entry.values ?? null)) : null,
    durationMs:   0,
    lane:         'offline',
    ...(entry ? {} : { hidden: true }),
  };
  try {
    await addonRunsStore.insertRun({
      conversationId: ctx.conversationId,
      messageId:      ctx.assistantMessageId,
      instance:       { instanceId: panel.id, pluginId: 'live-brain-panel' },
      status:         'success',
      startedAt:      new Date(),
      endedAt:        new Date(),
      durationMs:     0,
      runData,
    });
  } catch (err) {
    console.error('[liveBrainDispatcher] text run log failed:', err.message);
  }
}

async function dispatchLiveBrainPanels({ ctx, didTransition }) {
  const { runnable, userId, conversationId, memory, emit } = ctx;
  const panels = Array.isArray(runnable.agent.body?.liveBrain?.panels)
    ? runnable.agent.body.liveBrain.panels
    : [];
  if (panels.length === 0) return;

  // ── 1. TEXT panels — resolve tokens now, write to the brain, log it. ──
  const textWrites = [];
  const textLogs = []; // { panel, entry, resolved }
  for (const panel of panels) {
    if (!panel || panel.source?.kind !== 'text') continue;
    let entry = null;
    let resolved = '';
    try {
      resolved = resolveText(ctx, panel);
      entry = shapeTextEntry(panel.render, resolved);
    } catch (err) {
      console.error('[liveBrainDispatcher] text panel resolve failed:', err.message);
    }
    textWrites.push(entry ? { kind: 'panel', panelId: panel.id, entry } : { kind: 'panel', panelId: panel.id, clear: true });
    textLogs.push({ panel, entry, resolved });
  }
  if (textWrites.length > 0) {
    builderMemory.applyWrites(memory, textWrites);
    try {
      await builderMemory.saveMemory(userId, conversationId, memory);
    } catch (err) {
      console.error('[liveBrainDispatcher] text panel memory save failed:', err.message);
    }
    await Promise.all(textLogs.map(t => logTextRun(ctx, t.panel, t.entry, t.resolved)));
  }

  // ── 2. AI (prompt) panels — cadence-gated, run via addonRunner. Each
  //    run emits its own addon.start/prompt/output on the stream (the
  //    builder captures those for the panel's run log) and writes the
  //    panel slot into `memory`. ──
  const promptPanels = panels.filter(p => p?.source?.kind === 'prompt');
  if (promptPanels.length > 0) {
    const state = await offlineTriggerState.load(userId, conversationId);
    const dispatches = [];
    for (const panel of promptPanels) {
      const current  = offlineTriggerState.readCounter(state, panel.id);
      const next     = current + 1;
      if (shouldFire(panel.source.trigger, next, didTransition)) {
        offlineTriggerState.writeCounter(state, panel.id, 0);
        dispatches.push(panel);
      } else {
        offlineTriggerState.writeCounter(state, panel.id, next);
      }
    }
    try {
      await offlineTriggerState.save(userId, conversationId, state);
    } catch (err) {
      console.error('[liveBrainDispatcher] trigger-state save failed:', err.message);
    }

    if (dispatches.length > 0) {
      await Promise.all(dispatches.map(panel =>
        runAddon({ ctx, instance: toPromptInstance(panel), addonStart: Date.now() })
          .catch(err => {
            console.error('[liveBrainDispatcher] unexpected throw from runAddon:', err.message);
          }),
      ));
    }
  }

  // ── 3. Snapshot — ONE render-ready, filter-applied event the client
  //    swaps its panels to (customer Live Brain + builder preview),
  //    exactly like a chat message arrives on the stream. Emitted after
  //    both lanes so `memory` reflects every write this turn — no
  //    refetch, no polling, no Refresh button. ──
  try {
    emit('brain.snapshot', { panels: resolvePanelsForClient(panels, memory) });
  } catch { /* emit is best-effort */ }
}

module.exports = { dispatchLiveBrainPanels, resolvePanelsForClient };
