/**
 * Build with your own AI — Aspect Module, kind 'app' (task #96).
 *
 * Lets a client's people build Intelligence Center apps with THEIR OWN AI
 * coding tool (Claude Code, Codex, any chat that can fetch a URL) instead of
 * with Otto. The tool reads one URL — `/intelligence/<slug>/mcp/<token>` —
 * which teaches it the client's data and the screen-spec format, and hands it
 * a check and a save endpoint. The LYBI `/builder/mcp` door is the model;
 * see docs/features/ai-builder.md.
 *
 * It rides on Otto's engine, not beside it: the same brief, the same spec
 * validator, the same compiler, probes and `custom_modules` store. A screen
 * saved through the door is indistinguishable from one Otto built, so Otto
 * can keep editing it and "Save to Apps" publishes it exactly the same way.
 * That is also why the door requires module `otto` to be live — the brief it
 * serves is Otto's binding.
 *
 * APP module: enabling it IS the installation. The per-client signing secret
 * is created lazily the first time someone asks for their link
 * (otto/services/mcp-token.service.js) and kept as this module's binding.
 */
module.exports = {
  id: 'ai-builder',
  kind: 'app',
  scope: 'dataset',
  name: { en: 'Build with your own AI', he: 'בנייה עם ה-AI שלך' },
  version: 1,

  // Nothing to tune: the models are the client's own, and what the door may
  // touch is fixed by Otto's brief.
  settingsSchema: [],

  notificationEvents: [],
};
