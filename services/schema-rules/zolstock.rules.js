/**
 * Zol Stock SQL-generation rules.
 *
 * REWRITTEN 2026-08-19 for the four-file delivery (Fact / Items / Stores /
 * Calander). The previous inline version described a schema that no longer
 * exists: it named `record_type = 'מכירות'`, `transaction_date`, `line_total`,
 * `cogs`, `seller_id`, `mv_sales_daily_item` and `mv_sales_daily_seller`, and
 * told the model to prefer `zolstock.facts` over `recommendation_facts` for
 * revenue. Every one of those is gone. Rules carry the highest authority in the
 * prompt ("CRITICAL — follow exactly"), so a stale block does not degrade
 * gracefully — it produces confident SQL against columns that do not exist.
 * scripts/test-schema-contract.js fails the build if anything named here stops
 * existing.
 *
 * THE ONE THING TO UNDERSTAND ABOUT THIS DATASET: it contains no money.
 * The fact file is quantities only. Revenue and margin are derived in the
 * materialized views from the item master's list prices, so they exclude
 * discounts and promotions. The column names carry that caveat deliberately
 * (`revenue_list_ex_vat`), and so does the guidance below — a figure presented
 * as plain "revenue" would be compared against a real P&L and found wrong.
 *
 * Rules live in their own module (rather than inline in the 1,400-line
 * generator) so they can be diffed, reviewed and tested per dataset.
 */

function zolstockRules(schemaName) {
  return `
## zolstock-Specific Rules (CRITICAL — follow exactly)

### What this dataset is
Zol Stock is a discount retail chain. \`${schemaName}.facts\` (29,910,277 rows)
concatenates FIVE kinds of row in one table. The kind is given by the
\`record_type\` column — a derived column added at load time:

| record_type | rows | what it holds |
|---|---|---|
| \`'sales'\` | 26,905,987 | row_date, store_number, item_number_sales, qty_sold |
| \`'store_inventory'\` | 2,983,200 | store_number, store_inventory_qty (NO date) |
| \`'warehouse_inventory'\` | 8,924 | sku, warehouse, warehouse_qty (NO date) |
| \`'customer_order'\` | 11,488 | priority_customer_number, sku, row_date, customer_order_id, customer_order_qty |
| \`'purchase_order'\` | 677 | sku, row_date, purchase_order_id, purchase_order_qty |

**ALWAYS filter \`record_type\`.** A bare \`SELECT COUNT(*) FROM ${schemaName}.facts\`
mixes all five and means nothing.

### THERE IS NO MONEY IN THE FACT DATA — read this before writing any revenue query
The source file has no line total, no cost of sales, no discount and no campaign.
Revenue and profit are DERIVED from \`items.consumer_price\` and
\`items.cost_ex_vat\` and are therefore **list-price estimates that exclude
discounts and promotions**. They are precomputed in the materialized views as
\`revenue_list_ex_vat\` and \`profit_list_ex_vat\`.

- **NEVER invent a revenue column on \`facts\`** — \`line_total\`, \`cogs\`,
  \`revenue_ex_vat\` and \`sales_amount\` do NOT exist there and never will.
- **PREFER the materialized views for anything monetary.** They already apply
  the 18% VAT conversion (consumer_price / 1.18) so revenue and cost share one
  basis; computing it ad hoc against \`items.cost\` (VAT-inclusive) overstates
  margin by roughly 18 points.
- When a question asks for "revenue" or "sales", answer with
  \`revenue_list_ex_vat\` and say in your explanation that it is a list-price
  figure excluding discounts.
- **VAT is exactly 18% — the ONLY conversion factor is 1.18** (÷1.18 to strip
  VAT, ×1.18 to add it). Never use 1.17 or any other rate: a generated query
  using 1.17 once produced the single wrong figure in an otherwise-exact
  16-check audit (2026-08-20).
- **When the question compares against a figure the USER quoted** (a
  reconciliation question), return BOTH bases in one row —
  \`revenue_list_ex_vat\` AND \`ROUND(revenue_list_ex_vat * 1.18, 2) AS
  revenue_list_inc_vat_estimate\` — so the answer can match the user's basis
  instead of guessing it. Users' own reports are usually labelled
  "כולל מעמ" (inc-VAT); ours default to ex-VAT — comparing across bases
  produced a misleading "5.3% gap" in one audited answer that was really
  −19.5% on a like-for-like basis.

### Replenishment / reorder / transfer questions — THE ONLY workable shape
For "what should we reorder / restock / transfer" questions, compute need from
**stock vs open orders vs safety stock** using ONLY the small views:
\`mv_warehouse_inventory\` (has \`safety_stock\`) + \`mv_open_orders\`
(\`order_kind\` = 'customer' | 'purchase') — need ≈ customer orders + safety
stock − warehouse qty − open purchase orders. This answers in seconds.
If the question insists on recent SALES VELOCITY per item, take it from
\`mv_sales_monthly_item\` (month grain) — **NEVER scan \`facts\` grouped by
item for a date window**: 26.9M rows at item grain is a guaranteed timeout
(measured: 174s vs 37s for the same business question with and without the
facts scan). A month of \`mv_sales_monthly_item\` is an acceptable proxy for
"last 30 days" here; say so in the explanation.

### Materialized views — PREFER THESE for every aggregate
| view | grain | rows | use for |
|---|---|---|---|
| \`${schemaName}.mv_sales_daily\` | day | ~600 | totals and trends over time |
| \`${schemaName}.mv_sales_daily_store\` | day × store | ~58k | store rankings, store trends |
| \`${schemaName}.mv_sales_monthly_item\` | month × item | ~1-2M | item questions WITH a period |
| \`${schemaName}.mv_sales_item_total\` | item (lifetime) | ~139k | "top N items" with NO period |
| \`${schemaName}.mv_sales_monthly_category\` | month × category | ~1k | category and margin questions |
| \`${schemaName}.mv_store_inventory\` | store × sku | ~433k | stock on hand in stores |
| \`${schemaName}.mv_warehouse_inventory\` | sku | ~8.9k | central warehouse stock and its value |
| \`${schemaName}.mv_open_orders\` | order line | ~12k | open customer / purchase orders |

Each sales view carries \`total_qty\`, \`revenue_list_ex_vat\` and
\`profit_list_ex_vat\`; the item and category views also carry \`item_name\`,
\`category\`, \`subcategory\`, \`item_family\` and \`supplier\`, already
deduplicated — so a top-items query needs NO join to \`items\` at all.

The non-sales views have their OWN column names — do not assume the item
master's names carry over:
- \`mv_warehouse_inventory\`: \`sku\`, \`item_number\`, \`item_name\`,
  \`category\`, \`warehouse_qty\`, \`safety_stock\`, \`consumer_price\`,
  \`stock_value_at_cost_ex_vat\` (the stock value is ALREADY computed — there is
  no \`cost_ex_vat\` column on this view, so never multiply by one).
- \`mv_store_inventory\`: \`store_number\`, \`store_name\`, \`sku\`,
  \`item_number\`, \`item_name\`, \`category\`, \`store_qty\`, \`safety_stock\`.
- \`mv_open_orders\`: \`order_kind\` ('customer' | 'purchase'), \`order_id\`,
  \`row_date\`, \`sku\`, \`store_number\`, \`priority_customer_number\`, \`qty\`.

99 of the 5,015 warehouse SKUs (113,556 units, 2.3%) have no matching item in
the master, so \`item_name\`, \`category\` and \`stock_value_at_cost_ex_vat\`
are NULL on those rows. Because Postgres sorts NULLs FIRST on DESC, a
"top 10 by stock value" query returns those blank rows at the top unless you
write \`ORDER BY stock_value_at_cost_ex_vat DESC NULLS LAST\`. Always do.

**Do NOT aggregate \`facts\` directly for a question a view answers.** A
\`GROUP BY item_number_sales\` over 26.9M rows takes minutes and will time out;
\`mv_sales_item_total\` answers the same question in milliseconds.

### TWO ITEM KEYS — they are not interchangeable
- \`facts.item_number_sales\` → \`items.item_number\`. This is the SALES key.
  It joins at 99.9% and 139,089 distinct items have sales.
- \`facts.sku\` → \`items.sku\`. This is the REPLENISHMENT key, used by
  warehouse stock, purchase orders and customer orders. Only 14,649 of 298,555
  items have a sku at all.

Joining sales rows on \`sku\` returns almost nothing. Joining inventory rows on
\`item_number_sales\` returns nothing at all.

**When the user names a SKU (e.g. \`AD-52-173\`, \`BH-34-240\`) and asks about
SALES, you must bridge through \`items\` first.** The sales views are keyed on
\`item_number\`, never on sku, so filtering them by sku directly returns zero
rows — which reads to the user as "this product never sold" when it sold
71,421 units:

\`\`\`sql
SELECT t.item_name, t.total_qty, t.revenue_list_ex_vat
  FROM ${schemaName}.mv_sales_item_total t
 WHERE t.item_number IN (SELECT item_number FROM ${schemaName}.items WHERE sku = 'AD-52-173')
\`\`\`

If the sku is not in \`items\` at all, say the SKU is not in the catalogue —
do NOT return an empty table with no explanation.

### TWO SUPPLIER COLUMNS — pick the right one
- \`items.positive_supplier\` (ספק פוזיטיב) is the SUPPLYING COMPANY as named in
  the client's Positive ERP — this is what a user means by "ספק", and it holds
  values like \`'ב.א. זול סטוק והפצה בע"מ'\`. **Use this one when the user names
  a supplier.**
- \`items.supplier\` is the manufacturer/importer. Its Latin values are stored
  REVERSED in the source export (\`'GNIDART SBD'\` is "DBS TRADING",
  \`'.dtL ecremmoC .L .M'\` is "M. L. Commerce Ltd."), so never match it against
  a name the user typed and never present it as a company name without saying
  the source text is reversed. Hebrew values in this column are unaffected.

### items is NOT unique on item_number
1,859 of 303,508 rows share an \`item_number\` with another row (same item,
different barcode). A plain \`JOIN ${schemaName}.items\` MULTIPLIES aggregate
rows — a silent 1.7% inflation. Deduplicate first, and prefer \`GROUP BY\` +
\`MAX()\` over \`DISTINCT ON\` (an untied \`DISTINCT ON\` picks an arbitrary
duplicate, so the same question returns different answers depending on how the
query happens to be written):

\`\`\`sql
JOIN (SELECT item_number, MAX(item_name) AS item_name, MAX(category) AS category,
             MAX(consumer_price) AS consumer_price, MAX(cost_ex_vat) AS cost_ex_vat
        FROM ${schemaName}.items GROUP BY item_number) i
  ON i.item_number = f.item_number_sales
\`\`\`

### stores joins directly — do NOT use SPLIT_PART
\`${schemaName}.stores.store_number\` is clean in this delivery and joins
\`facts.store_number\` at 100.00%. Any older guidance about extracting the
number from \`store_label\` with \`SPLIT_PART\` is obsolete. 139 stores exist;
96 of them have sales.

### Dates
The date column is \`row_date\` (there is no \`transaction_date\`). The data is a
periodic export that LAGS the calendar — the exact current end date is given in
the DATA RECENCY section of this prompt; never state a data end date from
memory. Purchase-order rows carry dates AHEAD of the last sale, so anchor
"now" to sales only:

\`\`\`sql
(SELECT MAX(row_date) FROM ${schemaName}.facts WHERE record_type = 'sales')
\`\`\`

\`${schemaName}.calendar\` (733 rows) carries \`cal_date\`, \`year\`, \`month\`
and \`holiday\` — Hebrew holiday names on 111 dates, which is genuinely useful
for this retailer since trade is strongly holiday-driven.

### Inventory has no dates, and most store rows have no item
- \`store_inventory\` and \`warehouse_inventory\` rows have **NULL row_date**.
  Never filter them by date and never try to trend them — there is no history,
  only a current snapshot.
- 2,549,776 of the 2,983,200 store-inventory rows (85%) carry **no item key**.
  \`mv_store_inventory\` deliberately covers only the 433,424 rows that do.
  For an item-level stock question, use the view. If asked for total stock
  across the chain, say that item-level attribution covers only part of it.

### Worked examples

Top 10 items by quantity, all time:
\`\`\`sql
SELECT item_name, category, total_qty, revenue_list_ex_vat
FROM ${schemaName}.mv_sales_item_total
ORDER BY total_qty DESC
LIMIT 10
\`\`\`

Monthly revenue trend with the real data cutoff alongside:
\`\`\`sql
SELECT DATE_TRUNC('month', row_date)::date AS month,
       SUM(revenue_list_ex_vat) AS revenue_list_ex_vat,
       SUM(total_qty)           AS units,
       (SELECT MAX(row_date) FROM ${schemaName}.facts WHERE record_type = 'sales') AS latest_available_date
FROM ${schemaName}.mv_sales_daily
GROUP BY 1 ORDER BY 1
\`\`\`

Margin by category for the last full month:
\`\`\`sql
SELECT category,
       SUM(revenue_list_ex_vat) AS revenue_list_ex_vat,
       SUM(profit_list_ex_vat)  AS profit_list_ex_vat,
       ROUND(100.0 * SUM(profit_list_ex_vat) / NULLIF(SUM(revenue_list_ex_vat), 0), 1) AS margin_pct
FROM ${schemaName}.mv_sales_monthly_category
WHERE month = DATE_TRUNC('month', (SELECT MAX(row_date) FROM ${schemaName}.facts WHERE record_type = 'sales'))
GROUP BY category
ORDER BY profit_list_ex_vat DESC
LIMIT 10
\`\`\`

Items below their safety stock in the warehouse:
\`\`\`sql
SELECT item_name, warehouse_qty, safety_stock
FROM ${schemaName}.mv_warehouse_inventory
WHERE safety_stock > 0 AND warehouse_qty < safety_stock
ORDER BY safety_stock - warehouse_qty DESC
LIMIT 10
\`\`\`
`;
}

module.exports = { zolstockRules };
