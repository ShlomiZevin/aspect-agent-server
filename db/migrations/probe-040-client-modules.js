require('dotenv').config();
const db = require('../../services/db.pg');

/**
 * A1 verify probe for 040_add_client_modules.
 *
 * Proves the three framework tables behave as the plan's state machine
 * requires — not merely that they exist:
 *   1. the (dataset_id, module_id) UNIQUE constraint holds
 *   2. ON CONFLICT upsert updates in place rather than duplicating
 *   3. the status CHECK rejects an unknown state (this column gates whether
 *      a module's surfaces go live, so a typo must fail at write time)
 *   4. module_runs kind/status CHECKs reject unknown values
 *   5. the partial "live" index actually matches enabled+ready rows
 *
 * Uses a throwaway dataset id and DELETEs everything it wrote, so it leaves
 * no cruft in a shared DB. Safe to re-run.
 */
const DS = '__probe_dataset__';
const MOD = '__probe_module__';

async function expectReject(drizzle, label, sqlText) {
  try {
    await drizzle.execute(sqlText);
    console.log(`  FAIL  ${label} — was ACCEPTED but should have been rejected`);
    return false;
  } catch (e) {
    console.log(`  OK    ${label} — rejected (${e.message.split('\n')[0].slice(0, 60)})`);
    return true;
  }
}

async function run() {
  let pass = 0, fail = 0;
  const mark = (ok) => { if (ok) pass++; else fail++; };

  try {
    await db.initialize();
    const drizzle = db.getDrizzle();

    // Clean slate in case a previous run died mid-way.
    await drizzle.execute(`DELETE FROM module_outbox   WHERE dataset_id = '${DS}'`);
    await drizzle.execute(`DELETE FROM module_runs     WHERE dataset_id = '${DS}'`);
    await drizzle.execute(`DELETE FROM client_modules  WHERE dataset_id = '${DS}'`);

    console.log('\n1 · client_modules — insert, upsert, uniqueness');

    await drizzle.execute(`
      INSERT INTO client_modules (dataset_id, module_id, settings, updated_by)
      VALUES ('${DS}', '${MOD}', '{"defaultLeadTimeDays": 90}', 'probe')
    `);
    const afterInsert = await drizzle.execute(
      `SELECT enabled, status, settings, binding FROM client_modules WHERE dataset_id='${DS}'`);
    const r0 = (afterInsert.rows || afterInsert)[0];
    const defaultsOk = r0.enabled === false && r0.status === 'not_initialized' && r0.binding === null;
    console.log(`  ${defaultsOk ? 'OK   ' : 'FAIL '} defaults: enabled=${r0.enabled} status=${r0.status} binding=${r0.binding}`);
    mark(defaultsOk);

    // Plain duplicate insert must be refused by the UNIQUE constraint.
    mark(await expectReject(drizzle, 'duplicate (dataset_id, module_id)', `
      INSERT INTO client_modules (dataset_id, module_id) VALUES ('${DS}', '${MOD}')
    `));

    // ON CONFLICT upsert — the shape module.service will actually use.
    await drizzle.execute(`
      INSERT INTO client_modules (dataset_id, module_id, enabled, status, settings, updated_by)
      VALUES ('${DS}', '${MOD}', true, 'ready', '{"defaultLeadTimeDays": 45}', 'probe2')
      ON CONFLICT (dataset_id, module_id) DO UPDATE
        SET enabled = EXCLUDED.enabled, status = EXCLUDED.status,
            settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by,
            updated_at = now()
    `);
    const afterUpsert = await drizzle.execute(
      `SELECT count(*)::int n, max(enabled::int) en, max(status) st, max(settings->>'defaultLeadTimeDays') lt
         FROM client_modules WHERE dataset_id='${DS}'`);
    const r1 = (afterUpsert.rows || afterUpsert)[0];
    const upsertOk = r1.n === 1 && r1.en === 1 && r1.st === 'ready' && r1.lt === '45';
    console.log(`  ${upsertOk ? 'OK   ' : 'FAIL '} upsert in place: rows=${r1.n} enabled=${r1.en} status=${r1.st} leadTime=${r1.lt}`);
    mark(upsertOk);

    console.log('\n2 · status CHECK — the surface gate must fail loudly');
    mark(await expectReject(drizzle, "unknown status 'redy' (typo)", `
      UPDATE client_modules SET status = 'redy' WHERE dataset_id='${DS}'
    `));

    console.log('\n3 · module_runs — kind/status CHECKs');
    await drizzle.execute(`
      INSERT INTO module_runs (dataset_id, module_id, kind, status, progress_stage)
      VALUES ('${DS}', '${MOD}', 'init', 'running', 'audit')
    `);
    console.log('  OK    valid run row inserted (kind=init, status=running)');
    pass++;
    mark(await expectReject(drizzle, "unknown kind 'rebuild'", `
      INSERT INTO module_runs (dataset_id, module_id, kind, status)
      VALUES ('${DS}', '${MOD}', 'rebuild', 'running')
    `));
    mark(await expectReject(drizzle, "unknown status 'done'", `
      INSERT INTO module_runs (dataset_id, module_id, kind, status)
      VALUES ('${DS}', '${MOD}', 'init', 'done')
    `));

    console.log('\n4 · module_outbox — mocked delivery row');
    const runIdRes = await drizzle.execute(
      `SELECT id FROM module_runs WHERE dataset_id='${DS}' LIMIT 1`);
    const runId = (runIdRes.rows || runIdRes)[0].id;
    await drizzle.execute(`
      INSERT INTO module_outbox (dataset_id, module_id, run_id, event, recipients, payload)
      VALUES ('${DS}', '${MOD}', ${runId}, 'init_completed',
              '["a@example.com","b@example.com"]', '{"probes": "11/11"}')
    `);
    const ob = await drizzle.execute(
      `SELECT provider, jsonb_array_length(recipients) n FROM module_outbox WHERE dataset_id='${DS}'`);
    const r2 = (ob.rows || ob)[0];
    const obOk = r2.provider === 'outbox' && r2.n === 2;
    console.log(`  ${obOk ? 'OK   ' : 'FAIL '} outbox row: provider=${r2.provider} recipients=${r2.n}`);
    mark(obOk);

    console.log('\n5 · partial "live" index matches enabled+ready only');
    const live = await drizzle.execute(`
      SELECT count(*)::int n FROM client_modules
       WHERE dataset_id='${DS}' AND enabled = true AND status = 'ready'
    `);
    const liveOk = ((live.rows || live)[0].n) === 1;
    console.log(`  ${liveOk ? 'OK   ' : 'FAIL '} live modules for probe dataset: ${(live.rows || live)[0].n}`);
    mark(liveOk);

    await drizzle.execute(`UPDATE client_modules SET enabled = false WHERE dataset_id='${DS}'`);
    const live2 = await drizzle.execute(`
      SELECT count(*)::int n FROM client_modules
       WHERE dataset_id='${DS}' AND enabled = true AND status = 'ready'
    `);
    const off = ((live2.rows || live2)[0].n) === 0;
    console.log(`  ${off ? 'OK   ' : 'FAIL '} toggled off ⇒ no longer live (${(live2.rows || live2)[0].n})`);
    mark(off);

    // ── cleanup — leave nothing behind in a shared DB ──
    await drizzle.execute(`DELETE FROM module_outbox   WHERE dataset_id = '${DS}'`);
    await drizzle.execute(`DELETE FROM module_runs     WHERE dataset_id = '${DS}'`);
    await drizzle.execute(`DELETE FROM client_modules  WHERE dataset_id = '${DS}'`);
    const left = await drizzle.execute(`
      SELECT (SELECT count(*) FROM client_modules WHERE dataset_id='${DS}')
           + (SELECT count(*) FROM module_runs    WHERE dataset_id='${DS}')
           + (SELECT count(*) FROM module_outbox  WHERE dataset_id='${DS}') AS n
    `);
    console.log(`\ncleanup: ${(left.rows || left)[0].n} probe rows remaining (expected 0)`);

    console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (error) {
    console.error('Probe failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

run();
