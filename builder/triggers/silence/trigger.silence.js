/**
 * Silence trigger — "the customer has gone quiet for X".
 *
 * Two authored numbers (`after`, `maxAttempts`); four clauses underneath,
 * of which the author only ever sees two. See
 * docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * THE FOUR CLAUSES
 *
 *   1. quiet long enough    the CUSTOMER's last message is older than `after`
 *   2. spacing              this trigger has no event here in the last `after`
 *   3. under the cap        attempts since the customer last spoke < maxAttempts
 *   4. after switch-on      the customer's last message is after `activeSince`
 *
 * Clauses 1 and 3 are the card. Clauses 2 and 4 are mechanics the author
 * never configures, and both exist because of a specific failure:
 *
 *   Clause 2 — a proactive attempt that stays SILENT sends no message,
 *   so `last_user_message_at` never moves and clause 1 keeps matching on
 *   every single tick. Without this the chain would relaunch every
 *   minute, forever, burning tokens with nothing to show. It reuses
 *   `after` rather than adding a "minimum gap" knob: the spacing between
 *   attempts and the silence threshold are the same duration, so asking
 *   for both would be asking the same question twice.
 *
 *   Clause 4 — without it, switching a trigger on would match every
 *   long-dead conversation in the agent's history and nudge all of them
 *   on the first tick. With it, a trigger only ever reaches conversations
 *   whose customer has spoken since it was enabled. No backfill sweep, no
 *   "only conversations from the last N days" setting, no first-tick
 *   blast.
 *
 * WHY ATTEMPTS AND NOT MESSAGES (clause 3)
 *
 * An earlier design counted messages sent. A crew that deliberately
 * stays silent sends none, so the counter never advanced and the cap
 * never bit — the same runaway clause 2 guards against, one level up.
 * Counting ATTEMPTS bounds a dead conversation at exactly `maxAttempts`
 * chain runs, ever. It also means a crew that stays silent every time
 * shows up as a bug rather than being hidden by an unbounded retry loop.
 */

const descriptor = require('../silence.trigger.json');
const { registerTriggerType } = require('../registry');

const MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };

/** `after` → milliseconds. Defensive: a hand-edited body can carry
 *  anything, and a NaN here would silently match every conversation. */
function afterMs(config) {
  const unit  = MS[config?.after?.unit] ? config.after.unit : 'minutes';
  const value = Number(config?.after?.value);
  const safe  = Number.isFinite(value) && value > 0 ? value : 30;
  return safe * MS[unit];
}

function maxAttempts(config) {
  const n = Number(config?.maxAttempts);
  // No "unlimited": an unbounded cap is the one way to reopen the
  // forever-loop clause 3 exists to close.
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

/** "34 minutes" / "2.5 hours" / "3 days" — the author's own units where
 *  they fit, so the run card reads the way the card was authored. */
function humanizeMs(ms) {
  const mins = ms / MS.minutes;
  if (mins < 90)  return `${Math.round(mins)} minute${Math.round(mins) === 1 ? '' : 's'}`;
  const hours = ms / MS.hours;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0).replace(/\.0$/, '')} hours`;
  const days = ms / MS.days;
  return `${days.toFixed(days < 10 ? 1 : 0).replace(/\.0$/, '')} days`;
}

/**
 * The CHEAP narrowing. Only clauses 1 and 4 — both are plain column
 * comparisons on `conversations` and both ride the
 * (agent_id, last_user_message_at) index from migration 044.
 *
 * Clauses 2 and 3 are deliberately left OUT of the SQL. They need
 * `trigger_events`, and since both can only ever REJECT a candidate,
 * omitting them keeps this a guaranteed superset of `evaluate()` —
 * which is the registry's hard contract. The handful of rows that
 * survive this filter are cheap to evaluate properly.
 */
function candidateSql({ trigger, config, now }) {
  const cutoff = new Date(now.getTime() - afterMs(config));
  return {
    where: `c.last_user_message_at IS NOT NULL
            AND c.last_user_message_at < $CUTOFF
            AND c.last_user_message_at > $ACTIVE_SINCE`,
    params: {
      CUTOFF: cutoff,
      ACTIVE_SINCE: trigger.activeSince ? new Date(trigger.activeSince) : new Date(0),
    },
  };
}

/**
 * AUTHORITATIVE. Pure — reads only `facts`, `config` and `now`.
 *
 * The tick calls this on rows `candidateSql` surfaced. The explainer
 * calls it on facts reconstructed for one conversation at one past
 * moment. Same function, so the two can never disagree about why
 * something did or didn't fire.
 *
 * Every clause reports its actual numbers in `why`, because "did not
 * fire" on its own is useless to an author — "quiet 40 min, needs 30"
 * and "already 3 attempts, max is 3" are different problems with
 * different fixes.
 */
function evaluate({ facts, trigger, config, now }) {
  const clauses = [];
  const windowMs = afterMs(config);
  const cap = maxAttempts(config);

  // ── 1. quiet long enough ──
  const lastUser = facts.lastUserMessageAt ? new Date(facts.lastUserMessageAt) : null;
  if (!lastUser) {
    clauses.push({
      name: 'quiet long enough',
      ok: false,
      why: 'the customer has never sent a message — there is no silence to measure',
    });
  } else {
    const quietMs = now.getTime() - lastUser.getTime();
    clauses.push({
      name: 'quiet long enough',
      ok: quietMs >= windowMs,
      why: `quiet ${humanizeMs(quietMs)}, needs ${humanizeMs(windowMs)}`,
    });
  }

  // ── 2. spacing (mechanics — never shown as a setting) ──
  const lastEvent = facts.lastEventAt ? new Date(facts.lastEventAt) : null;
  if (!lastEvent) {
    clauses.push({ name: 'spacing', ok: true, why: 'no previous attempt on this conversation' });
  } else {
    const sinceMs = now.getTime() - lastEvent.getTime();
    clauses.push({
      name: 'spacing',
      ok: sinceMs >= windowMs,
      why: `last attempt ${humanizeMs(sinceMs)} ago, needs ${humanizeMs(windowMs)}`,
    });
  }

  // ── 3. under the cap ──
  const attempts = Number(facts.attemptsSinceLastUserMessage) || 0;
  clauses.push({
    name: 'under the cap',
    ok: attempts < cap,
    why: attempts < cap
      ? `attempt ${attempts + 1} of ${cap} since they last spoke`
      : `already ${attempts} attempt${attempts === 1 ? '' : 's'} since they last spoke, max is ${cap}`,
  });

  // ── 4. after switch-on (mechanics — displayed, never edited) ──
  const activeSince = trigger.activeSince ? new Date(trigger.activeSince) : new Date(0);
  clauses.push({
    name: 'after switch-on',
    ok: !!lastUser && lastUser.getTime() > activeSince.getTime(),
    why: lastUser
      ? (lastUser.getTime() > activeSince.getTime()
          ? `they spoke after the trigger was switched on (${activeSince.toISOString().slice(0, 16).replace('T', ' ')})`
          : `they last spoke before the trigger was switched on (${activeSince.toISOString().slice(0, 16).replace('T', ' ')}) — this conversation predates it`)
      : 'no customer message to compare against',
  });

  const ok = clauses.every(c => c.ok);
  // The match reason is the first clause's phrasing: it is the one an
  // author thinks in, and it is what lands on the event row and in the
  // chat badge ("⚡ Silence · quiet for 34 minutes").
  const reason = lastUser
    ? `quiet for ${humanizeMs(now.getTime() - lastUser.getTime())}`
    : 'no customer message';

  return { ok, clauses, reason };
}

registerTriggerType({
  typeId: descriptor.typeId,
  descriptor,
  candidateSql,
  evaluate,
});

module.exports = { candidateSql, evaluate, afterMs, humanizeMs, maxAttempts };
