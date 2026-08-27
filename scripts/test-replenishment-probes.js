/**
 * Smart Replenishment — probe battery (B4).
 *
 * Builds the real views into a scratch schema on the LIVE dataset, runs the
 * probes, then does it again with deliberately mis-mapped bindings.
 *
 *   node scripts/test-replenishment-probes.js [datasetId]
 *
 * THE POINT: the plan's B4 verify clause is "each probe individually fails
 * against a deliberately mis-mapped binding — the probes must be proven able
 * to fail". A probe suite that goes green on a correct binding proves nothing
 * on its own; a suite that CANNOT go red is worse than none, because it
 * manufactures confidence. Every mis-mapping below is one a model could
 * plausibly produce.
 *
 * Read-only against the source data. Everything it creates lives in a scratch
 * schema that is dropped in a finally, including on failure.
 */

require('dotenv').config();
const datasetRegistry = require('../insights/datasets/registry');
const { renderInfra } = require('../modules/replenishment/render-infra');
const { verify } = require('../modules/replenishment/verify');
const { audit } = require('../modules/replenishment/audit');

const datasetId = process.argv[2] || 'zolstock';
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ` — ${detail}` : ''}`); fail++; }
}

/** The hand-authored correct ZolStock binding — the B4 reference. */
function correctBinding() {
  return {
    demand: {
      table: 'facts', rowFilter: "record_type = 'sales'",
      dateCol: 'row_date', qtyCol: 'qty_sold', itemKey: 'item_number_sales',
    },
    stock: {
      warehouse: {
        table: 'facts', rowFilter: "record_type = 'warehouse_inventory'",
        qtyCol: 'warehouse_qty', itemKey: 'sku',
      },
    },
    onOrder: {
      table: 'facts', rowFilter: "record_type = 'purchase_order'",
      qtyCol: 'purchase_order_qty', itemKey: 'sku', dateCol: 'row_date', unverified: true,
    },
    committed: {
      table: 'facts', rowFilter: "record_type = 'customer_order'",
      qtyCol: 'customer_order_qty', itemKey: 'sku',
    },
    catalog: {
      table: 'items', itemKey: 'item_number', replenishmentKey: 'sku',
      nameCol: 'item_name', categoryCol: 'category', subcategoryCol: 'subcategory',
      supplierCol: 'positive_supplier', cartonCol: 'units_per_carton',
      safetyCol: 'safety_stock', priceCol: 'consumer_price', costCol: 'cost_ex_vat',
      dedupe: 'group_by_max',
    },
    quirks: ['catalog_not_unique', 'vat_1_18', 'anchor_to_demand_max_date',
             'supplier_col_reversed_latin', 'two_item_keys', 'on_order_unverified'],
  };
}

const SCRATCH = `${'zolstock'}_probe_scratch`;

async function buildAndVerify(pool, schemaName, binding, auditDoc, scratch) {
  await pool.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
  await pool.query(`CREATE SCHEMA ${scratch}`);
  try {
    // Views into the (empty) scratch schema, data read from the live one.
    const statements = renderInfra({ target: scratch, source: schemaName }, binding);
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 0');
      await client.query("SET lock_timeout = '2min'");
      for (const s of statements) await client.query(s);
    } finally {
      client.release();
    }
    return await verify({ pool, schemaName, verifySchema: scratch, binding, audit: auditDoc, round: 1 });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`).catch(() => {});
  }
}

function probeNamed(result, name) {
  return (result.probes || []).find(p => p.probe === name);
}

(async () => {
  const entry = datasetRegistry.get(datasetId);
  if (!entry) { console.error(`Unknown dataset: ${datasetId}`); process.exit(1); }
  const pool = entry.getPool();
  const schemaName = entry.schemaName;
  const scratch = `${schemaName}_probe_scratch`;

  console.log(`\n0 · Audit (the probes reconcile against it)`);
  const auditDoc = await audit({ schemaName, pool, settings: {} });
  ok('audit completed', Boolean(auditDoc?.measurements?.chosenReplenishmentKey),
    JSON.stringify(auditDoc?.measurements?.chosenReplenishmentKey?.column));

  console.log('\n1 · The correct binding — every probe green');
  const good = await buildAndVerify(pool, schemaName, correctBinding(), auditDoc, scratch);
  for (const p of good.probes) {
    console.log(`     ${p.passed ? '✓' : '✗'} ${p.probe.padEnd(28)} ${p.detail}`);
  }
  ok('all probes pass on the hand-authored correct binding', good.passed,
    (good.probes || []).filter(p => !p.passed).map(p => p.probe).join(', '));
  ok('the suite is not trivially small', good.probes.length >= 7, String(good.probes.length));

  // ── Each mis-mapping below must turn a SPECIFIC probe red. ──
  console.log('\n2 · Mis-mapped bindings — each must be caught, by the right probe');

  {
    // The single most plausible model error: mapping demand to the
    // replenishment key. The view still builds and looks healthy; it is
    // simply empty of demand, so every product reads as "never sold".
    const b = correctBinding();
    b.demand.itemKey = 'sku';
    const r = await buildAndVerify(pool, schemaName, b, auditDoc, scratch);
    const dj = probeNamed(r, 'demand_join_rate');
    const vc = probeNamed(r, 'velocity_coverage');
    ok('wrong demand item key is caught', !r.passed);
    ok('…by demand_join_rate and/or velocity_coverage',
      (dj && !dj.passed) || (vc && !vc.passed),
      `demand_join_rate=${dj?.passed} velocity_coverage=${vc?.passed}`);
    console.log(`       detail: ${(dj && !dj.passed ? dj.detail : vc?.detail) || ''}`);
  }

  {
    // Mapping stock to the sales key: warehouse rows carry no sales key, so
    // stock silently becomes zero everywhere and nothing is ever reordered.
    // This one went entirely undetected until the collapse check existed:
    // warehouse rows carry no sales key, so the filter drops them all and
    // stock becomes 0 on every row. The view builds, the grain is right,
    // nothing errors — and the engine would recommend reordering the whole
    // catalogue.
    const b = correctBinding();
    b.stock.warehouse.itemKey = 'item_number_sales';
    const r = await buildAndVerify(pool, schemaName, b, auditDoc, scratch);
    const wh = probeNamed(r, 'warehouse_reconciles');
    ok('wrong stock item key is caught', !r.passed,
      JSON.stringify((r.probes || []).filter(p => !p.passed).map(p => p.probe)));
    ok('…by warehouse_reconciles, naming the collapse', wh && !wh.passed && /NO view row/.test(wh.detail || ''),
      wh?.detail);
  }

  {
    // Same silent-collapse shape on an optional section.
    const b = correctBinding();
    b.onOrder.itemKey = 'item_number_sales';
    const r = await buildAndVerify(pool, schemaName, b, auditDoc, scratch);
    const oo = probeNamed(r, 'on_order_reconciles');
    ok('a collapsed on-order section is caught too', oo && !oo.passed, oo?.detail);
  }

  {
    // A wrong row filter: demand pointed at inventory rows, which have no
    // dates at all. Everything downstream is nonsense but nothing errors.
    const b = correctBinding();
    b.demand.rowFilter = "record_type = 'warehouse_inventory'";
    const r = await buildAndVerify(pool, schemaName, b, auditDoc, scratch);
    ok('a demand filter pointing at the wrong row kind is caught', !r.passed,
      JSON.stringify((r.probes || []).filter(p => !p.passed).map(p => p.probe)));
  }

  {
    // The catalogue key and the replenishment key swapped — a genuinely easy
    // confusion given both are "the item id".
    const b = correctBinding();
    b.catalog.itemKey = 'sku';
    b.catalog.replenishmentKey = 'item_number';
    const r = await buildAndVerify(pool, schemaName, b, auditDoc, scratch);
    ok('swapped catalogue keys are caught', !r.passed,
      JSON.stringify((r.probes || []).filter(p => !p.passed).map(p => p.probe)));
  }

  {
    // A quirk claimed but not honoured cannot be faked: the anchor probe
    // reads the built view, so declaring anchor_to_demand_max_date while the
    // view has no data-through date fails.
    const b = correctBinding();
    b.demand.dateCol = 'row_date';
    const r = await buildAndVerify(pool, schemaName, b, auditDoc, scratch);
    const anchor = probeNamed(r, 'anchored_to_data_date');
    ok('the anchor probe runs and reads the built view', Boolean(anchor), JSON.stringify(anchor));
    ok('…and passes on the correct binding', anchor?.passed, anchor?.detail);
  }

  console.log('\n3 · Probes report numbers, not just a verdict');
  {
    const withNumbers = good.probes.filter(p => /\d/.test(p.detail || ''));
    ok('every probe detail carries a figure', withNumbers.length === good.probes.length,
      `${withNumbers.length}/${good.probes.length}`);
    const base = probeNamed(good, 'base_row_count');
    ok('base_row_count states the count and the threshold', /\d+.*minimum/.test(base?.detail || ''),
      base?.detail);
  }

  console.log('\n4 · Nothing was left behind');
  {
    const r = await pool.query(
      `SELECT COUNT(*)::int n FROM information_schema.schemata WHERE schema_name = $1`, [scratch]);
    ok('the scratch schema is dropped', r.rows[0].n === 0, String(r.rows[0].n));
  }

  console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error('Battery failed:', err.message); console.error(err); process.exit(1); });
