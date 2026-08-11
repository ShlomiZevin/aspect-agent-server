/**
 * Renders the suite-results-*.json files produced by test-insights-suite.js
 * into a reviewable report: one line per case, then every figure that failed
 * its independent re-check, with reported vs actual side by side.
 *
 * Usage: node scripts/summarize-insights-suite.js [--full]
 */
const fs = require('fs');
const path = require('path');

const full = process.argv.includes('--full');
const dir = path.join(__dirname, '..');
const files = fs.readdirSync(dir).filter(f => /^suite-results-.*\.json$/.test(f));

const fmt = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
let totCases = 0, totErr = 0, totMismatch = 0, totChecked = 0, totMatched = 0, totUnverifiable = 0;

for (const file of files.sort()) {
  const rows = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const ds = file.replace('suite-results-', '').replace('.json', '');
  console.log(`\n${'═'.repeat(100)}\n${ds.toUpperCase()}  (${rows.length} cases)\n${'═'.repeat(100)}`);

  for (const r of rows) {
    totCases++;
    if (r.error) {
      totErr++;
      console.log(`\n[${r.level}] "${r.prompt}"\n   ❌ ERROR: ${r.error}`);
      continue;
    }
    const checked = (r.checks || []).filter(c => c.verdict !== 'n/a');
    const bad = (r.checks || []).filter(c => c.verdict === 'MISMATCH');
    const na = (r.checks || []).filter(c => c.verdict === 'n/a');
    totChecked += checked.length;
    totMatched += checked.length - bad.length;
    totMismatch += bad.length;
    totUnverifiable += na.length;

    const status = bad.length ? `❌ ${bad.length} MISMATCH` : (checked.length ? `✅ ${checked.length}/${checked.length} verified` : '⚠️  nothing auto-verifiable');
    console.log(`\n[${r.level}] "${r.prompt}"`);
    console.log(`   ${status} · ${r.seconds}s · conf ${r.confidence} (model asked ${r.claimed}, ceiling ${r.ceiling}) · sql=${r.sqlConfidence} · verify=${r.verified ? 'pass' : 'FAIL'} · tag=${r.tag}`);
    console.log(`   headline: ${r.headline}`);
    console.log(`   impact:   ${r.impact}`);
    if (r.aggregation) {
      console.log(`   rows=${r.aggregation.rowCount} groupedBy=[${(r.aggregation.groupedBy || []).join(', ')}] groups=${r.aggregation.distinctGroups} shown=${r.aggregation.sampleShown} collapsed=[${(r.aggregation.collapsedColumns || []).join(', ')}]`);
    }
    if (!r.verified && r.issues?.length) console.log(`   verifier: ${r.issues.join(' | ')}`);

    if (bad.length) {
      console.log(`   ┌─ FIGURES THAT DISAGREE WITH RE-QUERIED DATA`);
      for (const b of bad) {
        console.log(`   │ ${b.kind} "${b.label}": reported ${b.value}  ·  actual ${fmt(b.actual)}  ·  off by ${(b.err * 100).toFixed(1)}%`);
      }
      console.log(`   └─`);
    }
    if (full) {
      for (const c of (r.checks || [])) {
        console.log(`     ${c.verdict.padEnd(8)} ${c.kind}/${c.label}: ${c.value} vs ${fmt(c.actual)}${c.note ? ' (' + c.note + ')' : ''}`);
      }
    }
  }
}

console.log(`\n${'═'.repeat(100)}`);
console.log(`TOTAL: ${totCases} cases · ${totErr} errored · ${totChecked} figures auto-verified · ${totMatched} matched · ${totMismatch} MISMATCHED · ${totUnverifiable} not auto-checkable`);
console.log('═'.repeat(100));
