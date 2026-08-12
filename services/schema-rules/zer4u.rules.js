/**
 * Zer4U SQL-generation rules.
 *
 * REWRITTEN 2026-08-10 against the live schema. The previous version — inline
 * in sql-generator.service.js — instructed the model to query NINE
 * materialized views that do not exist: mv_sales_by_month, mv_sales_by_store,
 * mv_sales_by_store_month, mv_sales_by_year, mv_sales_by_category_month,
 * mv_sales_by_store_product, mv_sales_by_customer, mv_sales_by_city and
 * mv_sales_by_day. Only mv_sales_by_product and mv_sales_by_product_month are
 * real. Because these rules carry the highest authority in the prompt
 * ("CRITICAL — follow exactly"), every zer4u store / revenue / target question
 * failed with "relation does not exist" or silently fell back to a zero-row
 * query — for months, undetected, because nothing validated them.
 *
 * Every fact below was verified against information_schema and real aggregates
 * before being written down. scripts/test-schema-contract.js now fails the
 * build if any relation named here stops existing.
 *
 * Rules live in their own module (rather than a 1,200-line inline template) so
 * they can be diffed, reviewed and tested per dataset.
 */

function zer4uRules(schemaName) {
  return `
## zer4u-Specific Rules (CRITICAL — follow exactly)

**Zer4U is a florist / gift retail chain. The fact table is \`${schemaName}.sales\`.**

### RULE 1 — Query \`sales\` DIRECTLY. It is small.
\`sales\` holds ~918,000 rows covering 2026-03-01 to 2026-08-09 — roughly five months, which is ALL the data that exists. It aggregates in well under a second, so there is no need to route around it.

Only TWO materialized views exist in this schema, both product-level and both ALL-TIME (they have no date column, so they cannot answer any question about a period):
- \`${schemaName}.mv_sales_by_product\` — (item_code, item_name, total_quantity, total_revenue)
- \`${schemaName}.mv_sales_by_product_month\` — the same, broken down by month

There is NO store-level, customer-level, city-level, daily or monthly materialized view in this schema. Do not use one.

### RULE 2 — Use the English columns; ignore the Hebrew duplicates
\`sales\` has 57 columns, most of them Hebrew-named legacy fields. The clean English ones are the only ones you should touch:
- \`sale_date\` (DATE) — all time filtering
- \`store_id\` (INTEGER) — joins to \`stores\`
- \`item_code\` — joins to \`items\`
- \`customer_id\` — joins to \`customers\`
- \`revenue\` (NUMERIC, excl. VAT) — the sales measure
- \`revenue_incl_vouchers\` (NUMERIC, excl. VAT) — sales including voucher redemptions
- \`quantity\` (NUMERIC) — units sold
- \`cost\` (NUMERIC, excl. VAT) — for profit and margin

Profit = \`SUM(revenue) - SUM(cost)\`. Margin % = \`(SUM(revenue) - SUM(cost)) / NULLIF(SUM(revenue), 0) * 100\`.
NEVER reference a Hebrew column name directly — use the English equivalent above.

### RULE 3 — JOINs (both lookup keys are UNIQUE, so no deduplication is needed)
- Stores: \`LEFT JOIN ${schemaName}.stores st ON s.store_id = st.store_id\` — 94 rows, \`store_id\` unique. Display name is \`st.store_name\`.
- Items: \`LEFT JOIN ${schemaName}.items it ON s.item_code = it.item_code\` — 28,672 rows, \`item_code\` unique. Product name is \`it.item_name\`; the product CATEGORY is \`it.item_group\`.
- Customers: \`LEFT JOIN ${schemaName}.customers c ON s.customer_id = c.customer_id\`

Always order a ranking with \`NULLS LAST\`. Postgres puts NULLs FIRST on \`ORDER BY ... DESC\`, which otherwise fills the top of every ranking with stores that made no sales.

### RULE 4 — Targets
\`${schemaName}.targets\` has exactly two columns, \`"TargetKey"\` and \`"Target"\`, both TEXT.
\`"TargetKey"\` is \`'<category>**<store_id>**<DD/MM/YYYY>'\`, e.g. \`'קופה/העברות בין חנויות בארץ ובחו"ל**38**01/01/2023'\`.
- store id: \`SPLIT_PART("TargetKey", '**', 2)::int\`
- month:    \`TO_DATE(SPLIT_PART("TargetKey", '**', 3), 'DD/MM/YYYY')\`
- value:    \`NULLIF(regexp_replace("Target", '[^0-9.-]', '', 'g'), '')::numeric\` — \`"Target"\` carries non-numeric characters and MUST be cleaned before casting.

There are several category rows per store+month, so SUM them. Compare against actuals by aggregating \`sales\` to the same (store_id, month) grain in a separate CTE and FULL OUTER JOINing on those two keys ONLY — never add item/product to that join key, because targets have no product dimension.

Target rows start in 2023 while \`sales\` only covers 2026 — constrain BOTH sides to the same window, or attainment is computed against targets that have no matching sales and every store looks like it missed.

Reference query — target attainment by store:
\`\`\`sql
WITH t AS (
  SELECT SPLIT_PART("TargetKey", '**', 2)::int AS store_id,
         DATE_TRUNC('month', TO_DATE(SPLIT_PART("TargetKey", '**', 3), 'DD/MM/YYYY')) AS month,
         SUM(NULLIF(regexp_replace("Target", '[^0-9.-]', '', 'g'), '')::numeric) AS target
  FROM ${schemaName}.targets
  GROUP BY 1, 2
),
a AS (
  SELECT store_id, DATE_TRUNC('month', sale_date) AS month, SUM(revenue) AS actual
  FROM ${schemaName}.sales
  GROUP BY 1, 2
)
SELECT COALESCE(t.store_id, a.store_id) AS store_id, st.store_name,
       SUM(t.target) AS target, SUM(a.actual) AS actual,
       ROUND((SUM(a.actual) / NULLIF(SUM(t.target), 0) * 100)::numeric, 2) AS attainment_pct
FROM t
FULL OUTER JOIN a USING (store_id, month)
LEFT JOIN ${schemaName}.stores st ON st.store_id = COALESCE(t.store_id, a.store_id)
WHERE COALESCE(t.month, a.month) >= DATE '2026-03-01'
GROUP BY 1, 2
ORDER BY attainment_pct ASC NULLS LAST
\`\`\`

### RULE 5 — Inventory
\`${schemaName}.inventory\` is ~25M rows — always filter it (by store, item or date) and never scan it whole. \`${schemaName}.warehouse_inventory\` is the smaller warehouse-level equivalent.

### Reference examples

**Revenue by store:**
\`\`\`sql
SELECT st.store_name, SUM(s.revenue) AS revenue, SUM(s.quantity) AS units
FROM ${schemaName}.sales s
LEFT JOIN ${schemaName}.stores st ON s.store_id = st.store_id
GROUP BY st.store_name
ORDER BY revenue DESC NULLS LAST
\`\`\`

**Revenue by product category, by month:**
\`\`\`sql
SELECT it.item_group,
       TO_CHAR(DATE_TRUNC('month', s.sale_date), 'YYYY-MM') AS month,
       SUM(s.revenue) AS revenue
FROM ${schemaName}.sales s
LEFT JOIN ${schemaName}.items it ON s.item_code = it.item_code
GROUP BY 1, 2
ORDER BY 2, 3 DESC NULLS LAST
\`\`\`

**Top items by quantity sold:**
\`\`\`sql
SELECT it.item_name, SUM(s.quantity) AS units, SUM(s.revenue) AS revenue
FROM ${schemaName}.sales s
LEFT JOIN ${schemaName}.items it ON s.item_code = it.item_code
GROUP BY it.item_name
ORDER BY units DESC NULLS LAST
LIMIT 10
\`\`\``;
}

module.exports = { zer4uRules };
