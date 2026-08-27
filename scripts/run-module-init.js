/**
 * Run a module's init pipeline for a dataset — the same thing the admin tab's
 * "Init infrastructure" button does, from the command line.
 *
 *   node scripts/run-module-init.js zolstock replenishment
 *
 * Exists because the C1 gate needs the converged binding and the per-round
 * report in a form a human can read and compare, and because a 20-minute
 * pipeline is easier to run and re-run here than through a browser.
 *
 * Makes a REAL LLM call (the binding proposal) and builds REAL views in a
 * scratch schema, which is dropped afterwards. Nothing is written to the live
 * schema.
 */

require('dotenv').config();
const db = require('./../services/db.pg');
const moduleService = require('../modules/services/module.service');
const initService = require('../modules/services/module-init.service');

const datasetId = process.argv[2] || 'zolstock';
const moduleId = process.argv[3] || 'replenishment';

(async () => {
  await db.initialize();

  // Minimum settings a real operator would fill in on the Settings modal.
  // Everything else resolves from the descriptor's code defaults.
  await moduleService.saveSettings(datasetId, moduleId, {
    notificationEmails: ['kosta@aspect.local'],
    initModel: 'claude-sonnet-4-6',
  }, 'c1-gate');

  const before = await moduleService.getForDataset(datasetId, moduleId);
  console.log(`\n${datasetId}/${moduleId}: status=${before.status} enabled=${before.enabled} live=${before.live}`);
  console.log(`missing required settings: ${before.missingRequired.length ? before.missingRequired.join(', ') : '(none)'}\n`);

  console.log('Starting init (audit -> propose -> build -> verify, up to 5 rounds)...');
  const started = Date.now();
  const res = await initService.startInit(datasetId, moduleId, { updatedBy: 'c1-gate', await: true });
  if (res.error) { console.error(`REFUSED: ${res.error}`); process.exit(1); }

  const run = await initService.getRun(res.runId);
  const mins = ((Date.now() - started) / 60000).toFixed(1);

  console.log(`\n=== run #${run.id} — ${run.status} (${mins} min) ===\n`);
  for (const r of run.rounds || []) {
    console.log(`Round ${r.round}: ${r.passed ? 'PASSED' : 'failed'}`);
    for (const p of r.probes || []) {
      console.log(`   ${p.passed ? '+' : '-'} ${String(p.probe).padEnd(26)} ${p.detail || ''}`);
    }
    console.log('');
  }

  const after = await moduleService.getForDataset(datasetId, moduleId);
  console.log(`status=${after.status} enabled=${after.enabled} live=${after.live}`);
  console.log(`\n--- CONVERGED BINDING ---\n${JSON.stringify(after.binding, null, 2)}`);
  if (run.report?.reason) console.log(`\nreason: ${run.report.reason}`);

  process.exit(run.status === 'succeeded' ? 0 : 1);
})().catch(err => { console.error('init failed:', err.message); console.error(err); process.exit(1); });
