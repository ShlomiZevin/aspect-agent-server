/**
 * Builder V2 — plugin index.
 *
 * Requiring this file registers every built-in plugin as a side
 * effect. Order doesn't matter — each plugin file calls
 * `registerPlugin(...)` at load time.
 *
 * Each plugin lives in its own folder under `plugins/<id>/` with an
 * entry file named `addon.<id>.js` (so the filename is self-
 * describing in the IDE — no anonymous `index.js`).
 *
 * To add a new addon:
 *   1. Drop a folder under `aspect-agent-server/builder/plugins/<id>/`.
 *   2. Add `addon.<id>.js` that calls `registerPlugin(...)`.
 *   3. Require it here.
 *   4. Mirror the descriptor on the client (`addon.<id>.ts`).
 *
 * See docs/guides/BUILDER_V2_ADDONS.md for the full contract.
 */

require('./talker/addon.talker');
require('./fieldExtractor/addon.fieldExtractor');
require('./vibeExtractor/addon.vibeExtractor');
require('./fieldReasoner/addon.fieldReasoner');
require('./fieldInterviewer/addon.fieldInterviewer');
require('./thinker/addon.thinker');
require('./transitionRouter/addon.transitionRouter');
