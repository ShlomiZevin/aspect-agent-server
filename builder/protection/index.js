/**
 * Data protection (task #986) — the server's door to the shared detector
 * list (detectors.mjs, the SAME file the browser imports).
 *
 * The list is an ES module so the client can import it as-is; CommonJS
 * code loads it with `import()` (works on the Node 22 container and on a
 * local Node 18, unlike `require` of an ES module). It is loaded once at
 * startup; `load()` resolves to the module.
 *
 * The gate itself is in runtimeRoute POST /:slug/conversations/:id/messages:
 * every customer message from every channel passes there before it is
 * saved or reaches a model.
 */

let mod = null;
const loading = import('./detectors.mjs').then((m) => { mod = m; return m; });
// Never an unhandled rejection at boot (the error center would exit the
// server): a load failure surfaces on the first `load()` call instead.
loading.catch(() => {});

/** The detectors module (cached after the first load). */
async function load() {
  return mod || loading;
}

/**
 * Check one customer message against the agent body and the body of the
 * crew that receives it.
 * @returns {Promise<null | { detectors: string[], message: string }>}
 */
async function checkMessage(text, agentBody, crewBody, lang) {
  const m = await load();
  return m.checkMessage(text, agentBody, crewBody, lang);
}

module.exports = { load, checkMessage };
