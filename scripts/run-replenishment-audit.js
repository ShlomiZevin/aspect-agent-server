/**
 * Run the Smart Replenishment audit against a live dataset — READ-ONLY.
 *
 *   node scripts/run-replenishment-audit.js zolstock
 *   node scripts/run-replenishment-audit.js zolstock --format=hebrew
 *   node scripts/run-replenishment-audit.js zolstock --save
 *
 * `--save` writes the raw JSON into verification/modules-replenishment/.
 * The same audit runs as step 1 of the init pipeline; this script exists so a
 * human can read the numbers before anything is built on them — which is the
 * whole point of the C1 gate.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const datasetRegistry = require('../insights/datasets/registry');
const { audit, renderHebrewGapReport } = require('../modules/replenishment/audit');

const datasetId = process.argv[2] || 'zolstock';
const hebrew = process.argv.includes('--format=hebrew');
const save = process.argv.includes('--save');

function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-GB') : String(n);
}
function pct(v) {
  return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

(async () => {
  const entry = datasetRegistry.get(datasetId);
  if (!entry) {
    console.error(`Unknown dataset: ${datasetId}`);
    process.exit(1);
  }

  const findings = await audit({
    schemaName: entry.schemaName,
    pool: entry.getPool(),
    settings: {},
  });

  if (hebrew) {
    console.log(renderHebrewGapReport(findings));
  } else {
    const m = findings.measurements;
    console.log(`\n=== Replenishment audit — ${findings.schema} ===\n`);

    console.log(`Detected fact table   : ${m.detected?.factTable?.name} (~${fmt(m.detected?.factTable?.approxRows)} rows)`);
    console.log(`Detected catalogue    : ${m.detected?.catalogTable?.name} (~${fmt(m.detected?.catalogTable?.approxRows)} rows)`);

    if (m.discriminator) {
      console.log(`\nRow kinds (${m.discriminator.column}):`);
      for (const v of m.discriminator.values) console.log(`  ${String(v.value).padEnd(22)} ${fmt(v.rows)}`);
    }

    if (m.rowKinds) {
      console.log('\nDate coverage per row kind:');
      for (const k of m.rowKinds) {
        const range = k.datedRows ? `${String(k.from).slice(0, 10)} → ${String(k.to).slice(0, 10)}` : 'NO DATES';
        console.log(`  ${String(k.kind).padEnd(22)} ${String(fmt(k.rows)).padStart(12)}  ${range}`);
      }
    }

    if (m.supplierColumns?.length) {
      console.log('\nSupplier-like columns:');
      for (const c of m.supplierColumns) {
        console.log(`  ${c.column.padEnd(22)} populated ${pct(c.coverage).padStart(7)}  distinct ${fmt(c.distinctValues)}`);
      }
    }

    if (m.replenishmentKeyColumns?.length) {
      console.log('\nReplenishment-key candidates (ranked by MEASURED join rate to stock rows):');
      for (const c of m.replenishmentKeyColumns) {
        const j = c.joinRate === null ? '  n/a  ' : pct(c.joinRate).padStart(7);
        console.log(`  ${c.column.padEnd(22)} populated ${pct(c.coverage).padStart(7)}  joins-to-stock ${j}` +
          (c.joinedRows !== null ? `  (${fmt(c.joinedRows)} of ${fmt(c.stockRows)} stock rows)` : ''));
      }
    }

    for (const [label, key] of [['Safety stock', 'safetyStock'], ['Carton size', 'unitsPerCarton']]) {
      const cols = m[key] || [];
      console.log(`\n${label}:`);
      if (!cols.length) console.log('  (no such column)');
      for (const c of cols) console.log(`  ${c.column.padEnd(22)} populated ${pct(c.coverage).padStart(7)}  ${fmt(c.nonNull)} of ${fmt(c.total)}`);
    }

    console.log(`\nGoods-receipt evidence: ${m.goodsReceiptEvidence?.length ? m.goodsReceiptEvidence.join(', ') : 'NONE FOUND'}`);

    if (m.supplierSummary) {
      console.log(`\nSuppliers listed (top 50): ${m.supplierSummary.totalSuppliersListed}`);
      console.log(`  …with at least one keyed item: ${m.supplierSummary.suppliersWithAnyKeyedItem}`);
    }
    if (m.chosenReplenishmentKey) {
      console.log(`\nChosen replenishment key: ${m.chosenReplenishmentKey.column} ` +
        `(join rate ${pct(m.chosenReplenishmentKey.joinRate)} against "${m.chosenReplenishmentKey.measuredAgainstKind}", ` +
        `populated ${pct(m.chosenReplenishmentKey.coverage)} of the catalogue)`);
    }
    if (m.keyJoinRateByRowKind?.length) {
      console.log('\nHow the chosen key behaves per row kind:');
      console.log(`  ${'kind'.padEnd(22)} ${'rows'.padStart(12)} ${'has code'.padStart(9)} ${'resolves'.padStart(9)}`);
      for (const k of m.keyJoinRateByRowKind) {
        console.log(`  ${String(k.kind).padEnd(22)} ${String(fmt(k.rows)).padStart(12)} ` +
          `${pct(k.keyPresentRate).padStart(9)} ${pct(k.joinRateAmongKeyed).padStart(9)}`);
      }
    }
    if (m.perSupplier?.length) {
      console.log('\nTop suppliers by keyed items (using the chosen key):');
      for (const s of m.perSupplier.slice(0, 12)) {
        console.log(`  ${String(s.supplier).slice(0, 34).padEnd(36)} ${String(fmt(s.itemsWithKey)).padStart(7)} keyed / ${String(fmt(s.items)).padStart(7)} items  (${pct(s.keyCoverage)})`);
      }
    }

    if (m.coverage) {
      console.log(`\nData through: ${m.coverage.dataThrough || 'n/a'}${m.coverage.partialLastDay ? '  ⚠ last day looks PARTIAL' : ''}`);
    }

    console.log(`\n--- GAPS (${findings.gaps.length}) ---`);
    for (const g of findings.gaps) console.log(`\n[${g.code}] ${g.title}\n      ${g.detail}`);
    console.log('');
  }

  if (save) {
    const dir = path.join(__dirname, '..', 'verification', 'modules-replenishment');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `audit-${datasetId}-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(file, JSON.stringify(findings, null, 2), 'utf8');
    console.error(`saved ${file}`);
  }

  process.exit(0);
})().catch(err => { console.error('Audit failed:', err.message); console.error(err); process.exit(1); });
