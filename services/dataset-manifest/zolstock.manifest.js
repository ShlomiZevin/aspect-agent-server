/**
 * ZolStock capability manifest — the truth card.
 *
 * Every entry here is an EVIDENCED fact, not an assumption. Sources:
 *  - 62-case QA battery (verification/zolstock-quality/, 2026-08-17)
 *  - Qlik dashboard reconciliation (2026-08-20: monthly +2.3–7.0%, YTD +2.8%,
 *    category mapping proven absent, ירכא −32% anomaly)
 *  - 74-question customer replay baseline
 *    (verification/representative-dataset/21-08-2026-quality-baseline.json)
 *  - Client sessions 18–20 Aug (the קצרין dispute: P-marker and
 *    "מכירות כולל מעמ" vocabulary; agent-sales expectations)
 *
 * Update triggers: a new feed file arrives, a reconciliation is re-run, or a
 * customer correction is confirmed. scripts/test-schema-contract.js fails the
 * build if a relation/column named here stops existing.
 */

module.exports = {
  id: 'zolstock',

  // THE single VAT source for this dataset. Rules and any revenue arithmetic
  // read this — never hardcode a VAT number elsewhere (the 1.17-vs-1.18
  // incident of 2026-08-20 produced the only wrong figure in a 16-check audit).
  vatRate: 1.18,

  measures: {
    'units / quantities sold': { fidelity: 'exact', basis: 'facts.qty_sold — reconciles exactly to the delivered CSV' },
    'revenue': { fidelity: 'estimate', basis: 'list price × qty ÷ 1.18 (items.consumer_price); EXCLUDES discounts and promotions — columns are named revenue_list_ex_vat on purpose', knownDelta: '+2.3% to +7.0% per complete month, +2.8% YTD above the client\'s actual-sales dashboard' },
    'profit / margin': { fidelity: 'estimate', basis: 'list price minus items.cost_ex_vat; same discount caveat as revenue' },
    'transaction count': { fidelity: 'proxy', basis: 'sales line count — there is no receipt/transaction id in the feed' },
    'inventory (store / warehouse)': { fidelity: 'exact', basis: 'store_inventory / warehouse_inventory snapshot rows (NULL row_date — current snapshot, not dated history)' },
    'customer orders / purchase orders': { fidelity: 'exact', basis: 'customer_order / purchase_order rows, dated' },
  },

  dimensions: {
    'store': { status: 'available', detail: 'stores table with names; sales key on store_number' },
    'item / product': { status: 'available', detail: 'items catalog (name, category, subcategory, family, supplier, safety_stock). Sales rows key on item_number_sales; replenishment rows key on sku — filtering a SALES view by sku silently returns zero rows' },
    'category (as labeled)': { status: 'available', detail: 'items.category/subcategory as delivered' },
    'category (vs client dashboard)': { status: 'unreliable', detail: 'the mapping the client\'s Qlik uses is NOT in the delivered files — measured divergence 2× to 29× per category; same labels, different item-to-category assignment', roadmap: 'client sends the mapping table/field feeding קטגוריה ראשית in Qlik' },
    'date': { status: 'available', detail: 'facts.row_date (sales/orders); inventory rows carry NULL dates' },
    'supplier': { status: 'available', detail: 'items.positive_supplier / supplier' },
    'retail customer': { status: 'absent', detail: 'no customer identity on sales rows', roadmap: 'existed in the retired Facts_ export — client would need to restore those columns' },
    'agent / seller': { status: 'absent', detail: 'no seller dimension in the four-file feed (client\'s dashboard ranks agents to ₪8.29M — we cannot)', roadmap: 'same retired export' },
    'payment type': { status: 'absent', detail: 'no payment fields in the feed', roadmap: 'same retired export' },
    'customer city / demographics / age': { status: 'absent', detail: 'no demographic data ever delivered' },
    'discounts / promotions / campaigns': { status: 'absent', detail: 'no monetary or campaign columns in the feed — this is WHY revenue is an estimate' },
  },

  vocabulary: [
    { terms: ['מכירות כולל מעמ', 'מכירות כולל מע"מ', 'sales including VAT (recorded)'], resolution: 'unresolved',
      detail: 'no recorded till amount exists in the feed; the only inc-VAT figure is the list-price estimate ×1.18. Say this instead of hunting for a field.' },
    { terms: ['מכירות P', 'מכירות מחסן מסומנות P', 'האות P', 'מסומנות P', 'warehouse sales marked P', 'marked with P'], resolution: 'unresolved',
      detail: 'the client\'s ERP marks warehouse sales with a P prefix; the delivered fact rows carry NO such discriminator. Warehouse vs store sales cannot be split.' },
    { terms: ['ספק ב.א זול סטוק', 'ארכיון ב.א זול סטוק'], resolution: 'field',
      detail: 'supplier names live in items.positive_supplier / items.supplier — exact-match first, then ILIKE' },
    { terms: ['סניפי סגמנט', 'segment stores'], resolution: 'field',
      detail: 'items.sent_to_segment flags segment distribution; per-store segment stock comes from store_inventory rows' },
    // AMBIGUOUS terms — the gate never fires on these; the crew's data-discipline
    // block instructs one clarifying question instead. Background: EN "top
    // sellers" was answered as best-selling PRODUCTS in the Stage-2 replay
    // while the unambiguous Hebrew "מוכרנים" correctly refused (no salesperson
    // dimension). Either reading is defensible — choosing silently is not.
    { terms: ['top sellers', 'best sellers', 'top seller'], resolution: 'ambiguous',
      detail: 'may mean best-selling PRODUCTS (available) or top SALESPEOPLE (dimension absent from this feed).' },
  ],

  dataFacts: [
    { fact: '8.1% of 2026 sold units (≈2.1M) have no catalog price and contribute ZERO revenue in estimates — including the catch-all item the client\'s dashboard values at ₪23.5M', appliesTo: 'any revenue ranking or total' },
    { fact: 'Store ירכא measures −32% vs the client dashboard while every other store runs +11–18% (unexplained; only store moving against the discount-gap trend)', appliesTo: 'store rankings/comparisons' },
    { fact: 'Store ראש העין carries a NEGATIVE total stock balance (−802,918 units across 8,755 items) — likely uningested adjustments; treat its stock figures as suspect', appliesTo: 'inventory rankings' },
    { fact: 'Catch-all items (פריט כללי, פריט מבצע) and seller כללי legitimately dominate volume rankings — flag them as catch-alls when they appear in a top-N', appliesTo: 'item rankings' },
    { fact: 'The feed is a periodic export — the last delivered day can be PARTIAL (2026-08-17 arrived at 27% and was completed by a later delivery)', appliesTo: 'any latest-day figure' },
  ],

  // Enables the generic coverage service: data-through + partial-last-day
  // detection against the trailing same-weekday median.
  coverage: {
    dailyView: 'zolstock.mv_sales_daily_store',
    dateColumn: 'row_date',
    volumeColumn: 'line_count',
  },

  // Post-reload freshness assertion (services/reload-freshness.service.js):
  // after a schema swap, every MV carrying `dateColumn` must reach the same
  // max date as the base sales rows. Log-and-surface only — never fails a
  // reload. Guards against the pre-Stage-1 failure mode (views silently
  // stale behind the fact table) ever returning.
  freshness: {
    baseTable: 'zolstock.facts',
    baseDateColumn: 'row_date',
    baseFilter: "record_type = 'sales'",
    dateColumn: 'row_date',
    // ONLY these views must reach the base sales max-date. Other dated views
    // legitimately lag: mv_open_orders ends at the last ORDER date (17.8 vs
    // sales 23.8 on 2026-08-24 — a verified false positive of the unfiltered
    // check), and monthly roll-ups end at month START. Listing the views is
    // per-dataset knowledge, which is why it lives here and not in the service.
    views: ['mv_sales_daily', 'mv_sales_daily_store'],
  },

  // Entity-match markers (deterministic D3 guard): when the question clearly
  // asks for one of these entities and the generated SQL groups by something
  // else, the result gets an entity_mismatch annotation. The historical case:
  // "אילו קטגוריות מניבות את הרווח הגבוה ביותר" answered by grouping 90,929
  // item_numbers — right arithmetic, wrong question, confidence 90.
  entityMarkers: [
    { pattern: /categor|קטגורי|מחלק[ות]/i, entity: 'category', expectGroupByAny: ['category', 'subcategory', 'item_family'] },
    { pattern: /\bstores?\b|סניפ|חנויות|חנות/i, entity: 'store', expectGroupByAny: ['store_number', 'store_name'] },
    { pattern: /suppliers?|ספק/i, entity: 'supplier', expectGroupByAny: ['supplier', 'positive_supplier'] },
  ],

  // Gate refusal templates — keyed by the dimension whose absence triggers
  // them. `triggers` are HIGH-PRECISION regexes: the deterministic fast-path
  // refuses BEFORE SQL generation only on unambiguous hits (making refusals
  // invariant across runs); anything ambiguous falls through to the
  // prompt-level handling, which the baseline shows already refuses well.
  // Precision beats recall here — a false refusal is worse than a slow one.
  // NOTE: "הזמנות לקוח" (customer ORDERS) is available data — customer
  // triggers must not match it, hence the count/identity phrasings only.
  refusals: {
    'retail customer': {
      triggers: [/(how many|number of|total)\s+(unique\s+)?customers/i, /כמה\s+לקוחות/, /customer\s+(count|ids?|identit|profiles?|list)/i, /רשימת\s+לקוחות/],
      reason: 'This dataset contains no retail-customer identities — sales rows carry quantities only.',
      roadmap: 'Customer analysis needs the customer columns from the retired Facts_ export restored to the feed.',
      alternatives: 'sales by store, by product, or by period',
    },
    'agent / seller': {
      // NOTE the [נן] classes: Hebrew final-nun. The singular "סוכן" ends in
      // final ן while the plural "סוכנים" carries regular נ — a pattern
      // written with only נ matches the plural and silently misses the
      // singular (caught 27-08 when the customer's bare "מכירות סוכן"
      // slipped the gate; the talker still refused, but the deterministic
      // layer must catch both).
      triggers: [/sellers?\s+by|top\s+\d*\s*sellers/i, /מוכרנים|מוכר[נן]|קופאים|קופאי/, /מכירות\s+סוכ[נן]|סוכ[נן]י?ם?\s+(לפי|מכיר)|נתוני\s+מכירות\s+סוכ[נן]/, /agent\s+sales|sales\s+agents?\s+(ranking|report|by)/i],
      reason: 'No seller/agent dimension exists in the current four-file feed — sales cannot be attributed to a salesperson.',
      roadmap: 'Agent-sales analysis needs the seller columns from the retired export.',
      alternatives: 'sales by store, by product, or by category for the same period',
    },
    'payment type': {
      triggers: [/payment\s+(type|method|totals?)/i, /אמצעי\s+תשלום|סוגי?\s+תשלום|לפי\s+תשלום/],
      reason: 'No payment fields exist in the current feed.',
      roadmap: 'Payment analysis needs the payment columns from the retired export.',
      alternatives: 'sales totals by store or period',
    },
    'customer city / demographics / age': {
      triggers: [/age\s+distribution|customer\s+age|demographic/i, /התפלגות\s+גיל|גיל\s+הלקוחות|דמוגרפ/, /cities\s+.{0,25}customers|customers\s+.{0,25}cities/i, /ערים\s+.{0,20}לקוחות|לקוחות\s+.{0,20}ערים/],
      reason: 'No demographic or customer-location data has ever been delivered for this dataset.',
      roadmap: 'Would require a customer master with demographics from the client.',
      alternatives: 'sales by store city is possible via the stores dimension, if store-level geography is the actual question',
    },
  },
};
