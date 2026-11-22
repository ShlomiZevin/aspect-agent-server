/**
 * userSuspension — is a user suspended right now? (tasks #909, #1002)
 *
 * ── Where it lives ─────────────────────────────────────────────────
 *
 *   users.metadata.suspendedAt   ISO time an admin suspended the user (#909)
 *   users.metadata.autoSuspendAt ISO time the user is suspended by itself —
 *                                the "Auto-suspend after 24 h / 48 h" an
 *                                admin picks in Admin → Users → Add user (#1002)
 *
 * In the existing jsonb, no column, no migration.
 *
 * ── Decided when it is READ ────────────────────────────────────────
 *
 * Nothing is written when the auto-suspend time passes: every reader asks
 * `suspensionOf(metadata)` and gets the state as of now. So the limit is
 * enforced to the minute with no scheduler (staging's is off on purpose),
 * and the lists, the runtime and the MCP can never disagree.
 *
 * Writes (services/admin.service.js): suspend now sets `suspendedAt` and
 * drops `autoSuspendAt` (moot); reactivate drops BOTH — otherwise a user
 * whose limit ran out would be suspended again the moment they were
 * reactivated; "turn off" drops `autoSuspendAt` only.
 */

/** A valid time from a metadata value, or null. */
function timeOf(v) {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t;
}

/**
 * The user's suspension as of `now`.
 * @param {object|null} metadata  users.metadata
 * @param {Date} [now]
 * @returns {{ suspended: boolean, suspendedAt: string|null, autoSuspendAt: string|null, auto: boolean }}
 *   suspended     — can't chat right now
 *   suspendedAt   — since when (the auto time when the limit did it)
 *   autoSuspendAt — a limit that is still ahead (null once it has passed or when off)
 *   auto          — suspended by the limit, not by hand
 */
function suspensionOf(metadata, now = new Date()) {
  const m = metadata || {};
  const manual = timeOf(m.suspendedAt);
  const auto = timeOf(m.autoSuspendAt);
  if (manual) return { suspended: true, suspendedAt: manual.toISOString(), autoSuspendAt: null, auto: false };
  if (auto && auto.getTime() <= now.getTime()) return { suspended: true, suspendedAt: auto.toISOString(), autoSuspendAt: null, auto: true };
  return { suspended: false, suspendedAt: null, autoSuspendAt: auto ? auto.toISOString() : null, auto: false };
}

/** The auto-suspend choices Add user offers (hours). */
const AUTO_SUSPEND_HOURS = [24, 48];

module.exports = { suspensionOf, AUTO_SUSPEND_HOURS };
