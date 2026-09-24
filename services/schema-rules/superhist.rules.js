/**
 * The Social Supermarket (הסופר החברתי) SQL-generation rules.
 *
 * Written 2026-09-02 against the first delivery, and every figure quoted below
 * was measured, not assumed. Rules carry the highest authority in the prompt
 * ("CRITICAL — follow exactly"), so a stale block does not degrade gracefully —
 * it produces confident SQL against columns that do not exist.
 * scripts/test-schema-contract.js fails the build if anything named here stops
 * existing.
 *
 * THE THREE THINGS TO UNDERSTAND ABOUT THIS DATASET:
 *
 *   1. The order-line table holds two kinds of row and only one is a product.
 *   2. Subsidy sits beside revenue and is not part of it — it is what the union
 *      funded, not a discount off the member's bill.
 *   3. There is no product category and no shop floor. Those are not gaps to
 *      work around with something adjacent; they are refusals.
 *
 * 2026-09-23: the client added line cost, supplier and unit cost, dropped the
 * order total and catalogue price, and added a raw kind for non-product rows
 * (coupons, discounts). Rules 1, 3, 3a, 3b, 4, 5 were rewritten for it.
 */

function superhistRules(schemaName) {
  return `
## superhist-Specific Rules (CRITICAL — follow exactly)

### What this dataset is
הסופר החברתי is the Histadrut's members-only ONLINE grocery. The model is an
order model, not a point of sale: \`${schemaName}.orders\` joined to
\`${schemaName}.order_lines\`, joined to \`${schemaName}.products\`.

There is no store, branch, till or cashier dimension, and there never will be —
the shop exists only online.

### RULE 1 — order_lines holds several row kinds. Always filter.
\`${schemaName}.order_lines\` concatenates product lines with non-product lines.
The kind is given by \`line_kind\`, a derived column added at load time:

| line_kind | what it holds |
|---|---|
| \`'product'\` | a purchased item: item_id, quantity, unit_price, line_total, line_cost, subsidy |
| \`'shipping'\` | the delivery charge. NO item, NO quantity |
| \`'coupon'\` | a coupon redemption — NEGATIVE line_total; item_id holds the coupon name/code |
| \`'discount'\` | a free-shipping benefit or cart discount — NEGATIVE line_total |

A non-product row carries a NAME in \`item_id\` (delivery method, coupon code).
So:
- Any question about items, units, product revenue, cost or gross profit MUST
  say \`WHERE line_kind = 'product'\`.
- Delivery income is \`WHERE line_kind = 'shipping'\`; coupons are
  \`line_kind = 'coupon'\` (report as a positive amount redeemed with ABS or
  say they are negative). Never mix any of them into product revenue.
- \`extra_kind\` is the source's own raw kind for these rows; prefer \`line_kind\`.

### RULE 2 — the date lives on the ORDER, not the line
\`order_lines\` has no date column. Every time-based question joins
\`${schemaName}.orders\` and filters \`o.order_date\`. Never invent a date on the
line table.

### RULE 3 — revenue is the line total. Subsidy is NOT subtracted.
\`line_total\` = \`quantity\` × \`unit_price\`, exactly, on every product line, and
it is what the member was charged. \`orders\` has NO total column — an order's
total is the SUM of ALL its lines (products + shipping + negative coupons and
discounts).

\`subsidy\` is the Histadrut's contribution — the value of the member benefit,
recorded alongside the charge, NOT deducted from it.

- "revenue" / "sales" / "מכירות" → \`SUM(line_total)\` on product lines
- "subsidy" / "סבסוד" → \`SUM(subsidy)\`, its own measure, never mixed in

### RULE 3a — cost and gross profit (the client's own formula)
\`order_lines.line_cost\` is the cost of the WHOLE line (quantity × unit cost),
filled on every product line.
- "cost" / "עלות" / "עלות המכר" → \`SUM(line_cost)\` on product lines
- "gross profit" / "רווח גולמי" → \`SUM(line_total - line_cost)\` on product lines
- "margin %" / "אחוז רווח" / "שולי רווח" → gross profit / \`SUM(line_total)\` × 100
This is exactly the client's Qlik definition. Do NOT add subsidy to it. Many
subsidised items sell below cost, so negative gross profit is real, not an error
("מוצרים שנמכרים בהפסד" = items whose gross profit is below zero).
Purchase-cost change over time ("התייקרות מחירי קנייה") = \`line_cost / quantity\`
per item compared across periods, from order lines — NOT products.unit_cost,
which is only today's value.

### RULE 3b — supplier
\`products.supplier_name\` (שם ספק) is filled on every item that has ever sold,
so sales by supplier cover all product revenue. Empty only on never-sold
catalogue rows.

### RULE 4 — prefer the materialized views for aggregates
| view | grain | use for |
|---|---|---|
| \`mv_orders_daily\` | day | orders, members, revenue, cost, gross_profit, subsidy, units, shipping, coupons, discounts, orders_with_coupon, order_total_inc_vat |
| \`mv_sales_daily_item\` | day × item | top sellers / profit per item over a period (has supplier_name) |
| \`mv_sales_daily_supplier\` | day × supplier | revenue, cost, gross profit, units by supplier |
| \`mv_sales_item\` | item (lifetime) | best sellers overall, loss-making items, stock vs demand, supplier, unit_cost |
| \`mv_customers\` | member | repeat rate, spend per member |
| \`mv_orders_by_status\` | day × status | order status flow |

The views already filter \`line_kind = 'product'\` for product measures and
already join the order date, so a question they cover needs no join at all.

### RULE 5 — products carry TODAY's values
\`products.unit_cost\` and \`catalogue_subsidy\` are current values. NEVER use
them to value a past order — the order line carries the price and cost actually
recorded. There is no catalogue price column any more; the price paid is
\`order_lines.unit_price\`. Ignore \`products.unit_cost_duplicate\` — an exact
copy of unit_cost delivered under a junk header.

### RULE 6 — deduplicate the catalogue before joining
\`products\` can repeat an \`item_id\`. Join through
\`SELECT DISTINCT ON (item_id) ... ORDER BY item_id, updated_at DESC NULLS LAST\`
or use a materialized view, which already does. A duplicated dimension row
multiplies every fact it joins — the same defect inflated another client's
revenue by 44.6%.

### RULE 7 — two status columns, and they disagree
\`order_status\` (the system's) and \`display_status\` (the Hebrew display value)
differ on 7,176 of 19,062 orders. Whichever you use, NAME it in the output
column so the reader knows which one they got. \`counts_for_totals\` is 1 on
every row in this delivery and filters nothing — do not use it as a filter and
do not describe it as one.

### RULE 8 — the calendar is a dimension, not evidence
\`${schemaName}.calendar\` covers the whole year, which can reach past the last
order date. Joining to the calendar without filtering to the orders' own range
invents empty days and turns a trend into a cliff. Drive every trend from
\`orders.order_date\`.

### RULE 9 — what this data CANNOT answer. Refuse; do not substitute.
- **Product category.** The product export carries no usable category id;
  \`categories\` holds marketing collections ("חגיגת שבועות", "הסל שלנו"), not a taxonomy. There is
  no way to group sales by product category. Do not group by product name,
  brand id or anything else and present it as a category.
- **VAT split.** \`tax\` is 0.0000 on every line, so there is no ex/inc VAT split.
- **Store, branch, cashier, seller.** Online only.
`;
}

module.exports = { superhistRules };
