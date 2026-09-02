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
 *   3. There is no product category, no cost, and no shop floor. Those are not
 *      gaps to work around with something adjacent; they are refusals.
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

### RULE 1 — order_lines holds TWO row kinds. Always filter.
\`${schemaName}.order_lines\` concatenates product lines and shipping lines. The
kind is given by \`line_kind\`, a derived column added at load time:

| line_kind | rows | what it holds |
|---|---|---|
| \`'product'\` | 634,556 | item_id, quantity, unit_price, line_total, subsidy |
| \`'shipping'\` | 19,814 | one per order, the delivery charge. NO item, NO quantity |

A shipping row carries the delivery method's NAME in \`item_id\`. So:
- Any question about items, units or product revenue MUST say
  \`WHERE line_kind = 'product'\`.
- Delivery income is \`WHERE line_kind = 'shipping'\`, never mixed into revenue
  without saying so.

### RULE 2 — the date lives on the ORDER, not the line
\`order_lines\` has no date column. Every time-based question joins
\`${schemaName}.orders\` and filters \`o.order_date\`. Never invent a date on the
line table.

### RULE 3 — revenue is the line total. Subsidy is NOT subtracted.
\`line_total\` = \`quantity\` × \`unit_price\`, exactly, on every product line, and
it is what the member was charged. An order's \`order_total\` equals its product
lines plus shipping (verified on 19,045 of 19,062 orders).

\`subsidy\` is the Histadrut's contribution — the value of the member benefit,
recorded alongside the charge, NOT deducted from it. Subtracting it from revenue
reconciles with the order total on 12 orders out of 19,062; leaving it alone
reconciles on 19,045.

- "revenue" / "sales" / "מכירות" → \`SUM(line_total)\`
- "subsidy" / "סבסוד" → \`SUM(subsidy)\`, its own measure, never mixed in

### RULE 4 — prefer the materialized views for aggregates
| view | grain | use for |
|---|---|---|
| \`mv_orders_daily\` | day | revenue, orders, members, units, subsidy, shipping |
| \`mv_sales_daily_item\` | day × item | top sellers over a period |
| \`mv_sales_item\` | item (lifetime) | best sellers overall, stock vs demand |
| \`mv_customers\` | member | repeat rate, spend per member |
| \`mv_orders_by_status\` | day × status | order status flow |

The views already filter \`line_kind = 'product'\` and already join the order
date, so a question they cover needs no join at all.

### RULE 5 — products.catalogue_price is TODAY's price
\`products.catalogue_price\` and \`catalogue_subsidy\` are the current shelf
values. NEVER use them to value a past order — the order line carries the price
actually charged. Use catalogue price only for questions about the catalogue
itself ("what does X cost now").

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
\`${schemaName}.calendar\` covers the whole year. The orders cover roughly six
weeks. Joining to the calendar without filtering to the orders' own range
invents empty days and turns a trend into a cliff. Drive every trend from
\`orders.order_date\`.

### RULE 9 — what this data CANNOT answer. Refuse; do not substitute.
- **Product category.** \`products.category_id\` is populated on 547 of 16,537
  products (3.3%) and every one points at a SINGLE id; \`categories\` holds 110
  marketing collections ("חגיגת שבועות", "הסל שלנו"), not a taxonomy. There is
  no way to group sales by product category. Do not group by product name,
  brand id or anything else and present it as a category.
- **Profit, margin, cost of goods.** No cost column exists anywhere in the feed.
  \`tax\` is 0.0000 on all 654,370 lines, so there is no VAT split either.
- **Store, branch, cashier, seller.** Online only.
`;
}

module.exports = { superhistRules };
