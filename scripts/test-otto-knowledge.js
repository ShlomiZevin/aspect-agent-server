#!/usr/bin/env node
/**
 * Otto knowledge pass — REAL dataset battery (needs the DB via
 * cloud-sql-proxy, and an LLM key for the full run).
 *
 *   node scripts/test-otto-knowledge.js <dataset>            audit + validation only (no LLM)
 *   node scripts/test-otto-knowledge.js <dataset> --propose  full pass: audit → propose → verify
 *
 * Without --propose this exercises everything deterministic: the audit
 * against the live schema, and — when a brief is already stored on the
 * module row — re-validation of that brief against a FRESH audit plus the
 * live verify probes. That is the "names rot silently" check
 * (test-schema-contract's lesson) applied to Otto's brief.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const datasetRegistry = require('../insights/datasets/registry');
const brief = require('../otto/services/brief.service');
const moduleService = require('../modules/services/module.service');

async function main() {
  const datasetId = process.argv[2];
  const propose = process.argv.includes('--propose');
  if (!datasetId) {
    console.error('usage: node scripts/test-otto-knowledge.js <dataset> [--propose]');
    process.exit(1);
  }
  const entry = datasetRegistry.get(datasetId);
  if (!entry) {
    console.error(`unknown dataset: ${datasetId}`);
    process.exit(1);
  }

  const db = require('../services/db.pg');
  await db.initialize();

  const ctx = {
    datasetId,
    moduleId: 'otto',
    schemaName: entry.schemaName,
    pool: entry.getPool(),
    settings: {},
  };

  console.log(`— audit of ${entry.schemaName} —`);
  const auditResult = await brief.audit(ctx);
  console.log(`relations: ${auditResult.relations.length}${auditResult.relationsTruncated ? ' (truncated)' : ''}`);
  console.log(`manifest: ${auditResult.hasManifest ? 'present' : 'ABSENT — honest-refusal quality will be lower'}`);
  const heavy = auditResult.relations.filter(r => r.rows > brief.HEAVY_ROWS);
  for (const r of heavy) console.log(`heavy: ${r.name} (${r.kind}, ~${r.rows.toLocaleString()} rows)`);

  let candidate = null;
  if (propose) {
    console.log('\n— propose (LLM) —');
    const state = await moduleService.getForDataset(datasetId, 'otto');
    ctx.settings = state?.settings || {};
    ctx.audit = auditResult;
    candidate = await brief.proposeBrief(ctx);
    console.log(`sources: ${candidate.sources.map(s => `${s.id}→${s.relation}${s.heavy ? ' [heavy]' : ''}`).join(', ')}`);
    console.log(`fields: ${candidate.fields.length}, caveats: ${candidate.caveats.length}, starters: ${candidate.starters.length}`);
  } else {
    const state = await moduleService.getForDataset(datasetId, 'otto');
    if (state?.binding) {
      candidate = state.binding;
      console.log('\n— re-validating the STORED brief against a fresh audit —');
      const errors = brief.validateBrief(candidate, auditResult);
      if (errors.length) {
        console.error(`STALE BRIEF (${errors.length} problems):`);
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
      }
      console.log('structural validation: OK');
    } else {
      console.log('\nno stored brief and --propose not given — audit-only run complete.');
      process.exit(0);
    }
  }

  console.log('\n— verify probes against the live schema —');
  const verification = await brief.verify({ ...ctx, binding: candidate, verifySchema: entry.schemaName });
  const failed = verification.probes.filter(p => !p.passed);
  for (const p of verification.probes) {
    if (!p.passed) console.error(`  ✗ ${p.probe} — ${p.detail}`);
  }
  console.log(`${verification.probes.length - failed.length}/${verification.probes.length} probes passed`);
  const prose = brief.renderBriefForPrompt(candidate);
  console.log(`prompt size: ${prose.length} chars (budget ${brief.PROMPT_BUDGET_CHARS})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error('FAILED:', err.bindingErrors || err.message);
  process.exit(1);
});
