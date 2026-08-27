/**
 * Smart Replenishment — binding contract + DDL renderer battery (B1).
 *
 * Fully offline: no DB, no LLM, no network. Renders a ZolStock-shaped
 * fixture binding and asserts both that the output is STABLE (golden) and
 * that each ZS-2 correctness rule is actually present in the SQL — a golden
 * string alone would happily freeze a bug in place.
 *
 * Run: node scripts/test-replenishment-render.js
 */

const { validateBinding, isSafeIdentifier, isSafeRowFilter, THRESHOLDS } =
  require('../modules/replenishment/binding-contract');
const { renderInfra } = require('../modules/replenishment/render-infra');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  OK   ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}
function throws(label, fn, fragment) {
  try { fn(); console.log(`  FAIL ${label} — expected a throw`); fail++; }
  catch (e) {
    const m = !fragment || e.message.includes(fragment);
    if (m) { console.log(`  OK   ${label}`); pass++; }
    else { console.log(`  FAIL ${label} — threw "${e.message}"`); fail++; }
  }
}

/** The real ZolStock shape, as documented in agents/zolstock/AGENT.md. */
function zolstockBinding(overrides = {}) {
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
      store: {
        table: 'facts', rowFilter: "record_type = 'store_inventory'",
        qtyCol: 'store_inventory_qty', itemKey: 'sku',
      },
    },
    onOrder: {
      table: 'facts', rowFilter: "record_type = 'purchase_order'",
      qtyCol: 'purchase_order_qty', itemKey: 'sku', dateCol: 'row_date',
      unverified: true,
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
    coverage: { demandJoinRate: 0.999, replenishmentKeyRate: 0.049 },
    ...overrides,
  };
}

console.log('\n1 · Binding validation');
{
  const r = validateBinding(zolstockBinding());
  ok('the ZolStock fixture validates', r.valid, r.errors.join('; '));
}
{
  const b = zolstockBinding();
  delete b.demand.qtyCol;
  const r = validateBinding(b);
  ok('a missing required field is rejected',
    !r.valid && r.errors.some(e => e.includes('demand.qtyCol')), r.errors.join('; '));
}
{
  const b = zolstockBinding();
  delete b.stock.warehouse;
  ok('a missing warehouse stock grain is rejected', !validateBinding(b).valid);
}
{
  const b = zolstockBinding({ quirks: ['made_up_quirk'] });
  const r = validateBinding(b);
  ok('an unknown quirk is rejected',
    !r.valid && r.errors.some(e => e.includes('made_up_quirk')), r.errors.join('; '));
}
{
  const b = zolstockBinding();
  b.onOrder = { table: 'facts', qtyCol: 'x' };   // itemKey missing
  const r = validateBinding(b);
  ok('a half-declared optional section is rejected',
    !r.valid && r.errors.some(e => e.includes('onOrder')), r.errors.join('; '));
}
{
  const b = zolstockBinding();
  delete b.onOrder; delete b.committed; delete b.stock.store;
  ok('optional sections may be absent entirely', validateBinding(b).valid);
}

console.log('\n2 · Identifier and filter safety');
{
  ok('a plain identifier is accepted', isSafeIdentifier('item_number_sales'));
  ok('a quoted identifier is refused', !isSafeIdentifier('"UniqueInvoiceKey"'));
  ok('a dotted identifier is refused', !isSafeIdentifier('items.sku'));
  ok('an injection attempt is refused', !isSafeIdentifier('sku; DROP TABLE items'));
  ok('a leading digit is refused', !isSafeIdentifier('1sku'));
}
{
  ok('a normal row filter is accepted', isSafeRowFilter("record_type = 'sales'"));
  ok('a filter with a semicolon is refused', !isSafeRowFilter("x = 1; DROP TABLE items"));
  ok('a filter with a comment marker is refused', !isSafeRowFilter("x = 1 -- nope"));
  ok('a filter containing a subquery keyword is refused',
    !isSafeRowFilter("x IN (SELECT id FROM secrets)"));
  ok('an absent filter is fine', isSafeRowFilter(undefined));
}
{
  const b = zolstockBinding();
  b.demand.qtyCol = 'qty; DROP TABLE items';
  throws('the renderer refuses an unsafe identifier even if validation was skipped',
    () => renderInfra('zolstock', b), 'invalid binding');
}

console.log('\n3 · Rendered DDL — statement set and order');
const stmts = renderInfra('zolstock', zolstockBinding());
{
  ok('renders 7 statements', stmts.length === 7, String(stmts.length));
  ok('drops mv_suppliers before mv_replenishment_base (it depends on it)',
    /DROP .*mv_suppliers/.test(stmts[0]) && /DROP .*mv_replenishment_base/.test(stmts[1]));
  ok('creates the base view before the supplier view',
    /CREATE MATERIALIZED VIEW zolstock\.mv_replenishment_base/.test(stmts[2]) &&
    /CREATE MATERIALIZED VIEW zolstock\.mv_suppliers/.test(stmts[3]));
  ok('indexes come last', stmts.slice(4).every(s => /CREATE .*INDEX/.test(s)));
}

const base = stmts[2];
const suppliers = stmts[3];
const indexes = stmts.slice(4).join('\n');

console.log('\n4 · ZS-2 correctness rules are actually in the SQL');
{
  // Rule 1 — dedupe the catalog. The 44.6% inflation lesson.
  ok('catalog is deduped with GROUP BY, not a bare join',
    /catalog AS \([\s\S]*?GROUP BY sku/.test(base));
  ok('the demand bridge is deduped too',
    /bridge AS \([\s\S]*?GROUP BY item_number/.test(base));
  ok('catalog attributes use MAX(), not an arbitrary pick',
    /MAX\(item_name\) AS item_name/.test(base));
  ok('DISTINCT ON is never used (an untied one picks an arbitrary duplicate)',
    !/DISTINCT ON/i.test(base));
}
{
  // Rule 2 — anchor to the data, never the clock.
  ok('a data_through CTE exists', /data_through AS \(\s*SELECT MAX\(row_date\)/.test(base));
  ok('trailing windows measure back from data_through',
    /f\.row_date > dt\.data_through - INTERVAL '90 days'/.test(base));
  ok('CURRENT_DATE / now() appear nowhere',
    !/CURRENT_DATE|\bnow\(\)/i.test(base), 'the feed lags the calendar');
  ok('all three windows are rendered',
    ['28', '90', '365'].every(n => base.includes(`qty_sold_${n}d`)));
}
{
  // Rule 3 — two item keys, bridged.
  ok('demand joins through the bridge on the SALES key',
    /JOIN bridge br ON br\.item_number = f\.item_number_sales/.test(base));
  ok('stock joins on the REPLENISHMENT key',
    /warehouse_stock AS \([\s\S]*?w\.sku AS rkey/.test(base));
  ok('the two keys are never conflated',
    !/br\.item_number = f\.sku|w\.item_number_sales/.test(base));
}
{
  // Rule 4 — UNIQUE indexes for REFRESH … CONCURRENTLY.
  ok('mv_replenishment_base has a UNIQUE index on its grain',
    /CREATE UNIQUE INDEX[\s\S]*?mv_replenishment_base \(sku\)/.test(indexes));
  ok('mv_suppliers has a UNIQUE index on its grain',
    /CREATE UNIQUE INDEX[\s\S]*?mv_suppliers \(supplier\)/.test(indexes));
}
{
  ok('row filters are applied to each record kind',
    base.includes("record_type = 'sales'") &&
    base.includes("record_type = 'warehouse_inventory'") &&
    base.includes("record_type = 'purchase_order'") &&
    base.includes("record_type = 'customer_order'"));
  ok('missing joins default to 0 rather than NULL-poisoning arithmetic',
    /COALESCE\(ws\.warehouse_qty, 0\)/.test(base) && /COALESCE\(oo\.on_order_qty, 0\)/.test(base));
  ok('the supplier view is built ON the base view, not by re-scanning facts',
    /FROM zolstock\.mv_replenishment_base/.test(suppliers) && !/facts/.test(suppliers));
}

console.log('\n5 · Optional sections degrade cleanly');
{
  const b = zolstockBinding();
  delete b.onOrder; delete b.committed; delete b.stock.store;
  const only = renderInfra('zolstock', b);
  const baseOnly = only[2];
  ok('renders without the optional sections', only.length === 7, String(only.length));
  ok('the column list is unchanged (a stable view shape)',
    ['on_order_qty', 'committed_qty', 'store_qty_total', 'on_order_last_date']
      .every(c => baseOnly.includes(c)));
  ok('absent sections render typed constants, not joins',
    /0::numeric\s+AS on_order_qty/.test(baseOnly) && !/LEFT JOIN on_order/.test(baseOnly));
}
{
  const b = zolstockBinding();
  delete b.catalog.supplierCol;
  const noSupplier = renderInfra('zolstock', b);
  ok('no supplier column ⇒ no supplier view and no supplier index',
    !noSupplier.some(s => /mv_suppliers/.test(s) && /CREATE/.test(s)),
    String(noSupplier.length));
  ok('the base view still renders a typed NULL supplier column',
    /NULL::text AS supplier/.test(noSupplier[2]));
}

console.log('\n6 · Determinism (the property the golden test rests on)');
{
  const a = renderInfra('zolstock', zolstockBinding()).join('\n;\n');
  const c = renderInfra('zolstock', zolstockBinding()).join('\n;\n');
  ok('rendering twice produces byte-identical SQL', a === c);
  const other = renderInfra('otherclient', zolstockBinding()).join('\n;\n');
  ok('the schema name is the only thing that changes across clients',
    a.split('zolstock').join('X') === other.split('otherclient').join('X'));
}

console.log('\n7 · Thresholds are stated, not scattered');
{
  ok('demand join-rate threshold is defined', typeof THRESHOLDS.demandJoinRate === 'number');
  ok('…and is a demanding one', THRESHOLDS.demandJoinRate >= 0.95, String(THRESHOLDS.demandJoinRate));
  ok('replenishment-key threshold tolerates ZolStock\'s real 4.9% coverage',
    THRESHOLDS.replenishmentKeyRate < 0.049, String(THRESHOLDS.replenishmentKeyRate));
}

console.log(`\n─────────────────────\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
