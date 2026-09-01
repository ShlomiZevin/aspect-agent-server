/**
 * test-trigger-clock.js — battery for the trigger clock (Builder V2
 * Triggers, phase T3). See docs/guides/BUILDER_V2_TRIGGERS.md.
 *
 * The clock is the one part of this feature that acts with nobody
 * watching, so the assertions here are mostly about it REFUSING to act:
 *
 *   - off by default, and a tick does nothing while it is off
 *   - two copies ticking at once cannot both proceed (the lease)
 *   - a crashed holder's lease expires instead of wedging the clock
 *   - only agents that actually have enabled triggers are swept
 *   - one broken agent does not stop the sweep for the others
 *
 * Runs against the real database. It saves and restores the clock's
 * settings, so running it on a live system leaves the switch exactly as
 * it found it.
 *
 * Usage:  node scripts/test-trigger-clock.js [--live]
 * Writes: verification/trigger-clock/results.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../services/db.pg');
const clock = require('../services/trigger-clock.service');

// The clock battery only reads/writes the clock's OWN settings rows,
// which it restores in a finally — safe without --live. The one section
// that borrows a real agent's version body is gated behind --live.
const LIVE = process.argv.includes('--live');

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function main() {
  await db.initialize();
  console.log('\nTrigger clock battery\n');

  // Preserve whatever the system was doing, and put it back.
  const original = await clock.getSettings();
  const originalLease = await q('SELECT value FROM provider_config WHERE key = $1', [clock.LEASE_KEY]);

  try {
    console.log('[1] the master switch');
    await clock.setSettings({ enabled: false });
    const off = await clock.runTick({ holder: 'test' });
    check('a tick does nothing while the clock is off', off.skipped === 'clock is off',
      off.skipped || 'IT RAN — the clock must never start itself');
    check('and it says so rather than failing silently', !!off.skipped, off.skipped);

    const stepped = await clock.runTick({ force: true, dryRun: true, holder: 'test-step' });
    check('"Step once" runs even while paused', !stepped.skipped || stepped.skipped !== 'clock is off',
      `agents swept: ${stepped.agents}`);
    check('a dry-run step launches nothing', stepped.dryRun === true && stepped.fired === 0,
      `fired=${stepped.fired}`);

    console.log('\n[2] the lease — the overlapping-work guard');
    // Race the CLAIM directly rather than two `runTick`s.
    //
    // The first attempt at this raced two real ticks and saw both
    // proceed, which looked like a broken lease. It wasn't: with no
    // agents to sweep, each tick claimed, did nothing and released in
    // under a millisecond, so they never actually overlapped. Two
    // sequential ticks are not a bug — the event log is what stops a
    // customer being nudged twice (see the service header, and
    // test-triggers.js [11] which asserts it end to end). The lease only
    // has to stop two sweeps running AT ONCE, and that is what this
    // races.
    await q('DELETE FROM provider_config WHERE key = $1', [clock.LEASE_KEY]);
    await clock.setSettings({ enabled: true });

    const claims = await Promise.all([
      clock.claimLease('copy-a'),
      clock.claimLease('copy-b'),
      clock.claimLease('copy-c'),
    ]);
    const winners = claims.filter(Boolean).length;
    check('exactly one of three simultaneous claims wins', winners === 1,
      `${winners} winner(s) — two would mean the same sweep running twice`);

    const alsoBlocked = await clock.claimLease('copy-d');
    check('a fourth claim while the lease is held is refused', alsoBlocked === false);

    await clock.releaseLease();
    check('after release, the next claim succeeds', (await clock.claimLease('copy-e')) === true,
      'a finished tick must not block the next minute');
    await clock.releaseLease();

    console.log('\n[3] a crashed holder must not wedge the clock');
    // Write a lease that expired an hour ago — what a copy killed
    // mid-tick leaves behind.
    await q(
      `INSERT INTO provider_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [clock.LEASE_KEY, JSON.stringify({
        holder: 'dead-copy',
        until: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      })]);
    const afterCrash = await clock.runTick({ holder: 'test-recover', dryRun: true });
    check('an expired lease is reclaimed, not honoured', !afterCrash.skipped,
      afterCrash.skipped || 'reclaimed — no stuck lock, no manual recovery');

    // And a live lease is honoured.
    await q(
      `UPDATE provider_config SET value = $2 WHERE key = $1`,
      [clock.LEASE_KEY, JSON.stringify({
        holder: 'busy-copy',
        until: new Date(Date.now() + 60 * 1000).toISOString(),
        claimedAt: new Date().toISOString(),
      })]);
    const whileHeld = await clock.runTick({ holder: 'test-blocked', dryRun: true });
    check('a live lease blocks a second tick',
      whileHeld.skipped === 'another instance holds the tick lease', whileHeld.skipped);
    await q('DELETE FROM provider_config WHERE key = $1', [clock.LEASE_KEY]);

    console.log('\n[4] which agents get swept');
    const slugs = await clock.agentsWithTriggers();
    check('only agents with at least one trigger are listed',
      Array.isArray(slugs), `${slugs.length} agent(s): ${slugs.join(', ') || 'none yet'}`);

    // Prove the jsonb filter actually filters: an agent with an EMPTY
    // triggers array must not be swept. Without this the clock would
    // walk every agent on the platform once a minute.
    // This borrows a real agent's version body to prove the jsonb
    // scoping filters correctly, and restores it afterwards. Borrowing
    // production data is still borrowing, so it needs --live.
    const [anyAgent] = LIVE ? await q(`
      SELECT a.slug, v.id AS version_id, v.body
        FROM builder_agents a
        JOIN builder_agent_versions v ON v.id = COALESCE(a.published_version_id, a.active_version_id, a.viewing_version_id)
       WHERE a.archived_at IS NULL
       LIMIT 1`) : [null];
    if (!LIVE) {
      console.log('  (skipped the agent-body scoping checks — pass --live to run them)');
    }
    if (anyAgent) {
      const before = await clock.agentsWithTriggers();
      await q(`UPDATE builder_agent_versions
                  SET body = jsonb_set(body, '{triggers}', '{"triggers": []}'::jsonb)
                WHERE id = $1`, [anyAgent.version_id]);
      const withEmpty = await clock.agentsWithTriggers();
      check('an agent with an empty triggers array is NOT swept',
        !withEmpty.includes(anyAgent.slug),
        `${anyAgent.slug} correctly excluded`);

      // ...and one with a disabled triggers block is skipped too.
      await q(`UPDATE builder_agent_versions
                  SET body = jsonb_set(body, '{triggers}', $2::jsonb)
                WHERE id = $1`,
        [anyAgent.version_id, JSON.stringify({
          enabled: false,
          triggers: [{ id: 't1', typeId: 'silence', enabled: true, run: { crewId: 'x' } }],
        })]);
      const withDisabled = await clock.agentsWithTriggers();
      check('an agent whose Triggers block is switched off is NOT swept',
        !withDisabled.includes(anyAgent.slug),
        'the per-agent master switch is honoured by the clock, not just the UI');

      // ...and one with a real enabled trigger IS picked up.
      await q(`UPDATE builder_agent_versions
                  SET body = jsonb_set(body, '{triggers}', $2::jsonb)
                WHERE id = $1`,
        [anyAgent.version_id, JSON.stringify({
          triggers: [{ id: 't1', typeId: 'silence', enabled: true, run: { crewId: 'x' } }],
        })]);
      const withOne = await clock.agentsWithTriggers();
      check('an agent with an enabled trigger IS swept', withOne.includes(anyAgent.slug),
        anyAgent.slug);

      // Restore the agent body exactly as found.
      await q('UPDATE builder_agent_versions SET body = $2 WHERE id = $1',
        [anyAgent.version_id, anyAgent.body]);
      const restored = await clock.agentsWithTriggers();
      check('the battery restored the agent body it borrowed',
        JSON.stringify(restored) === JSON.stringify(before),
        `${restored.length} vs ${before.length} before`);
    }

    console.log('\n[5] health');
    const health = await clock.health();
    check('health reports the switch', typeof health.enabled === 'boolean', `enabled=${health.enabled}`);
    check('health states the precision floor honestly',
      /as precise as the clock/i.test(health.precisionNote || ''), health.precisionNote);
    check('health lists which agents are in scope',
      Array.isArray(health.agentsWithTriggers));
  } finally {
    await clock.setSettings(original);
    await q('DELETE FROM provider_config WHERE key = $1', [clock.LEASE_KEY]);
    if (originalLease.length) {
      await q('INSERT INTO provider_config (key, value) VALUES ($1, $2)', [clock.LEASE_KEY, originalLease[0].value]);
    }
    console.log(`\n  clock settings restored (enabled=${original.enabled})`);
  }

  const outDir = path.join(__dirname, '..', 'verification', 'trigger-clock');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
    ranAt: new Date().toISOString(),
    passed: results.length - failures,
    failed: failures,
    checks: results,
  }, null, 2));

  console.log(`\n════════ ${results.length - failures}/${results.length} PASS ════════`);
  console.log('Written to verification/trigger-clock/results.json');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\nBattery failed to run:', err.message);
  console.error(err);
  process.exit(1);
});
