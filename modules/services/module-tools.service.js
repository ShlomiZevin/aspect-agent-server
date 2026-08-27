/**
 * Aspect Modules — attaching a live module's crew tools.
 *
 * Called once per turn from the dispatcher, just before the LLM config is
 * built. Idempotent and reversible: module tools are tagged, removed, and
 * re-added from the current live set on every call, so switching a module off
 * removes its tool from the very next turn rather than at the next restart.
 *
 * NO MODULE ⇒ NOTHING HAPPENS. A crew with no `datasetSchema`, or a dataset
 * with no live module, returns immediately having issued no query and
 * mutated nothing. That is the byte-identical guarantee at the one point the
 * framework reaches into the chat path.
 *
 * WHY MODULE TOOLS ARE STRUCTURED, NEVER SQL: the same question asked five
 * ways, in either language, must return identical numbers. A model writing
 * SQL for "what should I order" cannot do that. The tool takes a supplier and
 * a horizon; the arithmetic is the same pure function the screen and the
 * report use.
 */

const moduleService = require('./module.service');

/** Marks a tool as module-contributed so it can be removed again cleanly. */
const TAG = '__fromModule';

/**
 * @param {object} crew a CrewMember instance
 * @returns {{attached: string[]}} names of the tools now attached
 */
async function attachTo(crew) {
  if (!crew || !crew.datasetSchema || !Array.isArray(crew.tools)) return { attached: [] };

  // Drop anything a previous turn attached BEFORE deciding what to add, so a
  // module switched off between turns leaves nothing behind.
  const had = crew.tools.filter(t => t[TAG]).map(t => t.name);
  if (had.length) crew.tools = crew.tools.filter(t => !t[TAG]);

  let live;
  try {
    live = await moduleService.getLiveModules(crew.datasetSchema);
  } catch (err) {
    // A chat turn must not fail because the module registry was unreachable.
    // Without module tools the crew is exactly what it was before this
    // framework existed, which is a safe place to land.
    console.warn(`[modules] could not resolve tools for ${crew.datasetSchema}: ${err.message}`);
    return { attached: [] };
  }

  const attached = [];
  for (const { descriptor } of live) {
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
      if (crew.tools.some(t => t.name === tool.name)) {
        console.warn(`[modules] ${descriptor.id}: tool '${tool.name}' collides with an existing crew tool — skipped`);
        continue;
      }
      crew.tools.push({ ...tool, [TAG]: descriptor.id });
      attached.push(tool.name);
    }
  }

  if (attached.length || had.length) {
    console.log(`[modules] ${crew.datasetSchema}: module tools = [${attached.join(', ') || 'none'}]`);
  }
  return { attached };
}

module.exports = { attachTo, TAG };
