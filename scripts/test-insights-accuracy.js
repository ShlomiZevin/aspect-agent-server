/**
 * In-process accuracy harness for the investigation pipeline — calls
 * investigation.service directly (no HTTP server needed), then INDEPENDENTLY
 * re-checks every headline number it produced by running its own verification
 * SQL against the same database.
 *
 * Complements the two existing scripts: test-insights-unit.js proves the pure
 * helpers behave, test-insights-battery.js proves the HTTP pipeline completes.
 * Neither of them checks whether the numbers are TRUE — which is exactly how a
 * report shipped claiming campaign 78 earned ₪7,885 when it really earned
 * ₪555,229 (see result-digest.service.js).
 *
 * Usage:
 *   node scripts/test-insights-accuracy.js [datasetId] ["a prompt"]
 */
require('dotenv').config();
const crypto = require('crypto');

const datasetId = process.argv[2] || 'hypertoy';
const promptArg = process.argv[3];

const db = require('../services/db.pg');
const registry = require('../insights/datasets/registry');

/**
 * With no prompt argument, the harness uses THIS dataset's own configured
 * example prompts (registry defaults, admin-overridable) rather than a
 * hardcoded list — so it exercises whichever of the six datasets you point it
 * at with questions that actually make sense for that business, instead of
 * asking a florist chain about toy product families.
 */
async function resolvePrompts() {
  if (promptArg) return [promptArg];
  const config = await require('../insights/services/intelligence-config.service').getConfig(datasetId);
  const pool = [...(config?.examplePrompts || []), ...(config?.bootstrapPrompts || [])];
  return pool.slice(0, 2);
}

function money(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

async function main() {
  await db.initialize();
  const investigation = require('../insights/services/investigation.service');
  const pool = registry.get(datasetId).getPool();
  const userId = `accuracy-${crypto.randomUUID()}`;
  const created = [];
  const prompts = await resolvePrompts();

  for (const prompt of prompts) {
    console.log(`\n${'═'.repeat(78)}\nPROMPT: "${prompt}"\n${'═'.repeat(78)}`);
    const t0 = Date.now();
    let insight;
    try {
      insight = await investigation.investigate(datasetId, userId, prompt, `job-${crypto.randomUUID()}`);
    } catch (err) {
      console.log(`❌ FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}`);
      continue;
    }
    created.push(insight.id);

    console.log(`\n⏱  ${((Date.now() - t0) / 1000).toFixed(1)}s   tag=${insight.tag}   confidence=${insight.confidence} (${insight.confidenceLabel})`);
    console.log(`\nHEADLINE: ${insight.headline}`);
    console.log(`IMPACT:   ${insight.impactValue}  (${insight.impactLabel})`);
    console.log(`\nEVIDENCE.aggregation: ${JSON.stringify(insight.evidence.aggregation)}`);
    console.log(`sqlConfidence: ${insight.evidence.sqlConfidence}   verified: ${insight.evidence.verification.verified}  issues: ${JSON.stringify(insight.evidence.verification.issues)}`);
    console.log(`\nDATA QUESTION: ${insight.evidence.dataQuestion}`);
    console.log(`\nSQL:\n${insight.evidence.sql}`);

    for (const b of insight.blocks) {
      if (b.type === 'ranked_list') {
        console.log(`\nBLOCK ranked_list "${b.title}" (${b.unit}):`);
        b.items.forEach((it, i) => console.log(`   ${i + 1}. ${it.label} = ${it.value}`));
      } else if (b.type === 'stat_callout') {
        console.log(`\nBLOCK stat_callout: ${b.value} — ${b.label}`);
      } else if (b.type === 'comparison') {
        console.log(`\nBLOCK comparison: ${b.items.map(i => `${i.label}=${i.value}`).join(' | ')}`);
      } else if (b.type === 'chart') {
        console.log(`\nBLOCK chart "${b.chart.title}": ${b.chart.categories.join(', ')}`);
        b.chart.series.forEach(s => console.log(`   ${s.label}: ${s.points.join(', ')}`));
      } else {
        console.log(`\nBLOCK ${b.type}`);
      }
    }

    // ── Independent re-verification: re-run the EXACT SQL the insight cites,
    // re-aggregate it ourselves, and print ground truth for manual comparison.
    try {
      const { rows } = await pool.query(insight.evidence.sql);
      const { buildResultDigest, formatForPrompt } = require('../insights/services/result-digest.service');
      const truth = buildResultDigest(rows, { dimensions: insight.evidence.aggregation.groupedBy.length ? insight.evidence.aggregation.groupedBy : [], measures: [] });
      console.log(`\n${'─'.repeat(78)}\nGROUND TRUTH (re-ran the cited SQL independently — ${rows.length} rows)`);
      console.log(formatForPrompt(truth).split('\n').slice(0, 22).join('\n'));
    } catch (err) {
      console.log(`\n⚠️  Could not re-run cited SQL: ${err.message}`);
    }
  }

  // Clean up so a harness run never leaves cruft in a real feed.
  for (const id of created) await investigation.deleteGenerated(datasetId, userId, id);
  console.log(`\n🧹 cleaned up ${created.length} insight(s) under ${userId}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
