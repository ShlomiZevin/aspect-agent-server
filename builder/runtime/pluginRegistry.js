/**
 * Builder V2 — server plugin registry.
 *
 * Mirrors the client's plugin pattern: each addon is a self-contained
 * descriptor that knows how to call its LLM and shape its output.
 * The engine (BuilderRunner) is plugin-agnostic — it dispatches to
 * the right descriptor based on `instance.pluginId`.
 *
 * Adding a new addon = drop a new file under `builder/plugins/<id>/`,
 * `require` it from `builder/plugins/index.js`. The file calls
 * `registerPlugin(descriptor)` as a side effect of loading.
 *
 * Contract documented in: docs/guides/BUILDER_V2_ADDONS.md
 */

const _byId = new Map();

/**
 * Register a plugin descriptor. Last write wins (per-id); module-load
 * order determines which descriptor is active when the same id is
 * registered twice — useful for ad-hoc overrides in tests.
 *
 * @param {object} descriptor
 *   {
 *     id: string,
 *     allowedOutputTypes: string[],
 *     async run(ctx) → { assistantText?, rawOutput, parsedOutput?,
 *                        memoryWrites[], parseError?, durationMs, tokens }
 *   }
 */
function registerPlugin(descriptor) {
  if (!descriptor || typeof descriptor.id !== 'string') {
    throw new Error('registerPlugin: descriptor must have an id');
  }
  if (typeof descriptor.run !== 'function') {
    throw new Error(`registerPlugin("${descriptor.id}"): run() is required`);
  }
  _byId.set(descriptor.id, descriptor);
}

/**
 * Look up a registered plugin by id. Throws if not found — the
 * engine should never receive an instance referencing an unregistered
 * pluginId at runtime; a stale crew body is a config error worth
 * surfacing.
 */
function getPlugin(pluginId) {
  const p = _byId.get(pluginId);
  if (!p) {
    throw new Error(
      `Unknown pluginId "${pluginId}". Either it's not registered yet ` +
      `(check builder/plugins/index.js) or the crew body references a ` +
      `plugin that's been removed.`,
    );
  }
  return p;
}

function listPluginIds() {
  return Array.from(_byId.keys());
}

module.exports = { registerPlugin, getPlugin, listPluginIds };
