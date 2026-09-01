/**
 * test-triggers.js — the Silence rule's arithmetic, checked offline.
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
 * Usage:  node scripts/test-triggers.js
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

async function main() {
  partA();

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
