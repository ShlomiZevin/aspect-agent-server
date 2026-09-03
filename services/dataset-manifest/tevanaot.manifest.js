/**
 * Teva Naot capability manifest — the truth card.
 *
 * Teva Naot (טבע נאות) — Israeli footwear retail. QlikSense star-schema export;
 * the sales fact is a synthetic composite key resolved once into tevanaot.mv_sales.
 *
 * Evidence base — PRE client-reconciliation (no comparison against Teva Naot's
 * own reporting has been run yet; fidelities below describe how the number is
 * BUILT, not how far it sits from the client's dashboard):
 *  - 2026-06 data validation: revenue / units / quarters / monthly trend all
 *    internally consistent and mutually reconciling; Excel-serial date epoch
 *    (1899-12-30) verified; the attribute-breakdown fan-out was found and fixed
 *    with mv_parts_dim (gender breakdown went from ₪2.18B to a reconciling
 *    ₪45.7M / 179,075 units).
 *  - 2026-09-03 reload: 2.65M resolved sales lines, mv_sales spans 2022-11 to
 *    2026-09-03. (The TEVANAOT_IMPORT_MONTHS=5 window does NOT apply here — the
 *    raw sales rows carry no scannable date column, so all history loads.)
 *
 * Update triggers: a new export arrives, the import window changes, a
 * reconciliation against Teva Naot's own reporting is run, or a customer
 * correction is confirmed. scripts/test-schema-contract.js fails the build if a
 * relation named here stops existing.
 */

module.exports = {
  id: 'tevanaot',

  // No single VAT factor is declared. The POS export carries sales_ex_vat AND
  // sales_inc_vat on every line straight from the till, and vat_pct varies by
  // store (Eilat branches are VAT-exempt). Revenue is reported on whichever
  // basis the user asks for, exact, with no derivation — so there is nothing
  // for a vatRate to feed.

  measures: {
    'revenue ex-VAT': { fidelity: 'exact', basis: 'SUM(sales_ex_vat) on mv_sales, or SUM(revenue_ex_vat) on mv_sales_daily — the ex-VAT amount recorded on each POS line, not derived' },
    'revenue inc-VAT': { fidelity: 'exact', basis: 'SUM(sales_inc_vat) — the actual till amount including VAT, recorded per line; the blended inc-to-ex ratio is ~1.13 because Eilat stores are VAT-exempt' },
    'units sold': { fidelity: 'exact', basis: 'SUM(qty_sold) on mv_sales; qty_sold is NEGATIVE on returns, so the sum is NET of returns' },
    'transactions': { fidelity: 'exact', basis: 'COUNT(DISTINCT invoice_number) on mv_sales — invoice_number is a real POS receipt id' },
    'average basket': { fidelity: 'exact', basis: 'revenue divided by distinct invoice_number, over a dated window' },
    'inventory on hand': { fidelity: 'exact', basis: 'SUM(inventory_balance) units / SUM(inventory_value) shekels on the inventory table — a CURRENT snapshot with no date history' },
    'end-of-month inventory': { fidelity: 'exact', basis: 'inventory_in_date, keyed by month-end' },
    'customer orders': { fidelity: 'exact', basis: 'orders table, dated (order_qty, order_total_ex_vat, order_status)' },
    'purchase orders': { fidelity: 'exact', basis: 'purchase_orders table (po_qty, po_remaining_to_supply, po_status)' },
    'profit / margin': { fidelity: 'absent', basis: 'no cost-of-goods figure exists on the sales line. parts.consumer_price is a retail price and inventory.cost_price is a stock-valuation cost — neither is COGS for a sold unit, so margin cannot be computed from this export' },
  },

  dimensions: {
    'date': { status: 'available', detail: 'mv_sales.transaction_date, resolved from the Qlik Excel serial (epoch 1899-12-30, verified). History runs from ~2022-11, so year-on-year comparisons are possible. Verify the latest day is not partial before quoting a "today" figure.' },
    'store / branch': { status: 'available', detail: 'mv_sales.warhs joined to sites (unique per warhs). warhs = 0 is a non-retail / HQ bucket (no sites row, net units go NEGATIVE from return-only activity) — exclude it from store rankings. A raw "top stores" list also mixes in warehouses and the website channel; filter on the sites row when the question means retail branches.' },
    'product / model / colour': { status: 'available', detail: 'join the pre-deduplicated dimension mv_parts_dim on part (part is the model-colour grain). Model rollup groups by model_code, model_name. NEVER SUM after joining raw parts — one parts row per size fans measures out 16-50x.' },
    'model attributes': { status: 'available', detail: 'colour, gender, shoe_type, marketing_shoe_type, product_line, collection, season, family_description, budget_line, quality — all on mv_parts_dim. A blank model_name bucket (accessories, shoe-care) legitimately tops volume rankings; flag it when it appears.' },
    'size': { status: 'available', detail: 'size is a size-level attribute on raw parts, NOT on mv_parts_dim — a size breakdown must join parts and cannot reuse the deduped dimension.' },
    'supplier': { status: 'unreliable', detail: 'only ~4% of products carry a supplier (4,511 of 113,235 on mv_parts_dim; the standalone suppliers table has 3 rows). A supplier ranking is dominated by a 108,724-row unidentified bucket — usable only for the handful of named suppliers, and that gap must be stated.' },
    'customer': { status: 'available', detail: 'customers table joined on cust, but most retail POS lines carry no customer id — customer analysis covers only identified (largely wholesale / club) buyers.' },
  },

  dataFacts: [
    { fact: 'warhs = 0 is a non-retail bucket (no store row, net units go negative) that carries ~6M shekel of return/adjustment activity — exclude it from any store ranking', appliesTo: 'store rankings' },
    { fact: 'A blank model_name bucket (accessories / shoe-care) legitimately leads volume rankings — flag it as a catch-all when it appears in a top-N', appliesTo: 'model / product rankings' },
    { fact: 'Eilat stores are VAT-exempt, so the blended inc-VAT to ex-VAT ratio is ~1.13, not the mainland 1.17-1.18 — read the column the user asked for, never derive one basis from the other', appliesTo: 'any revenue figure where the VAT basis matters' },
    { fact: '"Open orders" has no agreed definition in this export; the closest proxy is order_status <> cancelled, which returns ~1M rows — state which rule was used', appliesTo: 'open / outstanding order counts' },
  ],

  // Enables the generic coverage service: data-through on every money answer +
  // partial-last-day detection against the trailing same-weekday median.
  coverage: {
    dailyView: 'tevanaot.mv_sales_daily',
    dateColumn: 'transaction_date',
    volumeColumn: 'line_count',
  },

  // Post-reload freshness assertion (services/reload-freshness.service.js):
  // mv_sales_daily must reach the same max transaction_date as mv_sales after a
  // swap. Log-and-surface only — never fails a reload. mv_parts_dim carries no
  // date and is not checked.
  freshness: {
    baseTable: 'tevanaot.mv_sales',
    baseDateColumn: 'transaction_date',
    dateColumn: 'transaction_date',
    views: ['mv_sales_daily'],
  },

  // Entity-match markers (deterministic guard): when the question clearly asks
  // for one of these entities and the generated SQL groups by something else,
  // the result is annotated as an entity mismatch.
  entityMarkers: [
    { pattern: /\bstores?\b|\bbranch(es)?\b|סניפ|חנויות|חנות/i, entity: 'store', expectGroupByAny: ['warhs', 'store_name', 'store_code'] },
    { pattern: /\bmodels?\b|דגם|דגמים/i, entity: 'model', expectGroupByAny: ['model_code', 'model_name'] },
    { pattern: /suppliers?|ספק|ספקים/i, entity: 'supplier', expectGroupByAny: ['supplier_name', 'supplier_code'] },
  ],

  // Gate refusal templates. HIGH-PRECISION triggers only: the deterministic
  // fast-path refuses BEFORE SQL generation on unambiguous hits, so a false
  // refusal is worse than a slow one. Only profit/margin is listed — it is
  // structurally absent (no COGS column), which the sql-generator rules already
  // state; everything else falls through to prompt-level handling.
  refusals: {
    'profit / margin': {
      triggers: [
        /\b(gross\s+)?(profit|margin|profitab\w*|markup|cogs|cost\s+of\s+goods)\b/i,
        /רווח|רווחי\w*|רווחיות|מרווח/,
      ],
      reason: 'This export has no cost-of-goods figure on the sales line, so profit and margin cannot be calculated from it.',
      roadmap: 'Teva Naot would need to add a unit-cost column to the sales export, or a reliable cost master keyed by part.',
      alternatives: 'revenue, units, average selling price and discount amount are all available by store, model or period',
    },
  },
};
