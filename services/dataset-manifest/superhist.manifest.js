/**
 * The Social Supermarket (הסופר החברתי) capability manifest.
 *
 * Every figure below was MEASURED against the first delivery on 2026-09-02 —
 * 19,062 orders, 654,370 order lines, 16,537 products, 15,881 members, ₪8.44M
 * over 42 days — not inferred from the column names.
 *
 * The two things this file exists to stop:
 *
 *   1. A category answer. The catalogue's category field is populated on 3.3%
 *      of products and every one points at a SINGLE id; the categories table
 *      holds marketing collections, not a taxonomy. Left unstated, an LLM will
 *      happily group by product name or brand id and call the result
 *      "categories" — a confident answer to a question the data cannot support.
 *   2. (Until 2026-09-23) a margin answer. The client then added a line cost
 *      column, supplier and unit cost — cost, gross profit and supplier are
 *      now exact, following the client's own Qlik formula.
 */

module.exports = {
  id: 'superhist',

  // No VAT split is possible: the delivered `tax` column is zero on every
  // line, so prices are as charged and cannot be decomposed. Recorded as null
  // rather than omitted, so nothing downstream invents 1.18 by analogy with
  // the other Israeli datasets.
  vatRate: null,

  measures: {
    'revenue / sales': {
      fidelity: 'exact',
      basis: 'order_lines.line_total on product lines — quantity x unit price, which is what the member was charged. The order total is the sum of all its lines (products + shipping + negative coupons/discounts)',
    },
    'order count': { fidelity: 'exact', basis: 'distinct orders.order_id' },
    'units': { fidelity: 'exact', basis: 'sum of order_lines.quantity on product lines' },
    'subsidy': {
      fidelity: 'exact',
      basis: "the Histadrut's contribution, recorded ALONGSIDE what the member paid and never deducted from it",
    },
    'shipping income': { fidelity: 'exact', basis: "order_lines.line_total on rows where line_kind = 'shipping'" },
    'coupons / discounts': { fidelity: 'exact', basis: "order_lines.line_total on rows where line_kind = 'coupon' or 'discount' — NEGATIVE amounts, reported as amounts redeemed" },
    'basket size': { fidelity: 'exact', basis: 'units or value divided by distinct orders' },
    'member count': { fidelity: 'exact', basis: 'distinct orders.customer_id' },
    // Added 2026-09-23 when the client delivered a line-level cost column.
    'cost': { fidelity: 'exact', basis: 'order_lines.line_cost on product lines — the cost of the whole line (quantity x unit cost), as recorded by the client' },
    'gross profit / margin': {
      fidelity: 'exact',
      basis: "SUM(line_total - line_cost) on product lines — the client's own Qlik formula, subsidy NOT added. Negative on many subsidised items (about a quarter of product lines sell below cost), which is real and must be reported as such",
    },
  },

  dimensions: {
    'date': { status: 'available', detail: 'orders.order_date. Order lines carry NO date — every time-based measure joins the order' },
    'product / item': {
      status: 'available',
      detail: 'products catalogue keyed on item_id; name, sku, supplier, current stock, current unit cost. '
        + 'unit_cost is TODAY value and must never be used to value a past order — order lines carry the recorded price and cost. '
        + 'An item that sold but is missing from the catalogue appears with no name; '
        + 'mv_sales_item keeps such items and flags them with in_catalogue = false',
    },
    'supplier': {
      status: 'available',
      detail: 'products.supplier_name — filled on every item that has sold (empty only on never-sold catalogue rows), so sales, cost and gross profit by supplier cover all product revenue. mv_sales_daily_supplier is the fast path',
    },
    'coupon / discount': {
      status: 'available',
      detail: "order_lines with line_kind 'coupon' (item_id holds the coupon name/code) or 'discount' (free-shipping benefit, cart discount); negative line_total",
    },
    'member / customer': { status: 'available', detail: 'orders.customer_id — an identifier only. No name, no city, no demographics' },
    'payment method': { status: 'available', detail: 'orders.payment_method / payment_method_code' },
    'shipping method': { status: 'available', detail: 'orders.shipping_method / shipping_code' },
    'order status': {
      status: 'unreliable',
      detail: 'TWO status columns that disagree on 7,176 of 19,062 orders — order_status (system) and display_status (Hebrew display). Any status answer must name which one it used. counts_for_totals is 1 on every row and filters nothing',
      roadmap: 'client says which of the two is authoritative for reporting',
    },
    'product category': {
      status: 'absent',
      detail: 'products.category_id is populated on 547 of 16,537 products (3.3%) and every one points at a SINGLE id. The categories table holds 110 MARKETING COLLECTIONS ("חגיגת שבועות", "הסל שלנו"), not a product taxonomy. There is no way to group sales by product category',
      roadmap: 'client delivers the product-to-category mapping their own site uses for navigation',
    },
    'store / branch / cashier': {
      status: 'absent',
      detail: 'the shop is ONLINE ONLY — there is no physical location dimension and there will not be one',
    },
    'brand': {
      status: 'unreliable',
      detail: 'products.brand_id is 0 on the rows sampled; there is no brand name table',
    },
    // Task #72, added 2026-09-14. Columns confirmed against the real file in
    // GCS (see column-aliases-superhist.js), but it has not been through
    // Phase 1/2 yet, so row counts below are still a projection, not a
    // measurement. Reut, the client's BI developer, said it accumulates one
    // snapshot per day going forward, so on day one it is a single date and
    // stays 'limited' until there is enough history for a real trend —
    // update this entry (and ideally add a measured dataFacts line with the
    // actual day count) once several days have loaded.
    'inventory / stock history': {
      status: 'limited',
      detail: 'stock_history.stock_qty per item_id per snapshot_date — a NEW daily inventory snapshot, separate from products.stock_qty (which is only the CURRENT level). Accumulates one day at a time from whenever this file started arriving; there is no inventory data for any earlier date, so a question about stock on a past date, or an inventory trend, can only be answered from the days actually loaded so far',
    },
  },

  vocabulary: [
    { terms: ['סבסוד', 'subsidy'], resolution: 'field',
      detail: "order_lines.subsidy — the union's contribution, reported on its own and never subtracted from revenue" },
    { terms: ['קטגוריה', 'category', 'מחלקה'], resolution: 'unresolved',
      detail: 'there is no product taxonomy in this data — see the absent dimension. The categories table is marketing collections' },
    { terms: ['רווח גולמי', 'gross profit', 'profit', 'margin', 'רווח'], resolution: 'field',
      detail: "SUM(order_lines.line_total - line_cost) on product lines — the client's own definition, subsidy not added" },
    { terms: ['עלות', 'cost', 'עלות המכר'], resolution: 'field',
      detail: 'order_lines.line_cost on product lines — cost of the whole line' },
    { terms: ['ספק', 'supplier'], resolution: 'field', detail: 'products.supplier_name' },
    { terms: ['קופון', 'coupon'], resolution: 'field', detail: "order_lines where line_kind = 'coupon' — negative amounts" },
  ],

  dataFacts: [
    { fact: 'The shop is online only — members of the Histadrut sign in with their ID number. There are no branches, tills or cashiers', appliesTo: 'any question assuming a shop floor' },
    { fact: 'The order-line table concatenates product lines with shipping, coupon and discount lines; a generated line_kind column separates them at load', appliesTo: 'any item or unit count' },
    { fact: 'Subsidy is the union\'s contribution recorded alongside the charge, not a discount deducted from it', appliesTo: 'any revenue or subsidy figure' },
    { fact: 'Gross profit follows the client\'s own formula (line total minus line cost, subsidy not added), so subsidised items often show negative gross profit — that is real, not a data error', appliesTo: 'any profit, margin or loss-making-items answer' },
    { fact: 'The delivered history starts in 2026 — there is no prior year, so no year-on-year and no seasonality', appliesTo: 'any comparison to last year or any seasonal claim' },
    { fact: 'The final loaded month is PARTIAL. Comparing it with a full month shows a fall that is an artefact of the export, not the business', appliesTo: 'any month-over-month comparison touching the latest month' },
    { fact: 'The calendar table covers the whole year while orders cover weeks — it is a date dimension, never evidence that a date has orders', appliesTo: 'any trend or date-range claim' },
    { fact: 'An item that sold but is absent from the product catalogue has no name on file — report it as an unidentified item rather than dropping it or guessing', appliesTo: 'top-seller lists and any per-product total' },
    { fact: 'stock_history (task #72) is a NEW daily inventory snapshot that only started accumulating recently — it does not reach back before whenever the first file arrived, so it cannot answer "what was the stock on <an earlier date>" for dates before that', appliesTo: 'any historical or trend question about inventory levels' },
  ],

  coverage: {
    dailyView: 'superhist.mv_orders_daily',
    dateColumn: 'order_date',
    volumeColumn: 'order_count',
  },

  // Post-reload freshness assertion (services/reload-freshness.service.js):
  // after a schema swap these views must reach the same max date as the base
  // orders. Log-and-surface only — never fails a reload.
  freshness: {
    baseTable: 'superhist.orders',
    baseDateColumn: 'order_date',
    baseFilter: 'order_date IS NOT NULL',
    dateColumn: 'order_date',
    // mv_sales_item and mv_customers are lifetime grains with no date column,
    // so they are deliberately not listed.
    views: ['mv_orders_daily', 'mv_sales_daily_item', 'mv_sales_daily_supplier', 'mv_orders_by_status'],
  },

  // When the question clearly asks for one of these and the generated SQL
  // groups by something else, the result gets an entity_mismatch annotation.
  entityMarkers: [
    { pattern: /\bproducts?\b|\bitems?\b|מוצר|פריט/i, entity: 'product', expectGroupByAny: ['item_id', 'item_name', 'sku'] },
    { pattern: /members?|customers?|לקוח|חבר/i, entity: 'member', expectGroupByAny: ['customer_id'] },
    { pattern: /payment|תשלום/i, entity: 'payment method', expectGroupByAny: ['payment_method', 'payment_method_code'] },
  ],

  // Deterministic pre-flight refusals, keyed by the absent dimension. Triggers
  // are HIGH-PRECISION: the fast path refuses BEFORE SQL generation only on
  // unambiguous hits, and anything ambiguous falls through to the prompt, which
  // handles it well. Precision beats recall — a false refusal is worse than a
  // slow answer.
  //
  // Hebrew stems are written as character classes where a final-form letter can
  // end the word (ן/נ, ם/מ, ץ/צ, ף/פ, ך/כ): a pattern written with the regular
  // form silently misses the singular, which is exactly how a customer's
  // follow-up slipped a gate on another dataset.
  refusals: {
    'product category': {
      triggers: [
        /\b(sales|revenue|units|orders)\b.{0,30}\bby\s+categor/i,
        /\bbreak\s*down\b.{0,30}\bcategor/i,
        /\btop\s+categor/i,
        /מכירות\s+לפי\s+קטגורי/,
        /הכנסות\s+לפי\s+קטגורי/,
        /פילוח\s+.{0,15}קטגורי/,
        /לפי\s+מחלק[הות]/,
      ],
      reason: 'This catalogue has no product taxonomy. The category field is filled on 3.3% of products and all of them share one id, and the categories table holds marketing collections ("חגיגת שבועות") rather than product categories.',
      roadmap: 'The client would need to deliver the product-to-category mapping their own storefront navigation uses.',
      alternatives: 'sales by individual product, by payment method, by shipping method, or by week',
    },
    // 'cost / margin' refusal REMOVED 2026-09-23: the client now delivers a
    // line-level cost column, so profit and margin are exact answers.
    'store / branch': {
      triggers: [
        /\b(sales|revenue|orders)\b.{0,30}\bby\s+(store|branch)\b/i,
        /\btop\s+(stores|branches)\b/i,
        /\bwhich\s+(store|branch)\b/i,
        /מכירות\s+לפי\s+(סניפ|חנו)/,
        /איזה\s+(סניף|חנות)/,
        /טופ\s+.{0,10}(סניפ|חנויות)/,
      ],
      reason: 'The Social Supermarket is an online shop with home delivery — there are no branches, stores or tills in the business, so there is no such dimension in the data.',
      roadmap: 'Not applicable — this is a property of the business, not a gap in the export.',
      alternatives: 'orders by shipping method, by day, or by member',
    },
  },
};
