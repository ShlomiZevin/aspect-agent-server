/**
 * Aspect Modules — attaching a live module's crew tools, plain or SCOPED.
 *
 * Called once per turn from the dispatcher, just before the LLM config is
 * built. Idempotent and reversible: the crew's own (untagged) tool list is
 * snapshotted on first touch and the turn's tool set is RECONSTRUCTED from it
 * on every call, so switching a module off — or leaving a scoped conversation
 * — restores the plain set on the very next turn rather than at a restart.
 *
 * TWO MODES:
 *
 *   plain turn   — crew.tools = own tools + every live module's chatTools().
 *                  Exactly the behavior this file always had.
 *
 *   scoped turn  — the request carried moduleScope {moduleId, scopeId,
 *                  context} (Smart Tune). If that module is LIVE and its
 *                  descriptor's chatScopes() knows the scopeId, the tool set
 *                  becomes the SCOPE'S TOOLS ONLY — isolation by construction:
 *                  the dataset's general tools are simply not attached — and
 *                  the scope's prompt fragment is returned for the dispatcher
 *                  to inject. Anything invalid (unknown module, unknown scope,
 *                  module switched off mid-conversation) degrades to a plain
 *                  turn with `refused` set: a stale panel gets ordinary
 *                  answers and a clear signal, never a crash.
 *
 * NO MODULE ⇒ NOTHING HAPPENS. A crew with no `datasetSchema`, or a dataset
 * with no live module, keeps its own tools untouched. That is the
 * byte-identical guarantee at the one point the framework reaches into the
 * chat path.
 *
 * WHY MODULE TOOLS ARE STRUCTURED, NEVER SQL: the same question asked five
 * ways, in either language, must return identical numbers. A model writing
 * SQL for "what should I order" cannot do that. The tools take structured
 * scope; the arithmetic is the same pure function the screen and the report
 * use.
 */

const moduleService = require('./module.service');
const registry = require('../registry');

/** Marks a tool as module-contributed so it can be removed again cleanly. */
const TAG = '__fromModule';
/** Where the crew's own pre-framework tool list is snapshotted. A plain
 *  string (not a Symbol) so the offline battery can inspect it. */
const OWN = '__ownTools';

/**
 * @param {object} crew a CrewMember instance
 * @param {object|null} moduleScope {moduleId, scopeId, context} or null
 * @param {object} turn  {conversationId} — handed to scope tools that need it
 * @returns {{attached: string[], scoped: boolean, fragment?: string, refused?: string}}
 */
async function attachTo(crew, moduleScope = null, turn = {}) {
  if (!crew || !crew.datasetSchema || !Array.isArray(crew.tools)) {
    return { attached: [], scoped: false };
  }

  // Snapshot before this framework ever touches the list. Reconstructing from
  // it (instead of filtering in place) means a scoped turn that removed the
  // crew's own tools cannot leak that removal into the next plain turn.
  if (!crew[OWN]) crew[OWN] = crew.tools.filter(t => !t[TAG]);
  const own = crew[OWN];

  let live;
  try {
    live = await moduleService.getLiveModules(crew.datasetSchema);
  } catch (err) {
    // A chat turn must not fail because the module registry was unreachable.
    // With only its own tools the crew is exactly what it was before this
    // framework existed, which is a safe place to land.
    console.warn(`[modules] could not resolve tools for ${crew.datasetSchema}: ${err.message}`);
    crew.tools = [...own];
    return { attached: [], scoped: false };
  }

  // ── scoped turn (Smart Tune) ──
  if (moduleScope && moduleScope.moduleId && moduleScope.scopeId) {
    const entry = live.find(x => x.descriptor.id === moduleScope.moduleId);
    const scopes = entry && registry.runsHooks(entry.descriptor)
      && typeof entry.descriptor.hooks.chatScopes === 'function'
      ? (entry.descriptor.hooks.chatScopes({ datasetId: crew.datasetSchema }) || [])
      : [];
    const scopeDef = scopes.find(s => s.scopeId === moduleScope.scopeId);

    if (!entry || !scopeDef) {
      crew.tools = [...own];
      console.warn(`[modules] ${crew.datasetSchema}: scoped turn refused — `
        + `${moduleScope.moduleId}/${moduleScope.scopeId} is not a live scope`);
      return { attached: [], scoped: false, refused: 'scope_unavailable' };
    }

    let tools = [];
    try {
      tools = scopeDef.tools({
        datasetId: crew.datasetSchema,
        context: moduleScope.context || {},
        settings: entry.row?.settings || {},
        conversationId: turn.conversationId || null,
      }) || [];
    } catch (err) {
      console.warn(`[modules] ${entry.descriptor.id}/${scopeDef.scopeId}: scope tools threw — ${err.message}`);
      crew.tools = [...own];
      return { attached: [], scoped: false, refused: 'scope_tools_failed' };
    }

    crew.tools = tools.map(t => ({ ...t, [TAG]: entry.descriptor.id }));
    const fragment = typeof scopeDef.promptFragment === 'function'
      ? scopeDef.promptFragment(moduleScope.context || {})
      : (scopeDef.promptFragment || '');
    console.log(`[modules] ${crew.datasetSchema}: SCOPED turn `
      + `${entry.descriptor.id}/${scopeDef.scopeId} — tools = [${tools.map(t => t.name).join(', ')}]`);
    return { attached: tools.map(t => t.name), scoped: true, fragment };
  }

  // ── plain turn: own tools + module contributions ──
  const attached = [];
  const moduleTools = [];
  for (const { descriptor } of live) {
    // An app module has no hooks at all, by design — the task board must not
    // put internal notes in front of a client's chat agent. Reaching for
    // `descriptor.hooks.chatTools` on one threw a TypeError that the catch
    // below swallowed into "chatTools threw", once per chat turn, for every
    // client that had the board switched on. Nothing broke; the log just
    // reported a healthy module as failing, forever.
    if (!registry.runsHooks(descriptor)) continue;

    let tools = [];
    try {
      tools = descriptor.hooks.chatTools({ datasetId: crew.datasetSchema }) || [];
    } catch (err) {
      console.warn(`[modules] ${descriptor.id}: chatTools threw — ${err.message}`);
      continue;
    }
    for (const tool of tools) {
      // A module must never shadow a tool the crew already owns; the crew's
      // own tool is the one the prompt was written around.
      if (own.some(t => t.name === tool.name) || moduleTools.some(t => t.name === tool.name)) {
        console.warn(`[modules] ${descriptor.id}: tool '${tool.name}' collides with an existing crew tool — skipped`);
        continue;
      }
      moduleTools.push({ ...tool, [TAG]: descriptor.id });
      attached.push(tool.name);
    }
  }

  crew.tools = [...own, ...moduleTools];
  if (attached.length) {
    console.log(`[modules] ${crew.datasetSchema}: module tools = [${attached.join(', ')}]`);
  }
  return { attached, scoped: false };
}

module.exports = { attachTo, TAG, OWN };
