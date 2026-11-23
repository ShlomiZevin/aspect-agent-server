/**
 * What a turn's runtime stream carries, per surface (#1011).
 *
 * The runtime emits the same rich events everywhere: every add-on's full
 * prompt (`addon.prompt`), its raw and parsed output (`addon.output`), the
 * resolved Targeted KB text, the Live Brain / Profiler panels. The Builder
 * chat and the full outside chat (`/<agent>/live`, Debug mode, the embedded
 * widget) render all of it. The login-gated customer chat (`/<agent>/go`)
 * renders only the reply — so those bytes (0.35–1.24 MB a turn) must never
 * leave the server for it.
 *
 * This file is the ONE place that decides it. The runtime POST hands its
 * `emit` through `emitterFor(req.body.surface, emit)`:
 *   - no surface / an unknown one → the very same `emit` (the stream is
 *     byte-identical to before — Builder, /live, embed, simulations);
 *   - a listed surface → only the events and fields in its whitelist.
 *     An event type not listed is not sent at all, so a new runtime event
 *     reaches /go only when someone adds it here on purpose.
 *
 * A field is `true` (sent as is) or a list of the sub-fields to keep.
 */

const SURFACES = {
  // `/<agent>/go` — what LiveChatPage (restricted) + useLiveChat use:
  // the reply tokens, the thinking state, web search pills, the crew
  // pointer and transitions (the data protection check reads them), the
  // protection notice, a fatal error, the end of the turn.
  go: {
    'conversation':       { conversationId: true, messageId: true, currentCrewId: true },
    'protection.blocked': { conversationId: true, blockId: true, detectors: true, message: true },
    'addon.start':        { instanceId: true, pluginId: true, label: true },
    'addon.token':        { instanceId: true, token: true },
    'addon.websearch':    { instanceId: true, id: true, status: true, query: true, kind: true },
    'addon.output':       { instanceId: true, label: true, transition: ['to', 'reason'] },
    'addon.error':        { instanceId: true, error: ['code', 'message'] },
    'assistant.message':  { messageId: true, text: true },
    'turn.stopped':       {},
    'done':               { totalMs: true, outcome: true },
  },
};

/** The surface name if it has a whitelist, else null (= full stream). */
function surfaceOf(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SURFACES, value) ? value : null;
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** One event trimmed for a surface — null when the surface doesn't get it. */
function filterEvent(surface, type, payload) {
  const allowed = SURFACES[surface] && SURFACES[surface][type];
  if (!allowed) return null;
  const out = {};
  for (const [field, rule] of Object.entries(allowed)) {
    if (!payload || payload[field] === undefined) continue;
    out[field] = rule === true ? payload[field] : pick(payload[field], rule);
  }
  return out;
}

/** The emitter a runtime stream should use for `surface` (see top). */
function emitterFor(surface, emit) {
  const s = surfaceOf(surface);
  if (!s) return emit;
  return (type, payload) => {
    const trimmed = filterEvent(s, type, payload);
    if (trimmed) return emit(type, trimmed);
    return undefined;
  };
}

module.exports = { emitterFor, filterEvent, surfaceOf, SURFACES };
