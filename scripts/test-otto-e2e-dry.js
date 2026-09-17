#!/usr/bin/env node
/**
 * Otto end-to-end DRY RUN — the whole pipeline against a real dataset,
 * with ZERO writes to any table: brief (LLM) → brainstorm skipped (the
 * conversation is scripted) → plan (LLM) → spec (LLM, Opus) → compile +
 * execute (real queries, read-only) → probes.
 *
 *   node scripts/test-otto-e2e-dry.js <dataset> ["<request>"]
 *
 * This is the P3 gate of tasks/done/otto-intelligence-integration.md:
 * "a scripted end-to-end build of Safety Stock on zolstock passes probes" —
 * runnable before any module row exists, so testing costs three LLM calls
 * and no production state.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const datasetRegistry = require('../insights/datasets/registry');
const brief = require('../otto/services/brief.service');
const planService = require('../otto/services/plan.service');
const specService = require('../otto/services/spec.service');
const dataService = require('../otto/services/data.service');
const probesService = require('../otto/services/probes.service');

async function main() {
  const datasetId = process.argv[2];
  const request = process.argv[3]
    || 'I need a screen showing stock below the safety level: which items, at which stock points, how big the shortfall is, filterable by supplier. Add KPI cards for how many items are short and total units missing, and an export button.';
  if (!datasetId) {
    console.error('usage: node scripts/test-otto-e2e-dry.js <dataset> ["request"]');
    process.exit(1);
  }
  const entry = datasetRegistry.get(datasetId);
  if (!entry) { console.error(`unknown dataset: ${datasetId}`); process.exit(1); }

  await require('../services/db.pg').initialize();

  const ctx = {
    datasetId, moduleId: 'otto', schemaName: entry.schemaName,
    pool: entry.getPool(), settings: {},
  };

  const t0 = Date.now();
  console.log('— 1/5 audit —');
  const auditResult = await brief.audit(ctx);
  console.log(`   ${auditResult.relations.length} relations, manifest ${auditResult.hasManifest ? 'present' : 'ABSENT'} (${Date.now() - t0}ms)`);

  console.log('— 2/5 knowledge pass (LLM) —');
  let t = Date.now();
  // Same shape as the init orchestrator: a rejected proposal costs a round,
  // not the run, and the next round receives the exact failures.
  let theBrief = null;
  let previousFailures = [];
  for (let round = 1; round <= 3 && !theBrief; round++) {
    try {
      theBrief = await brief.proposeBrief({ ...ctx, audit: auditResult, round, previousFailures });
    } catch (err) {
      const failures = (err.bindingErrors || [err.message]).map(e => ({ probe: 'binding_shape', detail: e }));
      console.log(`   round ${round} rejected — retrying:`);
      for (const f of failures.slice(0, 8)) console.log(`     - ${f.detail}`);
      previousFailures = failures;
    }
  }
  if (!theBrief) throw new Error('brief did not converge in 3 rounds');
  console.log(`   sources: ${theBrief.sources.map(s => `${s.id}→${s.relation}${s.heavy ? '[heavy]' : ''}`).join(', ')}`);
  console.log(`   ${theBrief.fields.length} fields, ${theBrief.caveats.length} caveats, ${theBrief.starters.length} starters (${Date.now() - t}ms)`);
  const verification = await brief.verify({ ...ctx, binding: theBrief, verifySchema: entry.schemaName });
  const vFailed = verification.probes.filter(p => !p.passed);
  if (vFailed.length) {
    for (const p of vFailed) console.error(`   ✗ ${p.probe} — ${p.detail}`);
    throw new Error('brief verify failed');
  }
  console.log(`   verify: ${verification.probes.length}/${verification.probes.length} probes passed`);

  console.log('— 3/5 plan (LLM) —');
  t = Date.now();
  const messages = [
    { role: 'user', content: request },
    { role: 'assistant', content: 'Understood — I have what I need to plan the screen.' },
  ];
  const plan = await planService.draftPlan({ messages, brief: theBrief, settings: {} });
  console.log(`   "${plan.title.en}" — ${plan.columns.length} columns, ${plan.filters.length} filters, ${plan.kpis.length} KPIs (${Date.now() - t}ms)`);

  console.log('— 4/5 spec (LLM, build model) —');
  t = Date.now();
  const spec = await specService.buildSpec({ plan, brief: theBrief, settings: {} });
  console.log(`   ${spec.resultSets.length} result set(s), blocks: ${spec.blocks.map(b => b.kind).join(', ')} (${Date.now() - t}ms)`);

  console.log('— 5/5 execute + probes (real queries, read-only) —');
  t = Date.now();
  const payload = await dataService.executeSpec(spec, theBrief, ctx);
  for (const [id, set] of Object.entries(payload.resultSets)) {
    console.log(`   ${id}: ${set.rows.length} rows${set.truncated ? ' (truncated)' : ''}`);
  }
  for (const [k, v] of Object.entries(payload.kpis)) console.log(`   kpi ${k} = ${v}`);
  const result = probesService.verifyBuild(spec, payload);
  for (const p of result.probes.filter(x => !x.passed)) console.error(`   ✗ ${p.probe} — ${p.detail}`);
  console.log(`   probes: ${result.probes.filter(p => p.passed).length}/${result.probes.length} passed (${Date.now() - t}ms)`);

  console.log(result.passed ? '\nEND-TO-END DRY RUN: PASSED' : '\nEND-TO-END DRY RUN: FAILED');
  console.log(`total ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(result.passed ? 0 : 1);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  if (err.bindingErrors) console.error(err.bindingErrors);
  if (err.planErrors) console.error(err.planErrors);
  if (err.specErrors) console.error(err.specErrors);
  process.exit(1);
});
