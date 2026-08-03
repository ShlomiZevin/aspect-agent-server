/**
 * profilerDispatcher — compute the agent's Profiler panels for one turn,
 * AFTER the user-facing reply (same non-blocking phase as the Live Brain
 * and offline lanes).
 *
 * This is the SIBLING of `liveBrainDispatcher`: the Profiler is a second
 * customer-facing surface (a live, LLM-built customer profile). It reuses
 * the SAME engine — every panel is an ordinary addon run through
 * `addonRunner`, logged in the run log + `llm_usage`. The only real
 * differences from Live Brain:
 *
 *   - panels write to the `profiler` memory slot (not `brain`), so the
 *     two surfaces never collide;
 *   - runs carry `pluginId: 'profiler-panel'` (a second id on the SAME
 *     plugin) so the run inspector / reasoning filters keep them separate;
 *   - usage is tagged `PF · <panel>` under the `profiler` crew bucket.
 *
 * Panels are agent-level (`agent.profiler.panels`), so they run for every
 * crew. Each panel emits its own `profiler.panel` SSE the moment its value
 * is ready (panel-by-panel, not one batched snapshot).
 * `resolveProfilerPanelsForClient` is shared with the `/profiler` endpoint
 * used for initial load / history.
 */

const { assemblePrompt } = require('./promptAssembler');
const { parseOutput } = require('./outputParser');
const { validatePanelValues } = require('./panelShapes');
const builderMemory = require('./builderMemory');
const offlineTriggerState = require('./offlineTriggerState');
const { runAddon } = require('./addonRunner');
const addonRunsStore = require('./addonRunsStore');
const { evaluateConditions } = require('./conditionMatcher');
const modelsService = require('../../services/models.service');

const PROFILER_SLOT = 'profiler';
const PROFILER_PLUGIN_ID = 'profiler-panel';

// Provider-id → label, so a refresh ctx can hand runAddon the same
// `resolveModelLabel` the turn does (mirrors BuilderRunner).
const PROVIDER_LABELS_BY_ID = Object.fromEntries(
  modelsService.PROVIDERS.map(p => [p.id, p.label]),
);
function resolveModelLabel(modelRef) {
  if (!modelRef || !modelRef.modelId) return null;
  const m = modelsService.getModel(modelRef.modelId);
  if (!m) return null;
  return { providerName: PROVIDER_LABELS_BY_ID[m.providerId] || m.providerId, modelName: m.name };
}

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

/** Resolve a TEXT panel's `{{tokens}}` against the brain blob, reusing the
 *  addon prompt assembler (the template IS the panel's text). */
function resolveText(ctx, panel) {
  const runnable = ctx.runnable;
  const agentFields = Array.isArray(runnable.agent.body?.fields) ? runnable.agent.body.fields : [];
  const crewFields  = Array.isArray(runnable.crew.body?.fields)  ? runnable.crew.body.fields  : [];
  const synthetic = {
    instanceId:     panel.id,
    pluginId:       'profiler-text',
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

/** Turn a resolved text string into a stored panel entry, or null (hide). */
function shapeTextEntry(render, resolved, cfg = {}) {
  if (render === 'text' || render === 'html' || !render) {
    const text = (resolved || '').trim();
    return text ? { render: render || 'text', text, ranAt: Date.now() } : null;
  }
  const { parsed } = parseOutput('json-to-memory', resolved || '');
  const values = validatePanelValues(render, parsed, cfg);
  return values ? { render, values, ranAt: Date.now() } : null;
}

/** Build the synthetic AddonInstance a Profiler AI panel runs as. Same
 *  shape as the Live Brain one, plus the Profiler routing/usage stamps:
 *  `memorySlot` (write target), `usagePrefix`/`usageCrew` (llm_usage). */
function toPromptInstance(panel) {
  const src = panel.source || {};
  return {
    instanceId:     panel.id,
    pluginId:       PROFILER_PLUGIN_ID,
    lane:           'offline',
    enabled:        true,
    config:         {
      name:      panel.title,
      prompt:    src.prompt || '',
      model:     src.model,
      render:    panel.render,
      tagMode:   panel.tags?.mode,
      tagLabels: panel.tags?.labels,
      fieldKeys: panel.fields?.mode === 'generated' ? undefined : panel.fields?.keys,
      // Profiler routing + usage identity (read by the shared plugin).
      memorySlot:  PROFILER_SLOT,
      usagePrefix: 'PF',
      usageCrew:   'profiler',
    },
    context:        { history: src.history || { mode: 'last_n', n: 10 }, ...(panel.filter ? { filter: panel.filter } : {}) },
    outputType:     'json-to-memory',
    promptTemplate: '{{prompt}}',
  };
}

/** Resolve ONE Profiler panel into its render-ready value, or null
 *  (hidden: filter failed, or no valid stored value). Reads the PROFILER
 *  memory slot. Carries `placement` so the client knows header vs body. */
function resolveOnePanel(panel, brain) {
  if (!panel || !panel.id) return null;

  const filter = panel.filter;
  if (filter && Array.isArray(filter.conditions) && filter.conditions.length > 0) {
    const evalResult = evaluateConditions(brain, filter.conditions, { instanceId: panel.id });
    const passes = filter.mode === 'exclude' ? !evalResult.ok : evalResult.ok;
    if (!passes) return null;
  }

  const entry = builderMemory.getPanel(brain, panel.id, PROFILER_SLOT);
  if (!entry) return null;

  return {
    id:        panel.id,
    title:     panel.title,
    render:    entry.render || panel.render,
    placement: panel.placement === 'header' ? 'header' : 'body',
    ...(entry.text   !== undefined ? { text:   entry.text }   : {}),
    ...(entry.values !== undefined ? { values: entry.values } : {}),
    ranAt:     entry.ranAt,
  };
}

function resolveProfilerPanelsForClient(panels, brain) {
  return (panels || []).map(p => resolveOnePanel(p, brain)).filter(Boolean);
}

/** Log a TEXT panel's resolution as a run so the Profiler run inspector
 *  shows a full picture (text panels don't call an LLM). Mirrors the
 *  addon.output shape; tagged `profiler-panel`. */
async function logTextRun(ctx, panel, entry, resolved) {
  const runData = {
    instanceId:   panel.id,
    label:        panel.title || panel.id,
    kind:         'text',
    modelLabel:   null,
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
      instance:       { instanceId: panel.id, pluginId: PROFILER_PLUGIN_ID },
      status:         'success',
      startedAt:      new Date(),
      endedAt:        new Date(),
      durationMs:     0,
      runData,
    });
  } catch (err) {
    console.error('[profilerDispatcher] text run log failed:', err.message);
  }
}

async function dispatchProfilerPanels({ ctx, didTransition }) {
  const { runnable, userId, conversationId, memory, emit } = ctx;
  // Master switch — `enabled:false` skips the whole Profiler (all panels).
  if (runnable.agent.body?.profiler?.enabled === false) return;
  const panels = Array.isArray(runnable.agent.body?.profiler?.panels)
    ? runnable.agent.body.profiler.panels
    : [];
  if (panels.length === 0) return;

  const indexOf = new Map(panels.map((p, i) => [p.id, i]));
  const emitPanel = (panel) => {
    try {
      emit('profiler.panel', {
        panelId: panel.id,
        index:   indexOf.get(panel.id) ?? 0,
        panel:   resolveOnePanel(panel, memory),
      });
    } catch { /* emit is best-effort */ }
  };

  // ── 1. TEXT panels — resolve tokens now, write to the profiler slot. ──
  const textWrites = [];
  const textLogs = [];
  for (const panel of panels) {
    if (!panel || panel.source?.kind !== 'text') continue;
    let entry = null;
    let resolved = '';
    try {
      resolved = resolveText(ctx, panel);
      entry = shapeTextEntry(panel.render, resolved, {
        labels: panel.tags?.labels,
        mode:   panel.tags?.mode,
        keys:   panel.fields?.mode === 'generated' ? undefined : panel.fields?.keys,
      });
    } catch (err) {
      console.error('[profilerDispatcher] text panel resolve failed:', err.message);
    }
    textWrites.push(entry
      ? { kind: 'panel', panelId: panel.id, entry, slot: PROFILER_SLOT }
      : { kind: 'panel', panelId: panel.id, clear: true, slot: PROFILER_SLOT });
    textLogs.push({ panel, entry, resolved });
  }
  if (textWrites.length > 0) {
    builderMemory.applyWrites(memory, textWrites);
    try {
      await builderMemory.saveMemory(userId, conversationId, memory);
    } catch (err) {
      console.error('[profilerDispatcher] text panel memory save failed:', err.message);
    }
    await Promise.all(textLogs.map(t => logTextRun(ctx, t.panel, t.entry, t.resolved)));
    for (const t of textLogs) emitPanel(t.panel);
  }

  // ── 2. AI (prompt) panels — cadence-gated, run via addonRunner. ──
  const promptPanels = panels.filter(p => p?.source?.kind === 'prompt');
  if (promptPanels.length > 0) {
    const state = await offlineTriggerState.load(userId, conversationId);
    const dispatches = [];
    for (const panel of promptPanels) {
      // Namespace the trigger counter so a Profiler panel and a Live
      // Brain panel that happen to share an id never clobber each other.
      const counterKey = `profiler:${panel.id}`;
      const current  = offlineTriggerState.readCounter(state, counterKey);
      const next     = current + 1;
      if (shouldFire(panel.source.trigger, next, didTransition)) {
        offlineTriggerState.writeCounter(state, counterKey, 0);
        dispatches.push(panel);
      } else {
        offlineTriggerState.writeCounter(state, counterKey, next);
      }
    }
    try {
      await offlineTriggerState.save(userId, conversationId, state);
    } catch (err) {
      console.error('[profilerDispatcher] trigger-state save failed:', err.message);
    }

    if (dispatches.length > 0) {
      await Promise.all(dispatches.map(panel =>
        runAddon({ ctx, instance: toPromptInstance(panel), addonStart: Date.now() })
          .then(() => emitPanel(panel))
          .catch(err => {
            console.error('[profilerDispatcher] unexpected throw from runAddon:', err.message);
          }),
      ));
    }
  }
}

/**
 * MANUAL REFRESH — recompute the WHOLE Profiler on demand (the "hard
 * refresh" button), OUTSIDE a chat turn. Builds the same ctx shape the
 * turn assembles (from runnable + memory), then runs EVERY panel now,
 * ignoring cadence triggers. Returns the render-ready panel list.
 *
 * @param {Object} a
 * @param {string} a.agentSlug
 * @param {string} a.ownerUserId  — external owner id (usage logging)
 * @param {number} a.userId       — resolved numeric user id (memory scope)
 * @param {number} a.conversationId
 * @param {string} [a.mode]       — 'active' | 'viewing' | 'published'
 * @param {Function} [a.emit]     — optional SSE emitter (per-panel)
 */
async function refreshProfilerPanels({ agentSlug, ownerUserId, userId, conversationId, mode = 'active', emit = () => {} }) {
  const { resolveRunnable } = require('../services/builderProjects');
  const llm = require('../../services/llm');
  const { logUsage } = require('../../services/usageLogger');
  const db = require('../../services/db.pg');
  const { messages } = require('../../db/schema');
  const { eq, desc } = require('drizzle-orm');

  const runnable = await resolveRunnable({ agentSlug, ownerUserId, mode });
  const panels = Array.isArray(runnable.agent.body?.profiler?.panels)
    ? runnable.agent.body.profiler.panels
    : [];
  const memory = await builderMemory.loadMemory(userId, conversationId);
  if (panels.length === 0) return resolveProfilerPanelsForClient([], memory);

  const drizzle = db.getDrizzle();
  // addon_runs.message_id is NOT NULL + FKs to messages — anchor refresh
  // runs to the latest message in the conversation. No messages yet →
  // nothing to profile; return current state without logging.
  let assistantMessageId = null;
  try {
    const rows = await drizzle.select({ id: messages.id }).from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.id)).limit(1);
    assistantMessageId = rows[0]?.id ?? null;
  } catch { /* best-effort */ }
  if (!assistantMessageId) return resolveProfilerPanelsForClient(panels, memory);

  const agentPersonas = Array.isArray(runnable.agent.body?.personas)
    ? runnable.agent.body.personas
    : (runnable.agent.body?.persona
        ? [{ id: 'persona_main', name: 'main', content: runnable.agent.body.persona, appliesTo: ['*'] }]
        : []);

  const ctx = {
    runnable,
    agentSlug,
    ownerUserId,
    userId,
    conversationId,
    assistantMessageId,
    userMessage:      '',
    crewLabel:        runnable.crew.body?.name || 'crew',
    agentNameForLogs: runnable.agent.body?.name || agentSlug,
    agentPersonas,
    agentParameters:  Array.isArray(runnable.agent.body?.parameters) ? runnable.agent.body.parameters : [],
    agentEnums:       Array.isArray(runnable.agent.body?.enums)      ? runnable.agent.body.enums      : [],
    memory,
    memoryValuesByDomain:   (d) => builderMemory.valuesForDomain(memory, d, 'memory'),
    memoryDomainList:       ()  => builderMemory.listDomainsWithValues(memory, 'memory'),
    thinkingValuesByDomain: (d) => builderMemory.valuesForDomain(memory, d, 'thinking'),
    thinkingDomainList:     ()  => builderMemory.listDomainsWithValues(memory, 'thinking'),
    retrievalValueOf:       (n) => builderMemory.getRetrieval(memory, n),
    fieldValueOf:           (n) => builderMemory.findFieldValue(memory, n, 'memory'),
    drizzle,
    convRow:          null,
    emit,
    llm,
    logUsage,
    resolveModelLabel,
    historyExcludeFromMessageId: undefined,   // offline-style: see the whole convo
  };

  const indexOf = new Map(panels.map((p, i) => [p.id, i]));
  const emitPanel = (panel) => {
    try {
      emit('profiler.panel', { panelId: panel.id, index: indexOf.get(panel.id) ?? 0, panel: resolveOnePanel(panel, memory) });
    } catch { /* best-effort */ }
  };

  // Text panels — resolve + write now.
  const textWrites = [];
  const textLogs = [];
  for (const panel of panels) {
    if (!panel || panel.source?.kind !== 'text') continue;
    let entry = null;
    let resolved = '';
    try {
      resolved = resolveText(ctx, panel);
      entry = shapeTextEntry(panel.render, resolved, {
        labels: panel.tags?.labels,
        mode:   panel.tags?.mode,
        keys:   panel.fields?.mode === 'generated' ? undefined : panel.fields?.keys,
      });
    } catch (err) {
      console.error('[profilerDispatcher] refresh text resolve failed:', err.message);
    }
    textWrites.push(entry
      ? { kind: 'panel', panelId: panel.id, entry, slot: PROFILER_SLOT }
      : { kind: 'panel', panelId: panel.id, clear: true, slot: PROFILER_SLOT });
    textLogs.push({ panel, entry, resolved });
  }
  if (textWrites.length > 0) {
    builderMemory.applyWrites(memory, textWrites);
    await Promise.all(textLogs.map(t => logTextRun(ctx, t.panel, t.entry, t.resolved)));
  }

  // Prompt panels — FORCE-run all (ignore cadence). runAddon writes each
  // panel slot into `memory` and persists.
  const promptPanels = panels.filter(p => p?.source?.kind === 'prompt');
  await Promise.all(promptPanels.map(panel =>
    runAddon({ ctx, instance: toPromptInstance(panel), addonStart: Date.now() })
      .catch(err => console.error('[profilerDispatcher] refresh runAddon failed:', err.message)),
  ));

  try {
    await builderMemory.saveMemory(userId, conversationId, memory);
  } catch (err) {
    console.error('[profilerDispatcher] refresh save failed:', err.message);
  }

  for (const panel of panels) emitPanel(panel);
  return resolveProfilerPanelsForClient(panels, memory);
}

module.exports = {
  dispatchProfilerPanels,
  resolveProfilerPanelsForClient,
  refreshProfilerPanels,
  PROFILER_PLUGIN_ID,
  PROFILER_SLOT,
};
