/**
 * test-triggers.js — the trigger rules' arithmetic (Silence, Schedule), checked offline.
 *
 * Pure functions against synthetic facts. No database, no LLM, nothing
 * to clean up, instant. This is where the rules actually live, so this
 * is where the assertions are: "up to N counts attempts, not messages",
 * the spacing clause that stops a silent attempt re-firing every tick,
 * and the switch-on clause that makes backfill impossible.
 *
 * There is deliberately NO end-to-end half. An earlier version had one,
 * and it drove `sweepTrigger` — which is agent-wide by design — so it
 * nudged three real customer conversations that happened to belong to
 * the same agent. Real behaviour is verified through the builder UI
 * instead; the code path a single conversation needs is `fireOne`,
 * which can only ever touch the id it is handed.
 *
 * PART C (#968) — real customers only: the "real customer" envelope
 * clause for both types, gate 1's SQL shape, the explainer / Check /
 * findDue paths against a FAKE `db.query` (nothing connects), and the
 * mark a new conversation is born with.
 *
 * PART D (#968 follow-up) — a write built from a STALE metadata copy no
 * longer reverts the mark (real writers against a fake drizzle that
 * applies what they send), every turn-path writer merges, and the status
 * line counts the test conversations a sweep skipped (fake db.query).
 *
 * Usage:  node scripts/test-triggers.js
 *         (safest: DB_HOST=127.0.0.255 node scripts/test-triggers.js —
 *          any accidental connection then fails instead of reaching a DB)
 * Writes: verification/triggers/results.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const silence = require('../builder/triggers/silence/trigger.silence');
const triggerEvaluator = require('../builder/runtime/triggerEvaluator');

// Only ever a crew id to put in a synthetic trigger — nothing here
// reaches the database or a model, so there is no unsafe mode to guard.
const CREW_ID = 'crew_placeholder';

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const MIN = 60 * 1000;
const NOW = new Date('2026-08-31T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

/** A trigger switched on long ago, so clause 4 is satisfied by default. */
function trig(overrides = {}) {
  return {
    id: 'trg_test',
    typeId: 'silence',
    enabled: true,
    activeSince: '2026-01-01T00:00:00Z',
    config: { after: { value: 30, unit: 'minutes' }, maxAttempts: 3 },
    run: { crewId: CREW_ID },
    ...overrides,
  };
}

function facts(overrides = {}) {
  return {
    conversationId: 1,
    lastUserMessageAt: ago(40 * MIN),
    lastMessageAt: ago(40 * MIN),
    lastEventAt: null,
    attemptsSinceLastUserMessage: 0,
    createdAt: ago(24 * 60 * MIN),
    ...overrides,
  };
}

function evalWith(f, t = trig()) {
  return silence.evaluate({ facts: f, trigger: t, config: t.config, now: NOW });
}

function clause(result, name) {
  return result.clauses.find(c => c.name === name);
}

// ────────────────────────────────────────────────────────────────────
// PART A — the clause arithmetic
// ────────────────────────────────────────────────────────────────────
function partA() {
  console.log('\nPART A — clause arithmetic (offline)\n');

  console.log('[1] quiet long enough');
  check('fires once past the threshold', evalWith(facts()).ok,
    evalWith(facts()).reason);
  check('does not fire before the threshold', !evalWith(facts({ lastUserMessageAt: ago(20 * MIN) })).ok,
    clause(evalWith(facts({ lastUserMessageAt: ago(20 * MIN) })), 'quiet long enough').why);
  check('a customer who never spoke has no silence to measure',
    !evalWith(facts({ lastUserMessageAt: null })).ok,
    clause(evalWith(facts({ lastUserMessageAt: null })), 'quiet long enough').why);
  check('the reason reads in the author\'s units',
    /quiet for 40 minutes/.test(evalWith(facts()).reason), evalWith(facts()).reason);

  console.log('\n[2] spacing — the clause that stops a silent attempt looping');
  check('an attempt inside the window blocks the next one',
    !evalWith(facts({ lastEventAt: ago(5 * MIN) })).ok,
    clause(evalWith(facts({ lastEventAt: ago(5 * MIN) })), 'spacing').why);
  check('an attempt older than the window does not block',
    evalWith(facts({ lastEventAt: ago(31 * MIN) })).ok,
    clause(evalWith(facts({ lastEventAt: ago(31 * MIN) })), 'spacing').why);
  // The regression this clause exists for: a SILENT attempt sends no
  // message, so the customer clock never moves and clause 1 keeps
  // matching. Without spacing this would fire on every tick forever.
  check('a silent attempt one minute ago does NOT re-fire (the forever-loop guard)',
    !evalWith(facts({ lastUserMessageAt: ago(3 * 24 * 60 * MIN), lastEventAt: ago(1 * MIN) })).ok,
    'quiet 3 days, but attempted 1 minute ago');

  console.log('\n[3] under the cap — attempts, not messages');
  check('attempt 3 of 3 still fires', evalWith(facts({ attemptsSinceLastUserMessage: 2 })).ok,
    clause(evalWith(facts({ attemptsSinceLastUserMessage: 2 })), 'under the cap').why);
  check('attempt 4 of 3 does not', !evalWith(facts({ attemptsSinceLastUserMessage: 3 })).ok,
    clause(evalWith(facts({ attemptsSinceLastUserMessage: 3 })), 'under the cap').why);
  // The counter is "since the customer last spoke", so a reply resets
  // it — that is the whole nudge-sequence model.
  check('a customer reply resets the sequence',
    evalWith(facts({ attemptsSinceLastUserMessage: 0, lastEventAt: ago(90 * MIN) })).ok,
    'they answered, so the count starts again');
  check('a missing maxAttempts falls back to 3, never unlimited',
    !evalWith(facts({ attemptsSinceLastUserMessage: 3 }), trig({ config: { after: { value: 30, unit: 'minutes' } } })).ok,
    'an unbounded cap is the one way to reopen the forever-loop');

  console.log('\n[4] after switch-on — no backfill, ever');
  const oldConv = facts({ lastUserMessageAt: new Date('2026-06-01T00:00:00Z') });
  const newTrigger = trig({ activeSince: '2026-08-30T00:00:00Z' });
  check('a conversation that went quiet BEFORE switch-on is never touched',
    !evalWith(oldConv, newTrigger).ok,
    clause(evalWith(oldConv, newTrigger), 'after switch-on').why);
  check('a conversation active since switch-on is fair game',
    evalWith(facts(), newTrigger).ok);

  console.log('\n[5] config robustness — a hand-edited body must not match everything');
  for (const [label, bad] of [
    ['missing after',   { maxAttempts: 3 }],
    ['zero value',      { after: { value: 0, unit: 'minutes' }, maxAttempts: 3 }],
    ['garbage unit',    { after: { value: 30, unit: 'fortnights' }, maxAttempts: 3 }],
    ['negative value',  { after: { value: -5, unit: 'hours' }, maxAttempts: 3 }],
  ]) {
    const t = trig({ config: bad });
    const tooRecent = facts({ lastUserMessageAt: ago(1 * MIN) });
    check(`${label} → still refuses a 1-minute-old message`,
      !silence.evaluate({ facts: tooRecent, trigger: t, config: bad, now: NOW }).ok,
      'falls back to the 30-minute default rather than matching everything');
  }

  console.log('\n[6] units');
  const days = trig({ config: { after: { value: 3, unit: 'days' }, maxAttempts: 2 } });
  check('3 days: a 2-day silence does not fire',
    !evalWith(facts({ lastUserMessageAt: ago(2 * 24 * 60 * MIN) }), days).ok);
  check('3 days: a 4-day silence fires',
    evalWith(facts({ lastUserMessageAt: ago(4 * 24 * 60 * MIN) }), days).ok,
    evalWith(facts({ lastUserMessageAt: ago(4 * 24 * 60 * MIN) }), days).reason);

  console.log('\n[7] quiet hours');
  const qh = { from: '22:00', to: '08:00', timezone: 'Asia/Jerusalem' };
  check('inside a midnight-wrapping window → suppressed',
    triggerEvaluator.checkQuietHours(qh, new Date('2026-08-31T02:00:00Z')).suppressed);
  check('outside it → allowed',
    !triggerEvaluator.checkQuietHours(qh, new Date('2026-08-31T12:00:00Z')).suppressed);
  check('a same-day window works too',
    triggerEvaluator.checkQuietHours({ from: '09:00', to: '17:00', timezone: 'UTC' }, new Date('2026-08-31T12:00:00Z')).suppressed);
  check('an unknown timezone fails OPEN and says so',
    !triggerEvaluator.checkQuietHours({ from: '22:00', to: '08:00', timezone: 'Nowhere/Void' }, NOW).suppressed,
    'a typo in a timezone must not silently mute every nudge');
  check('no quiet hours configured → never suppressed',
    !triggerEvaluator.checkQuietHours(undefined, NOW).suppressed);

  console.log('\n[8] every clause explains itself with real numbers');
  const failing = evalWith(facts({ attemptsSinceLastUserMessage: 3 }));
  check('a failing clause names the actual figures',
    /already 3 attempts/.test(clause(failing, 'under the cap').why),
    clause(failing, 'under the cap').why);
  check('all four clauses are always reported, pass or fail',
    failing.clauses.length === 4,
    failing.clauses.map(c => `${c.ok ? '✓' : '✗'} ${c.name}`).join(' · '));
}

// ────────────────────────────────────────────────────────────────────
// PART B — the Schedule type (#950): slots, grace, once-per-slot, DST
// ────────────────────────────────────────────────────────────────────
//
// Times below are UTC instants; the comments give Jerusalem wall time.
// Israel is UTC+2 in winter, UTC+3 in summer. 2026-11-09 is a Monday.
async function partB() {
  console.log('\nPART B — Schedule (offline)\n');
  const slots = require('../builder/triggers/schedule/scheduleSlots');
  const T = (iso) => new Date(iso);

  function strig(config, overrides = {}) {
    return {
      id: 'trg_sched', typeId: 'schedule', enabled: true,
      activeSince: '2026-01-01T00:00:00Z',
      config: { repeat: 'weekly', days: [0, 1, 2, 3, 4], times: ['09:00'], timezone: 'Asia/Jerusalem', ...config },
      run: { crewId: CREW_ID },
      ...overrides,
    };
  }
  function sfacts(overrides = {}) {
    return {
      conversationId: 7,
      lastUserMessageAt: T('2026-11-01T10:00:00Z'),
      lastMessageAt: T('2026-11-01T10:00:00Z'),
      lastEventAt: null,
      attemptsSinceLastUserMessage: 0,
      createdAt: T('2026-11-01T09:00:00Z'),
      deliveredAt: [],
      surface: 'live',
      audience: 'real',
      ...overrides,
    };
  }
  const ev = (t, f, now) => schedule.evaluate({ facts: f, trigger: t, config: t.config, now });
  const evAll = (t, f, now) => triggerEvaluator.evaluateAll({ type: { evaluate: schedule.evaluate }, facts: f, trigger: t, now });
  const cl = (r, name) => (r.clauses.find(c => c.name === name) || { ok: null, why: '(absent)' });
  const nextOf = (t, now) => { const n = schedule.nextFire({ trigger: t, config: t.config, now }); return n ? n.toISOString() : null; };

  console.log('[B1] days and times');
  const sunThu = strig({});
  const monAt0910 = T('2026-11-09T07:10:00Z');                    // Mon 09:10
  check('Sun–Thu 09:00: due on Monday at 09:10', ev(sunThu, sfacts(), monAt0910).ok, ev(sunThu, sfacts(), monAt0910).reason);
  check('the reason names the slot in local time', ev(sunThu, sfacts(), monAt0910).reason === 'scheduled for Mon 9 Nov 09:00', ev(sunThu, sfacts(), monAt0910).reason);
  check('not due at 08:59 (the slot has not come)', !ev(sunThu, sfacts(), T('2026-11-09T06:59:00Z')).ok,
    cl(ev(sunThu, sfacts(), T('2026-11-09T06:59:00Z')), 'slot due').why);
  check('not due on Friday (Fri is not picked)', !ev(sunThu, sfacts(), T('2026-11-13T07:10:00Z')).ok,
    cl(ev(sunThu, sfacts(), T('2026-11-13T07:10:00Z')), 'slot due').why);
  check('next fire from Mon 09:10 is Tue 09:00', nextOf(sunThu, monAt0910) === '2026-11-10T07:00:00.000Z', nextOf(sunThu, monAt0910));
  check('next fire from Thu 10:00 jumps the weekend to Sun 09:00',
    nextOf(sunThu, T('2026-11-12T08:00:00Z')) === '2026-11-15T07:00:00.000Z', nextOf(sunThu, T('2026-11-12T08:00:00Z')));

  console.log('\n[B2] several times a day');
  const twice = strig({ times: ['17:00', '09:00'] });
  check('17:00 slot due at 17:05', ev(twice, sfacts(), T('2026-11-09T15:05:00Z')).reason === 'scheduled for Mon 9 Nov 17:00',
    ev(twice, sfacts(), T('2026-11-09T15:05:00Z')).reason);
  check('an attempt at 09:01 does not block the 17:00 slot',
    ev(twice, sfacts({ lastEventAt: T('2026-11-09T07:01:00Z') }), T('2026-11-09T15:05:00Z')).ok);
  check('at 12:00 the 09:00 slot is 3 hours old — skipped, not sent late',
    !ev(twice, sfacts(), T('2026-11-09T10:00:00Z')).ok, cl(ev(twice, sfacts(), T('2026-11-09T10:00:00Z')), 'slot due').why);
  check('next fire from 12:00 is 17:00 the same day', nextOf(twice, T('2026-11-09T10:00:00Z')) === '2026-11-09T15:00:00.000Z');

  console.log('\n[B3] once');
  const once = strig({ repeat: 'once', onceAt: '2026-12-15T09:00' });
  check('once: not due before the date', !ev(once, sfacts(), T('2026-12-14T07:10:00Z')).ok,
    cl(ev(once, sfacts(), T('2026-12-14T07:10:00Z')), 'slot due').why);
  check('once: due at 09:20 on the day', ev(once, sfacts(), T('2026-12-15T07:20:00Z')).ok, ev(once, sfacts(), T('2026-12-15T07:20:00Z')).reason);
  check('once: not due at 11:00 (past the window)', !ev(once, sfacts(), T('2026-12-15T09:00:00Z')).ok);
  check('once: next fire before = the date; after = none',
    nextOf(once, T('2026-12-01T00:00:00Z')) === '2026-12-15T07:00:00.000Z' && nextOf(once, T('2026-12-15T07:01:00Z')) === null);
  check('once: days and times are ignored', ev(strig({ repeat: 'once', onceAt: '2026-12-15T09:00', days: [], times: [] }), sfacts(), T('2026-12-15T07:20:00Z')).ok);

  console.log('\n[B4] start / end dates');
  const ranged = strig({ startDate: '2026-11-10', endDate: '2026-11-12' });
  check('before the start date: not due', !ev(ranged, sfacts(), monAt0910).ok);
  check('before the start date: next fire is the start day', nextOf(ranged, monAt0910) === '2026-11-10T07:00:00.000Z', nextOf(ranged, monAt0910));
  check('inside the range: due', ev(ranged, sfacts(), T('2026-11-11T07:10:00Z')).ok);
  check('the end date itself is inclusive', ev(ranged, sfacts(), T('2026-11-12T07:10:00Z')).ok);
  check('after the end date: never again', !ev(ranged, sfacts(), T('2026-11-15T07:10:00Z')).ok && nextOf(ranged, T('2026-11-12T08:00:00Z')) === null,
    cl(ev(ranged, sfacts(), T('2026-11-15T07:10:00Z')), 'slot due').why);
  check('next fire from far before a future start jumps to it',
    nextOf(strig({ startDate: '2027-02-01' }), monAt0910) === '2027-02-01T07:00:00.000Z', nextOf(strig({ startDate: '2027-02-01' }), monAt0910));

  console.log('\n[B5] the grace window — no catch-up bursts');
  check(`grace is ${schedule.GRACE_MINUTES} minutes`, schedule.GRACE_MINUTES === 60);
  check('59 minutes late: still sent', ev(sunThu, sfacts(), T('2026-11-09T07:59:00Z')).ok);
  check('61 minutes late: skipped', !ev(sunThu, sfacts(), T('2026-11-09T08:01:00Z')).ok,
    cl(ev(sunThu, sfacts(), T('2026-11-09T08:01:00Z')), 'slot due').why);
  const paused = schedule.candidateSql({ trigger: sunThu, config: sunThu.config, now: T('2026-11-09T09:00:00Z') });
  check('clock paused 08:00–11:00 → at 11:00 the query matches nobody (no backlog)', paused.where === 'FALSE');
  const days3 = schedule.candidateSql({ trigger: twice, config: twice.config, now: T('2026-11-12T07:30:00Z') });
  check('paused for days → only the current slot is live, the missed ones are gone',
    days3.where !== 'FALSE' && days3.params.SLOT_AT.toISOString() === '2026-11-12T07:00:00.000Z', days3.params.SLOT_AT && days3.params.SLOT_AT.toISOString());

  console.log('\n[B6] never twice for the same slot');
  const after = sfacts({ lastEventAt: T('2026-11-09T07:01:00Z') });   // attempt at 09:01
  check('an event after the slot blocks a second try', !ev(sunThu, after, monAt0910).ok, cl(ev(sunThu, after, monAt0910), 'once per slot').why);
  check('a silent / filtered / held attempt counts the same (any event)', !ev(sunThu, sfacts({ lastEventAt: T('2026-11-09T07:00:00Z') }), monAt0910).ok,
    'an event exactly at the slot instant');
  check('yesterday\'s event does not block today\'s slot', ev(sunThu, sfacts({ lastEventAt: T('2026-11-08T07:01:00Z') }), monAt0910).ok);
  const claim = schedule.claimSince({ trigger: sunThu, config: sunThu.config, now: monAt0910 });
  check('the sweep claims exactly the slot instant', claim && claim.toISOString() === '2026-11-09T07:00:00.000Z', claim && claim.toISOString());
  check('nothing claimable outside a slot', schedule.claimSince({ trigger: sunThu, config: sunThu.config, now: T('2026-11-09T10:00:00Z') }) === null);
  const sql = schedule.candidateSql({ trigger: sunThu, config: sunThu.config, now: monAt0910 });
  check('the query drops conversations already handled (NOT EXISTS on the event log)',
    /NOT EXISTS/.test(sql.where) && /e\.matched_at >= \$SLOT_AT/.test(sql.where) && sql.params.TRIGGER_ID === 'trg_sched');

  // The race guard: check-then-insert under an advisory lock. A fake pg
  // client stands in for Postgres (offline), proving the control flow:
  // the second claim of the same slot backs off and inserts nothing.
  {
    const db = require('../services/db.pg');
    const store = require('../builder/runtime/triggerEventsStore');
    const rows = [];
    const realGetClient = db.getClient;
    db.getClient = async () => ({
      async query(sqlText, params = []) {
        if (/^SELECT 1 FROM trigger_events/.test(sqlText.trim())) {
          const hit = rows.some(r => r.trigger === params[0] && r.conv === params[1] && r.at >= params[2].getTime());
          return { rowCount: hit ? 1 : 0, rows: [] };
        }
        if (/^INSERT INTO trigger_events/.test(sqlText.trim())) { rows.push({ trigger: params[2], conv: params[4], at: params[5].getTime() }); return { rowCount: 1 }; }
        return { rowCount: 0, rows: [] };
      },
      release() {},
    });
    try {
      const args = { agentId: 'a', triggerId: 'trg_sched', triggerType: 'schedule', conversationId: 7, matchReason: 'x', since: new Date(Date.now() - 60 * 1000) };
      const first = await store.openOnce(args);
      const second = await store.openOnce(args);
      check('openOnce: first claim opens an event, the second backs off', !!first && second === null && rows.length === 1,
        `${first ? 'opened' : 'none'} / ${second === null ? 'backed off' : 'opened again'}`);
    } finally {
      db.getClient = realGetClient;
    }
  }

  console.log('\n[B7] a conversation created after the slot is not owed it');
  const late = sfacts({ createdAt: T('2026-11-09T07:20:00Z') });     // born 09:20
  check('born 09:20 → not owed the 09:00 slot (asked at 09:30)', !ev(sunThu, late, T('2026-11-09T07:30:00Z')).ok,
    cl(ev(sunThu, late, T('2026-11-09T07:30:00Z')), 'existed at the slot').why);
  check('…but owed the next one', ev(sunThu, late, T('2026-11-10T07:05:00Z')).ok);
  check('the query applies the same rule (created_at read as UTC)', /c\.created_at AT TIME ZONE 'UTC'\) <= \$SLOT_AT/.test(sql.where));

  console.log('\n[B8] switch-on, audience');
  const freshlyOn = strig({}, { activeSince: '2026-11-09T07:30:00Z' });  // switched on 09:30
  check('switched on at 09:30 → the 09:00 slot is not sent', !ev(freshlyOn, sfacts(), T('2026-11-09T07:40:00Z')).ok,
    cl(ev(freshlyOn, sfacts(), T('2026-11-09T07:40:00Z')), 'after switch-on').why);
  check('…and the query says so with FALSE', schedule.candidateSql({ trigger: freshlyOn, config: freshlyOn.config, now: T('2026-11-09T07:40:00Z') }).where === 'FALSE');
  check('a customer who never wrote is not reached', !ev(sunThu, sfacts({ lastUserMessageAt: null }), monAt0910).ok);
  // #968: "not a simulation" was absorbed by the envelope's "real customer".
  check('a simulation (born test) is not reached — by the envelope', !evAll(sunThu, sfacts({ surface: 'simulation', audience: 'test' }), monAt0910).ok,
    cl(evAll(sunThu, sfacts({ surface: 'simulation', audience: 'test' }), monAt0910), 'real customer').why);
  check('the type no longer has its own "not a simulation" clause', cl(ev(sunThu, sfacts(), monAt0910), 'not a simulation').ok === null);
  check('a builder-preview chat marked real is reached', evAll(sunThu, sfacts({ surface: 'builder-preview', audience: 'real' }), monAt0910).ok);

  console.log('\n[B9] midnight — the day is the LOCAL day');
  const tueMidnight = strig({ days: [2], times: ['00:00'] });
  // 2026-11-09T22:10Z is Tue 00:10 in Jerusalem but still Monday in UTC.
  check('Tue 00:00 slot due at Tue 00:10 local (Mon 22:10 UTC)', ev(tueMidnight, sfacts(), T('2026-11-09T22:10:00Z')).ok,
    ev(tueMidnight, sfacts(), T('2026-11-09T22:10:00Z')).reason);
  check('a Monday-only 00:00 is not due then', !ev(strig({ days: [1], times: ['00:00'] }), sfacts(), T('2026-11-09T22:10:00Z')).ok);
  const late2359 = strig({ days: [1], times: ['23:59'] });
  check('Mon 23:59 still due at Tue 00:30 (inside the window, across midnight)', ev(late2359, sfacts(), T('2026-11-09T22:30:00Z')).ok,
    ev(late2359, sfacts(), T('2026-11-09T22:30:00Z')).reason);

  console.log('\n[B10] daylight saving in Asia/Jerusalem');
  const every = (times) => strig({ days: [0, 1, 2, 3, 4, 5, 6], times });
  // Spring forward: Fri 26 Mar 2027, 02:00 → 03:00.
  check('spring: 09:00 before the change is 07:00 UTC', nextOf(every(['09:00']), T('2027-03-25T00:00:00Z')) === '2027-03-25T07:00:00.000Z');
  check('spring: 09:00 after the change is 06:00 UTC', nextOf(every(['09:00']), T('2027-03-25T08:00:00Z')) === '2027-03-26T06:00:00.000Z');
  check('spring: 02:30 (does not exist) runs right after the gap, 03:30 local',
    nextOf(every(['02:30']), T('2027-03-25T12:00:00Z')) === '2027-03-26T00:30:00.000Z', nextOf(every(['02:30']), T('2027-03-25T12:00:00Z')));
  check('spring: that run is due and labelled with the authored time',
    ev(every(['02:30']), sfacts(), T('2027-03-26T00:40:00Z')).reason === 'scheduled for Fri 26 Mar 02:30');
  // Fall back: Sun 31 Oct 2027, 02:00 → 01:00 (01:00–02:00 happens twice).
  const fall = every(['01:30']);
  check('autumn: 01:30 (happens twice) is the FIRST one, 22:30 UTC',
    nextOf(fall, T('2027-10-30T12:00:00Z')) === '2027-10-30T22:30:00.000Z', nextOf(fall, T('2027-10-30T12:00:00Z')));
  check('autumn: the second 01:30 is not a new slot — next is Monday',
    nextOf(fall, T('2027-10-30T22:31:00Z')) === '2027-10-31T23:30:00.000Z', nextOf(fall, T('2027-10-30T22:31:00Z')));
  check('autumn: tried at the first 01:30 → nothing at the second 01:30',
    !ev(fall, sfacts({ lastEventAt: T('2027-10-30T22:31:00Z') }), T('2027-10-30T23:35:00Z')).ok,
    cl(ev(fall, sfacts({ lastEventAt: T('2027-10-30T22:31:00Z') }), T('2027-10-30T23:35:00Z')), 'once per slot').why);
  check('autumn: 09:00 after the change is 07:00 UTC', nextOf(every(['09:00']), T('2027-10-31T00:30:00Z')) === '2027-10-31T07:00:00.000Z');

  console.log('\n[B11] quiet hours and the message limit');
  const qh = { from: '22:00', to: '08:00', timezone: 'Asia/Jerusalem' };
  const early = strig({ times: ['07:30', '09:00'] }, { quietHours: qh });
  check('the card\'s next fire steps over a time inside quiet hours',
    (() => { const n = triggerEvaluator.nextFireOf(early, T('2026-11-09T04:00:00Z')); return n.at.toISOString() === '2026-11-09T07:00:00.000Z' && n.skippedForQuietHours === 1; })(),
    JSON.stringify(triggerEvaluator.nextFireOf(early, T('2026-11-09T04:00:00Z'))));
  check('the 07:30 slot matches the clauses (the dispatcher then holds it for quiet hours)',
    ev(early, sfacts(), T('2026-11-09T05:31:00Z')).ok && triggerEvaluator.checkQuietHours(qh, T('2026-11-09T05:31:00Z')).suppressed);
  check('held at 07:31 → at 08:05 (quiet hours over, still in the window) it is NOT sent late',
    !ev(early, sfacts({ lastEventAt: T('2026-11-09T05:31:00Z') }), T('2026-11-09T06:05:00Z')).ok,
    cl(ev(early, sfacts({ lastEventAt: T('2026-11-09T05:31:00Z') }), T('2026-11-09T06:05:00Z')), 'once per slot').why);
  check('every time inside quiet hours → no next fire', triggerEvaluator.nextFireOf(strig({ times: ['23:00'] }, { quietHours: qh }), monAt0910).at === null);
  const capped = strig({}, { limits: { perConversation: { max: 1, days: 7 } } });
  check('message limit reached → blocked by the envelope clause',
    !evAll(capped, sfacts({ deliveredAt: [T('2026-11-08T07:02:00Z')] }), monAt0910).ok,
    cl(evAll(capped, sfacts({ deliveredAt: [T('2026-11-08T07:02:00Z')] }), monAt0910), 'message cap').why);
  check('message limit not reached → the slot fires', evAll(capped, sfacts({ deliveredAt: [T('2026-11-01T07:02:00Z')] }), monAt0910).ok);

  console.log('\n[B12] a hand-edited body never matches by accident');
  for (const [label, cfg] of [
    ['no days',           { days: [] }],
    ['no times',          { times: [] }],
    ['garbage times only',{ times: ['25:00', 'nine', '9'] }],
    ['unknown timezone',  { timezone: 'Nowhere/Void' }],
    ['end before start',  { startDate: '2026-12-01', endDate: '2026-11-01' }],
    ['once with no date', { repeat: 'once' }],
  ]) {
    const r = ev(strig(cfg), sfacts(), monAt0910);
    check(`${label} → fires for nobody, and says why`, !r.ok && r.clauses[0].name === 'schedule set', r.clauses[0].why);
  }
  check('a missing timezone means Asia/Jerusalem', ev(strig({ timezone: undefined }), sfacts(), monAt0910).ok);
  check('times are tidied: "9:00" works, duplicates collapse',
    slots.normalizeSchedule({ days: [1], times: ['9:00', '09:00', '17:00'] }).times.join(',') === '09:00,17:00');

  console.log('\n[B13] the status line speaks Schedule');
  check('nothing due → "no slot due · next: …"',
    /^no slot due · next: Tue 10 Nov 09:00$/.test(schedule.describeZero({ blocked: {}, trigger: sunThu, config: sunThu.config, now: T('2026-11-09T10:00:00Z') })),
    schedule.describeZero({ blocked: {}, trigger: sunThu, config: sunThu.config, now: T('2026-11-09T10:00:00Z') }));
  check('everyone handled → says so', /already had this slot/.test(schedule.describeZero({ blocked: {}, trigger: sunThu, config: sunThu.config, now: monAt0910 })));
  check('every clause reports, pass or fail (5 type clauses)', ev(sunThu, sfacts(), monAt0910).clauses.length === 5,
    ev(sunThu, sfacts(), monAt0910).clauses.map(c => `${c.ok ? '✓' : '✗'} ${c.name}`).join(' · '));
}

const schedule = require('../builder/triggers/schedule/trigger.schedule');

// ────────────────────────────────────────────────────────────────────
// PART C — real customers only (#968)
// ────────────────────────────────────────────────────────────────────
async function partC() {
  console.log('\nPART C — real customers only (offline)\n');
  const audience = require('../builder/runtime/conversationAudience');
  const db = require('../services/db.pg');
  const T = (iso) => new Date(iso);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Both types, set up so the TYPE's own clauses all pass — the only
  // thing that varies below is the audience mark.
  const silenceT = trig();
  const silenceFacts = (a) => facts(a === undefined ? {} : { audience: a });
  const schedT = {
    id: 'trg_sched', typeId: 'schedule', enabled: true, activeSince: '2026-01-01T00:00:00Z',
    config: { repeat: 'weekly', days: [0, 1, 2, 3, 4], times: ['09:00'], timezone: 'Asia/Jerusalem' },
    run: { crewId: CREW_ID },
  };
  const schedNow = T('2026-11-09T07:10:00Z');                         // Mon 09:10 Jerusalem
  const schedFacts = (a) => ({
    conversationId: 7, lastUserMessageAt: T('2026-11-01T10:00:00Z'), lastMessageAt: T('2026-11-01T10:00:00Z'),
    lastEventAt: null, attemptsSinceLastUserMessage: 0, createdAt: T('2026-11-01T09:00:00Z'),
    deliveredAt: [], surface: 'live', ...(a === undefined ? {} : { audience: a }),
  });
  const types = [
    ['Silence',  silenceT, silenceFacts, NOW,      { evaluate: silence.evaluate }],
    ['Schedule', schedT,   schedFacts,   schedNow, { evaluate: schedule.evaluate }],
  ];
  const cl = (r, name) => (r.clauses.find(c => c.name === name) || { ok: null, why: '(absent)' });

  console.log('[C1] the envelope clause — both types inherit it');
  for (const [label, t, f, now, type] of types) {
    const real = triggerEvaluator.evaluateAll({ type, facts: f('real'), trigger: t, now });
    const test = triggerEvaluator.evaluateAll({ type, facts: f('test'), trigger: t, now });
    const none = triggerEvaluator.evaluateAll({ type, facts: f(undefined), trigger: t, now });
    const junk = triggerEvaluator.evaluateAll({ type, facts: f('REAL'), trigger: t, now });
    check(`${label}: real → fires, "real customer" ✓`, real.ok && cl(real, 'real customer').ok === true, cl(real, 'real customer').why);
    check(`${label}: test → does not fire`, !test.ok && cl(test, 'real customer').ok === false, cl(test, 'real customer').why);
    check(`${label}: no mark → does not fire (fail closed)`, !none.ok && cl(none, 'real customer').ok === false, cl(none, 'real customer').why);
    check(`${label}: anything but exactly "real" is test`, !junk.ok);
    check(`${label}: the clause is shown FIRST`, real.clauses[0].name === 'real customer' && test.clauses[0].name === 'real customer');
    check(`${label}: the type's own clauses still all pass on the test one`,
      test.clauses.filter(c => c.name !== 'real customer').every(c => c.ok));
  }
  check('Silence: real + message cap reached → still blocked (clauses stack)',
    !triggerEvaluator.evaluateAll({ type: { evaluate: silence.evaluate }, facts: facts({ audience: 'real', deliveredAt: [ago(MIN)] }),
      trigger: trig({ limits: { perConversation: { max: 1, days: 7 } } }), now: NOW }).ok);

  console.log('\n[C2] gate 1 — the SQL itself requires real');
  const REAL = "c.metadata->>'audience' = 'real'";
  check('REAL_SQL is the plain jsonb compare', audience.REAL_SQL === REAL, audience.REAL_SQL);
  const shapes = [
    ['Silence', triggerEvaluator.buildFindDueSql({ legacyAgentId: 1, trigger: silenceT, now: NOW })],
    ['Schedule (slot due)', triggerEvaluator.buildFindDueSql({ legacyAgentId: 1, trigger: schedT, now: schedNow })],
    ['Schedule (no slot → FALSE)', triggerEvaluator.buildFindDueSql({ legacyAgentId: 1, trigger: schedT, now: T('2026-11-09T10:00:00Z') })],
    ['Silence, local surface wall', triggerEvaluator.buildFindDueSql({ legacyAgentId: 1, trigger: silenceT, now: NOW, conversationKinds: ['builder-preview'] })],
  ];
  for (const [label, q] of shapes) {
    const where = q.sql.slice(q.sql.indexOf('FROM conversations c'), q.sql.lastIndexOf('ORDER BY'));
    check(`${label}: WHERE ANDs the real-customer condition`, new RegExp(`AND ${esc(REAL)}\\s+AND \\(`).test(where),
      where.replace(/\s+/g, ' ').trim().slice(0, 170));
  }
  const kinds = shapes[3][1];
  check('the placeholders still line up with the params (surface wall last)',
    /= ANY\(\$5\)/.test(kinds.sql) && kinds.params.length === 5 && Array.isArray(kinds.params[4]), `${kinds.params.length} params`);
  check('the facts select the mark', /c\.metadata->>'audience' AS audience/.test(shapes[0][1].sql));
  check('Schedule\'s own narrowing no longer names simulations',
    !/simulation/.test(schedule.candidateSql({ trigger: schedT, config: schedT.config, now: schedNow }).where));

  console.log('\n[C3] findDue / Check / the explainer, against a fake db.query');
  const realQuery = db.query;
  const seen = [];
  // A DB row whose facts pass every TYPE clause for `t` at its `now`.
  const row = (a, f = schedFacts()) => ({
    conversation_id: 7, last_user_message_at: f.lastUserMessageAt, last_message_at: f.lastMessageAt,
    created_at: f.createdAt, surface: 'live', audience: a, last_event_at: null,
    attempts_since_last_user_message: 0, delivered_at: [],
  });
  let nextRows = [];
  db.query = async (text, params) => { seen.push({ text, params }); return { rows: nextRows }; };
  try {
    nextRows = [row('real')];
    const due = await triggerEvaluator.findDue({ legacyAgentId: 1, trigger: schedT, now: schedNow });
    check('findDue sends the real-customer condition to the database', seen[0].text.includes(REAL));
    check('findDue: a real row comes back due', due.due.length === 1 && due.due[0].facts.audience === 'real');

    // The SQL would never return a test row; if one slipped through,
    // evaluate still refuses it — two locks, not one.
    nextRows = [row('test'), row(null)];
    const leak = await triggerEvaluator.findDue({ legacyAgentId: 1, trigger: schedT, now: schedNow });
    check('findDue: a test / unmarked row that slipped through is still refused',
      leak.due.length === 0 && leak.blocked['real customer'] === 2, JSON.stringify(leak.blocked));

    for (const [label, t, f, now] of types) {
      for (const a of ['real', 'test', null]) {
        nextRows = [row(a, f())];
        const chk = await triggerEvaluator.checkOne({ trigger: t, conversationId: 7, now });
        const ex = await triggerEvaluator.explainAt({ trigger: t, conversationId: 7, at: now });
        const c1 = cl(chk.evaluation, 'real customer');
        const c2 = cl(ex.evaluation, 'real customer');
        const want = a === 'real';
        check(`${label} · ${a || 'no mark'}: Check ("Will it trigger?") and the explainer both say ${want ? '✓' : '✗'} real customer`,
          c1.ok === want && c2.ok === want && c1.why === c2.why && chk.evaluation.ok === want, c2.why);
      }
    }
    check('the explainer\'s own query selects the mark',
      seen.some(q => /c\.metadata->>'audience' AS audience/.test(q.text) && /m\.created_at AT TIME ZONE 'UTC'/.test(q.text)));
  } finally {
    db.query = realQuery;
  }

  console.log('\n[C4] the mark a conversation is born with');
  const realUser = { metadata: { realCustomer: true } };
  check('customer chat + user marked "Real customer" → real', audience.audienceAtCreation({ surface: 'live', user: realUser }) === 'real');
  check('customer chat + user not marked → test', audience.audienceAtCreation({ surface: 'live', user: { metadata: {} } }) === 'test');
  check('customer chat + no metadata → test', audience.audienceAtCreation({ surface: 'live', user: { metadata: null } }) === 'test');
  check('customer chat + "true" as a string → test (strictly true)',
    audience.audienceAtCreation({ surface: 'live', user: { metadata: { realCustomer: 'true' } } }) === 'test');
  check('customer chat + unknown user → test', audience.audienceAtCreation({ surface: 'live', user: null }) === 'test');
  check('builder chat, even by a real customer → test', audience.audienceAtCreation({ surface: 'builder-preview', user: realUser }) === 'test');
  check('MCP simulation, even by a real customer → test', audience.audienceAtCreation({ surface: 'simulation', user: realUser }) === 'test');
  check('nothing given → test', audience.audienceAtCreation() === 'test');
  check('reading a mark: only "real" is real', audience.audienceOf({ audience: 'real' }) === 'real'
    && ['test', 'Real', '', undefined].every(a => audience.audienceOf({ audience: a }) === 'test')
    && audience.audienceOf(null) === 'test');
  check('setting a mark: only "real" / "test" are accepted', audience.parseAudience(' REAL ') === 'real'
    && audience.parseAudience('test') === 'test' && audience.parseAudience('yes') === null && audience.parseAudience(null) === null);

  // Wiring: the create route stamps the mark from the owner, and the MCP
  // never creates anything but a simulation (born test).
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'builder', 'routes', 'runtimeRoute.js'), 'utf8');
  check('POST /conversations stamps metadata.audience from audienceAtCreation({ surface, user: owner })',
    /audience: conversationAudience\.audienceAtCreation\(\{ surface, user: owner \}\)/.test(routeSrc));
  const mcpSrc = fs.readFileSync(path.join(__dirname, '..', 'builder', 'services', 'mcpConversations.js'), 'utf8');
  check('MCP conversations are created as simulations (so: test)', /source: 'simulation'/.test(mcpSrc));
  check('the MCP can mark only its own simulations', /async function setAudience[\s\S]{0,600}loadSimulation\(conversationId\)/.test(mcpSrc));
}

// ────────────────────────────────────────────────────────────────────
// PART D — a mark can never be reverted by a stale write; the status
// line counts the test conversations it skipped (#968 follow-up)
// ────────────────────────────────────────────────────────────────────
async function partD() {
  console.log('\nPART D — stale writes, skipped-test count (offline)\n');
  const { PgDialect } = require('drizzle-orm/pg-core');
  const { mergeMetadata } = require('../builder/runtime/conversationMeta');
  const db = require('../services/db.pg');
  const dialect = new PgDialect();
  const render = (expr) => dialect.sqlToQuery(expr);
  const isSqlExpr = (v) => v && typeof v === 'object' && Array.isArray(v.queryChunks);

  console.log('[D1] the merge expression');
  const q = render(mergeMetadata({ currentCrewId: 'crew_b', lastTransitionMessageId: 42 }));
  check('it merges into the row\'s CURRENT metadata in SQL', q.sql === `COALESCE("conversations"."metadata", '{}'::jsonb) || $1::jsonb`, q.sql);
  check('it sends only the changed keys — no audience, nothing copied',
    q.params.length === 1 && q.params[0] === JSON.stringify({ currentCrewId: 'crew_b', lastTransitionMessageId: 42 }), q.params[0]);
  let threw = false;
  try { mergeMetadata(null); } catch { threw = true; }
  check('a non-object patch is refused', threw);

  // A fake drizzle over ONE row. `update().set()` applies what the code
  // sent the way Postgres would: a merge expression → current || patch;
  // a plain object → the whole column replaced (the old, unsafe way).
  function fakeDb(row, staleCopy) {
    const writes = [];
    const apply = (set) => {
      writes.push(set);
      for (const [k, v] of Object.entries(set)) {
        if (k !== 'metadata') { row[k] = v; continue; }
        if (isSqlExpr(v)) {
          const r = render(v);
          row.metadata = { ...(row.metadata || {}), ...JSON.parse(r.params[r.params.length - 1]) };
        } else {
          row.metadata = v;
        }
      }
    };
    const chain = (result) => {
      const p = Promise.resolve(result);
      return Object.assign(p, { limit: async () => result, returning: async () => [{ ...row }], orderBy: () => chain(result) });
    };
    return {
      writes,
      select: () => ({ from: () => ({ where: () => chain([{ ...staleCopy() }]), leftJoin: () => ({ where: () => chain([{ conv: staleCopy(), slug: 'agent-x' }]) }) }) }),
      update: () => ({ set: (set) => ({ where: () => { apply(set); return chain([{ ...row }]); } }) }),
      insert: () => ({ values: () => ({ returning: async () => [{ ...row }] }) }),
    };
  }

  console.log('\n[D2] real writers, fed a STALE copy that still says "real"');
  // The race: the turn read metadata when audience was 'real'; a person
  // has since marked it 'test'; now the turn writes.
  const STALE = () => ({ id: 5, externalId: 'ext5', agentId: 1, metadata: { kind: 'live', agentSlug: 'agent-x', audience: 'real', currentCrewId: 'crew_a' } });

  // V1 service writers, called for real with the fake drizzle.
  const convService = require('../services/conversation.service');
  {
    const row = { id: 5, metadata: { kind: 'live', agentSlug: 'agent-x', audience: 'test', currentCrewId: 'crew_a' } };
    const fake = fakeDb(row, STALE);
    const saved = convService.drizzle;
    convService.drizzle = fake;
    try {
      await convService.updateCurrentCrewMember('ext5', 'Greeter');
      check('conversation.service.updateCurrentCrewMember keeps the newer "test"',
        row.metadata.audience === 'test' && row.metadata.currentCrewMember === 'Greeter', JSON.stringify(row.metadata));
      await convService.updateConversationMetadata('ext5', { title: 'x' });
      check('conversation.service.updateConversationMetadata keeps the newer "test"',
        row.metadata.audience === 'test' && row.metadata.title === 'x', JSON.stringify(row.metadata));
      check('…and both sent a merge, not an object', fake.writes.every(w => isSqlExpr(w.metadata)));
    } finally {
      convService.drizzle = saved;
    }
  }

  // The builder route's rename, through Express, with the fake drizzle.
  {
    const row = { id: 5, metadata: { kind: 'live', agentSlug: 'agent-x', audience: 'test' } };
    const fake = fakeDb(row, STALE);
    const savedGet = db.getDrizzle;
    db.getDrizzle = () => fake;
    try {
      const express = require('express');
      const app = express();
      app.use(express.json());
      app.use('/api/agents', require('../builder/routes/runtimeRoute'));
      const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const base = `http://127.0.0.1:${server.address().port}/api/agents/agent-x/conversations/5`;
      const res = await fetch(base, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'renamed' }) });
      check('PATCH rename (builder) keeps the newer "test"', res.ok && row.metadata.audience === 'test' && row.metadata.name === 'renamed', JSON.stringify(row.metadata));
      // And the mark itself, written while the copy says otherwise.
      row.metadata.audience = 'real';
      const res2 = await fetch(`${base}/audience`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audience: 'test' }) });
      check('PATCH audience writes only the mark (merge)', res2.ok && row.metadata.audience === 'test' && row.metadata.name === 'renamed', JSON.stringify(row.metadata));
      server.close();
    } finally {
      db.getDrizzle = savedGet;
    }
  }

  // The old way, for contrast: spreading the stale copy reverts the mark.
  {
    const row = { id: 5, metadata: { audience: 'test' } };
    const fake = fakeDb(row, STALE);
    await fake.update().set({ metadata: { ...STALE().metadata, currentCrewId: 'crew_b' } }).where();
    check('(control) the old spread-the-copy write WOULD have reverted it to "real"', row.metadata.audience === 'real');
  }

  // Every writer in the turn path, by source: after `update(conversations)`
  // any `metadata:` in the `.set({…})` must be `mergeMetadata(`.
  const files = [
    'builder/runtime/addonRunner.js',      // transition router
    'builder/runtime/BuilderRunner.js',    // crew override
    'builder/routes/runtimeRoute.js',      // auto-name, pre-run override, rename, audience
    'builder/services/mcpConversations.js',// simulation start, setAudience
    'services/conversation.service.js',    // V1 metadata + crew member
  ];
  let writers = 0;
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const re = /update\(conversations\)\s*\.set\(\{([\s\S]*?)\}\)\s*\.where/g;
    let m;
    while ((m = re.exec(src))) {
      if (!/metadata\s*:/.test(m[1])) continue;
      writers += 1;
      if (!/metadata\s*:\s*mergeMetadata\(/.test(m[1])) offenders.push(`${f}: ${m[1].trim().slice(0, 60)}`);
    }
  }
  check(`every conversations.metadata writer in the turn path merges (${writers} found)`, writers >= 9 && offenders.length === 0,
    offenders.join(' | ') || `${writers} writers`);
  const v1 = fs.readFileSync(path.join(__dirname, '..', 'services', 'conversation.service.js'), 'utf8');
  check('a duplicated conversation never inherits the mark', /\(\{ audience, audienceMarkedAt, \.\.\.rest \}\) => \(\{ \.\.\.rest, title: newTitle \}\)/.test(v1));

  console.log('\n[D3] "N test conversations skipped" on the status line');
  const audience = require('../builder/runtime/conversationAudience');
  const dispatcher = require('../builder/runtime/triggerDispatcher');
  const store = require('../builder/runtime/triggerEventsStore');
  const silenceT = trig();
  const schedT = {
    id: 'trg_sched', typeId: 'schedule', enabled: true, activeSince: '2026-01-01T00:00:00Z',
    config: { repeat: 'weekly', days: [0, 1, 2, 3, 4], times: ['09:00'], timezone: 'Asia/Jerusalem' }, run: { crewId: CREW_ID },
  };
  const schedNow = new Date('2026-11-09T07:10:00Z');
  for (const [label, t, now] of [['Silence', silenceT, NOW], ['Schedule', schedT, schedNow]]) {
    const main = triggerEvaluator.buildFindDueSql({ legacyAgentId: 1, trigger: t, now });
    const cnt = triggerEvaluator.buildFindDueSql({ legacyAgentId: 1, trigger: t, now, countTest: true });
    check(`${label}: the count is the same narrowing with the audience flipped`,
      /SELECT COUNT\(\*\)::int AS n/.test(cnt.sql) && cnt.sql.includes(audience.NOT_REAL_SQL) && !cnt.sql.includes(audience.REAL_SQL + '\n')
        && JSON.stringify(cnt.params) === JSON.stringify(main.params) && /\$2::text/.test(cnt.sql));
  }
  check('NOT_REAL_SQL counts unmarked rows as test', audience.NOT_REAL_SQL === "COALESCE(c.metadata->>'audience', '') <> 'real'");
  check('wording: one / many / none',
    dispatcher.withSkippedTest('nobody was quiet enough', 1) === 'nobody was quiet enough · 1 test conversation skipped'
      && dispatcher.withSkippedTest('3 matched', 4) === '3 matched · 4 test conversations skipped'
      && dispatcher.withSkippedTest('x', 0) === 'x');

  // A real dry-run sweep against a fake db.query: what lands on the card.
  const realQuery = db.query;
  const realRecord = store.recordEvaluation;
  const recorded = [];
  store.recordEvaluation = async (a) => { recorded.push(a); };
  db.query = async (text) => {
    if (/FROM agents WHERE url_slug/.test(text)) return { rows: [{ id: 1 }] };
    if (/COUNT\(\*\)::int AS n/.test(text)) return { rows: [{ n: 3 }] };
    return { rows: [] };                       // findDue: no real conversation due
  };
  const realLog = console.log;
  try {
    console.log = () => {};
    const r1 = await dispatcher.sweepTrigger({ agentSlug: 'agent-x', agentId: 'a1', trigger: silenceT, now: NOW, dryRun: true });
    const r2 = await dispatcher.sweepTrigger({ agentSlug: 'agent-x', agentId: 'a1', trigger: schedT, now: schedNow, dryRun: true });
    console.log = realLog;
    check('Silence: the status line says it', recorded[0].reason === 'nobody was quiet enough · 3 test conversations skipped' && r1.skippedTest === 3, recorded[0].reason);
    check('Schedule: the status line says it', /· 3 test conversations skipped$/.test(recorded[1].reason) && r2.skippedTest === 3, recorded[1].reason);
  } finally {
    console.log = realLog;
    db.query = realQuery;
    store.recordEvaluation = realRecord;
  }
}

async function main() {
  partA();
  await partB();
  await partC();
  await partD();

  const outDir = path.join(__dirname, '..', 'verification', 'triggers');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
    ranAt: new Date().toISOString(),
    passed: results.length - failures,
    failed: failures,
    checks: results,
  }, null, 2));

  console.log(`\n════════ ${results.length - failures}/${results.length} PASS ════════`);
  console.log('Written to verification/triggers/results.json');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nBattery failed to run:', err.message);
  console.error(err);
  process.exit(1);
});
