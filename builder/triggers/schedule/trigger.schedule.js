/**
 * Schedule trigger — "at set times": every Sun–Thu at 09:00, or once on
 * 15 Dec at 09:00. See docs/guides/BUILDER_V2_TRIGGERS.md, "Trigger type
 * #2 — Schedule". The wall-clock arithmetic (days, times, DST) lives in
 * `scheduleSlots.js`; this file turns it into clauses.
 *
 * THE CLAUSES
 *
 *   1. slot due              the latest scheduled slot is at most GRACE old
 *   2. once per slot         this trigger has no event here since that slot
 *   3. existed at the slot   the conversation was created at or before it
 *   4. after switch-on       the slot is not older than `activeSince`
 *   5. customer has spoken   at least one customer message, ever
 *   6. not a simulation      `metadata.kind` is not 'simulation'
 *
 * Clause 1 is the card. The rest are mechanics, each closing one failure:
 *
 *   1 (the grace window) — a paused clock, a dead copy or a long backlog
 *   must never turn into a burst of old messages. A slot older than
 *   GRACE_MINUTES is skipped, not sent late. 60 minutes, because one
 *   sweep acts on at most 25 conversations (MAX_FIRES_PER_SWEEP) and a
 *   tick runs once a minute, so a slot needs real time to reach a few
 *   hundred people; and a 09:00 "good morning" that lands by 10:00 is
 *   still that morning's message, while one at 11:30 is not.
 *
 *   2 — the correctness guard. The event log is the state, exactly as
 *   for Silence: once a conversation has ANY event at or after the slot
 *   (spoke, silent, filtered, quiet_hours, error) the slot is used up.
 *   The dispatcher additionally claims the slot atomically (`claimSince`
 *   → an advisory-locked insert) so two sweeps racing — two Cloud Run
 *   copies, the clock plus Run now — cannot both open an event.
 *
 *   3 — a conversation born at 09:20 is not owed the 09:00 slot.
 *
 *   4 — switching a trigger on at 09:30 must not send the 09:00 slot to
 *   everyone half an hour late.
 *
 *   5 — a conversation where the customer never wrote is a page someone
 *   opened and left; there is nothing to talk to.
 *
 *   6 — simulations are tests started by outside AIs through the Builder
 *   MCP, often hundreds of them. A broadcast must not spend a model call
 *   on each, every slot. (They can still be fired by hand — Run it now
 *   and the MCP's own tools name their conversation.)
 *
 * A slot inside QUIET HOURS is skipped, not delayed: the dispatcher
 * writes a `quiet_hours` event, which uses the slot up (clause 2). That
 * is deliberate — "hold until the window opens" would be a late send.
 */

const descriptor = require('../schedule.trigger.json');
const { registerTriggerType } = require('../registry');
const slots = require('./scheduleSlots');

const MIN = 60 * 1000;
const GRACE_MINUTES = Number(descriptor.limits?.graceMinutes) || 60;
const GRACE_MS = GRACE_MINUTES * MIN;

function humanizeMs(ms) {
  const mins = Math.max(0, ms) / MIN;
  if (mins < 1)   return 'less than a minute';
  if (mins < 90)  return `${Math.round(mins)} minute${Math.round(mins) === 1 ? '' : 's'}`;
  const hours = mins / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0).replace(/\.0$/, '')} hours`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0).replace(/\.0$/, '')} days`;
}

function nextLabel(s, nowMs) {
  const next = slots.nextSlot(s, nowMs);
  return next ? `next: ${slots.slotLabel(next)}` : 'no more scheduled times';
}

/**
 * The slot this moment belongs to, if any is still sendable.
 * `null` when no slot has passed, or the latest one is past the grace
 * window, or the schedule cannot be used.
 */
function currentSlot({ trigger, config, now }) {
  const s = slots.normalizeSchedule(config);
  const slot = slots.latestSlot(s, now.getTime());
  if (!slot || now.getTime() - slot.at > GRACE_MS) return null;
  const activeSince = trigger.activeSince ? new Date(trigger.activeSince).getTime() : 0;
  if (slot.at < activeSince) return null;
  return slot;
}

/**
 * The CHEAP narrowing. Every clause is here as plain SQL, so the
 * candidates are exactly the conversations `evaluate` would accept —
 * which matters more for this type than for Silence: a slot addresses
 * the whole agent at once, and if handled conversations stayed in the
 * candidate list they would fill `findDue`'s row limit and starve the
 * rest. Clause 2 is therefore a NOT EXISTS on the event log.
 *
 * No slot due → `FALSE`: the tick costs one trivial query.
 */
function candidateSql({ trigger, config, now }) {
  const slot = currentSlot({ trigger, config, now });
  if (!slot) return { where: 'FALSE', params: {} };
  return {
    // conversations.created_at is a NAIVE timestamp holding UTC
    // wall-clock (see decision 16), hence AT TIME ZONE 'UTC' before it
    // is compared with a real instant.
    where: `(c.created_at AT TIME ZONE 'UTC') <= $SLOT_AT::timestamptz
            AND c.last_user_message_at IS NOT NULL
            AND COALESCE(c.metadata->>'kind', '') <> 'simulation'
            AND NOT EXISTS (
              SELECT 1 FROM trigger_events e
               WHERE e.conversation_id = c.id
                 AND e.trigger_id = $TRIGGER_ID
                 AND e.matched_at >= $SLOT_AT::timestamptz)`,
    params: { SLOT_AT: new Date(slot.at), TRIGGER_ID: String(trigger.id) },
  };
}

/**
 * AUTHORITATIVE. Pure — reads only `facts`, `config` and `now`, so the
 * tick, Check, the dry run and the explainer cannot disagree.
 */
function evaluate({ facts, trigger, config, now }) {
  const s = slots.normalizeSchedule(config);
  const nowMs = now.getTime();
  const clauses = [];

  if (s.problems.length) {
    clauses.push({ name: 'schedule set', ok: false, why: `the schedule cannot run: ${s.problems.join('; ')}` });
    return { ok: false, clauses, reason: 'schedule not set' };
  }

  // ── 1. slot due ──
  const slot = slots.latestSlot(s, nowMs);
  if (!slot) {
    const next = slots.nextSlot(s, nowMs);
    clauses.push({
      name: 'slot due',
      ok: false,
      why: next
        ? `no scheduled time has come yet — next: ${slots.slotLabel(next)} (${s.timezone})`
        : 'no scheduled time left — the schedule has ended',
    });
    return { ok: false, clauses, reason: 'no slot due' };
  }
  const age = nowMs - slot.at;
  const label = slots.slotLabel(slot);
  clauses.push({
    name: 'slot due',
    ok: age <= GRACE_MS,
    why: age <= GRACE_MS
      ? `the ${label} slot (${s.timezone}) began ${humanizeMs(age)} ago — inside the ${GRACE_MINUTES}-minute window`
      : `the last slot, ${label}, was ${humanizeMs(age)} ago — later than ${GRACE_MINUTES} minutes, so it is skipped, never sent late (${nextLabel(s, nowMs)})`,
  });

  // ── 2. once per slot ──
  const lastEvent = facts.lastEventAt ? new Date(facts.lastEventAt).getTime() : null;
  const handled = lastEvent !== null && lastEvent >= slot.at;
  clauses.push({
    name: 'once per slot',
    ok: !handled,
    why: handled
      ? `already tried here at ${slots.wallTime(lastEvent, s.timezone)} for the ${label} slot`
      : 'not tried here yet for this slot',
  });

  // ── 3. existed at the slot ──
  const created = facts.createdAt ? new Date(facts.createdAt).getTime() : null;
  const existed = created !== null && created <= slot.at;
  clauses.push({
    name: 'existed at the slot',
    ok: existed,
    why: created === null
      ? 'the conversation has no start time'
      : existed
        ? 'the conversation started before the slot'
        : `the conversation started ${slots.instantLabel(created, s.timezone)}, after the ${label} slot — it joins from the next one`,
  });

  // ── 4. after switch-on ──
  const activeSince = trigger.activeSince ? new Date(trigger.activeSince).getTime() : 0;
  clauses.push({
    name: 'after switch-on',
    ok: slot.at >= activeSince,
    why: slot.at >= activeSince
      ? 'the slot came after the trigger was switched on'
      : `the slot came before the trigger was switched on (${slots.instantLabel(activeSince, s.timezone)}) — it only sends from the next one`,
  });

  // ── 5. customer has spoken ──
  clauses.push({
    name: 'customer has spoken',
    ok: !!facts.lastUserMessageAt,
    why: facts.lastUserMessageAt
      ? 'the customer has written at least once'
      : 'the customer never wrote in this conversation',
  });

  // ── 6. not a simulation ──
  const sim = facts.surface === 'simulation';
  clauses.push({
    name: 'not a simulation',
    ok: !sim,
    why: sim ? 'a simulated conversation — schedules skip them' : 'a real conversation',
  });

  return {
    ok: clauses.every(c => c.ok),
    clauses,
    // What lands on the event row and the chat badge:
    // "⚡ Schedule · scheduled for Sun 10 Nov 09:00".
    reason: `scheduled for ${label}`,
  };
}

/**
 * The atomic claim. An event at or after this instant means the
 * conversation already had its try for the current slot; the dispatcher
 * opens the new event only if none exists, under a lock.
 */
function claimSince({ trigger, config, now }) {
  const slot = currentSlot({ trigger, config, now });
  return slot ? new Date(slot.at) : null;
}

/** The next slot after `now` — the card's "next:" line. */
function nextFire({ config, now }) {
  const s = slots.normalizeSchedule(config);
  const next = slots.nextSlot(s, now.getTime());
  return next ? new Date(next.at) : null;
}

/**
 * The status line when a sweep acts on nobody. Without it every empty
 * sweep of a schedule would read "nobody was quiet enough", which is
 * Silence's sentence and wrong here.
 */
function describeZero({ blocked, trigger, config, now }) {
  const s = slots.normalizeSchedule(config);
  if (s.problems.length) return `schedule not set: ${s.problems.join('; ')}`;
  const entries = Object.entries(blocked || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    const slot = currentSlot({ trigger, config, now });
    return slot
      ? `${slots.slotLabel(slot)} — everyone already had this slot`
      : `no slot due · ${nextLabel(s, now.getTime())}`;
  }
  const [name, n] = entries[0];
  const conv = `${n} conversation${n === 1 ? '' : 's'}`;
  if (name === 'once per slot')       return `${conv} already had this slot`;
  if (name === 'existed at the slot') return `${conv} started after this slot`;
  if (name === 'message cap')         return `${conv} already at the message cap for this window`;
  return `${conv} blocked by "${name}"`;
}

registerTriggerType({
  typeId: descriptor.typeId,
  descriptor,
  candidateSql,
  evaluate,
  claimSince,
  nextFire,
  describeZero,
});

module.exports = { candidateSql, evaluate, claimSince, nextFire, describeZero, GRACE_MINUTES };
