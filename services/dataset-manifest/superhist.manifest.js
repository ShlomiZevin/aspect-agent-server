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
 *   2. A margin answer. There is no cost column anywhere in the feed, and the
 *      tax column is 0.0000 on all 654,370 lines. Revenue exists; profit does
 *      not, not even approximately.
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
      basis: 'order_lines.line_total on product lines — quantity x unit price, which is what the member was charged. Reconciles with orders.order_total (lines + shipping) on 19,045 of 19,062 orders',
    },
    'order count': { fidelity: 'exact', basis: 'distinct orders.order_id' },
    'units': { fidelity: 'exact', basis: 'sum of order_lines.quantity on product lines' },
    'subsidy': {
      fidelity: 'exact',
      basis: "the Histadrut's contribution, recorded ALONGSIDE what the member paid and never deducted from it. Measured: subtracting it reconciles with the order total on 12 of 19,062 orders; leaving it alone reconciles on 19,045. Roughly 6.1% of order value in the first delivery",
    },
    'shipping income': { fidelity: 'exact', basis: "order_lines.line_total on rows where line_kind = 'shipping' — one per order" },
    'basket size': { fidelity: 'exact', basis: 'units or value divided by distinct orders' },
    'member count': { fidelity: 'exact', basis: 'distinct orders.customer_id — 15,881 over 19,062 orders in the first delivery' },
    'profit / margin': {
      fidelity: 'absent',
      basis: 'THERE IS NO COST SIDE. No cost, no COGS, no supplier price anywhere in the feed. Margin cannot be computed at any fidelity',
    },
  },

  dimensions: {
    'date': { status: 'available', detail: 'orders.order_date. Order lines carry NO date — every time-based measure joins the order' },
    'product / item': { status: 'available', detail: 'products catalogue keyed on item_id; name, sku, current stock, current catalogue price. products.catalogue_price is TODAY\'s price and must never be used to value a past order' },
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
    'cost / margin': {
      status: 'absent',
      detail: 'no cost, COGS or supplier price column exists in any delivered file',
      roadmap: 'client adds a cost column to the product export',
    },
    'store / branch / cashier': {
      status: 'absent',
      detail: 'the shop is ONLINE ONLY — there is no physical location dimension and there will not be one',
    },
    'brand': {
      status: 'unreliable',
      detail: 'products.brand_id is 0 on the rows sampled; there is no brand name table',
    },
  },

  vocabulary: [
    { terms: ['סבסוד', 'subsidy'], resolution: 'field',
      detail: "order_lines.subsidy — the union's contribution, reported on its own and never subtracted from revenue" },
    { terms: ['קטגוריה', 'category', 'מחלקה'], resolution: 'unresolved',
      detail: 'there is no product taxonomy in this data — see the absent dimension. The categories table is marketing collections' },
    { terms: ['רווח', 'profit', 'margin', 'מרווח'], resolution: 'unresolved',
      detail: 'no cost side exists, so margin cannot be computed. Revenue is available' },
  ],

  dataFacts: [
    { fact: 'The shop is online only — members of the Histadrut sign in with their ID number. There are no branches, tills or cashiers', appliesTo: 'any question assuming a shop floor' },
    { fact: 'The order-line table concatenates product lines (634,556) and shipping lines (19,814) with no discriminator in the source; a generated line_kind column separates them at load', appliesTo: 'any item or unit count' },
    { fact: 'Subsidy is the union\'s contribution recorded alongside the charge, not a discount deducted from it', appliesTo: 'any revenue or subsidy figure' },
    { fact: 'The delivered history is short — the first delivery covers 42 days — so there is no year-on-year, no seasonality and no prior-year comparison', appliesTo: 'any comparison to last year or any seasonal claim' },
    { fact: 'The final loaded month is PARTIAL. Comparing it with a full month shows a fall that is an artefact of the export, not the business', appliesTo: 'any month-over-month comparison touching the latest month' },
    { fact: 'The calendar table covers the whole year while orders cover weeks — it is a date dimension, never evidence that a date has orders', appliesTo: 'any trend or date-range claim' },
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
    views: ['mv_orders_daily', 'mv_sales_daily_item', 'mv_orders_by_status'],
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
    'cost / margin': {
      triggers: [
        /\b(profit|margin|gross\s+margin|markup|cogs|cost\s+of\s+goods)\b/i,
        /\bwhat\s+.{0,20}\bcost\s+us\b/i,
        // ה? on each noun: Hebrew takes the definite article as a prefix, so
        // "שולי הרווח" is the ordinary way to ask this and a pattern written
        // without it misses the phrasing people actually use. Same class of
        // trap as the final-form letters.
        /ה?רווח\s+ה?גולמי|שולי\s+ה?רווח|ה?מרווח|עלות\s+ה?מכר/,
        /כמה\s+.{0,15}הרווחנו/,
      ],
      reason: 'This data holds no cost side — no cost price, no cost of goods and no supplier price appears in any delivered file — so profit and margin cannot be computed, not even approximately.',
      roadmap: 'The client adds a cost column to the product export.',
      alternatives: 'revenue, units, subsidy funded, and average basket value',
    },
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
