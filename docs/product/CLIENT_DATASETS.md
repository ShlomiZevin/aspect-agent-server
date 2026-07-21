# Client Datasets — Zer4U and Hyper Toy

> Companion to [ASPECT_OVERVIEW.md](./ASPECT_OVERVIEW.md). Facts below are sourced directly from the data-loader scripts, dataset/schema definitions, and each agent's `AGENT.md` as of 2026-07-16. Anything not directly confirmed in code is marked "unconfirmed."

## Zer4U (זר4יו — flower shop chain)

**Database:** dedicated `zer4u` database — not the shared `aspect-data-db` instance the other retail agents use.

### Tables and scale (source: `agents/zer4u/AGENT.md`)

| Table | Rows (approx.) | Loaded from |
|---|---|---|
| sales | 9.4M | מכירות.csv |
| inventory | 19.8M | מלאי.csv |
| warehouse_inventory | — | מלאי מחסנים.csv |
| min_inventory | — | מלאי מינימום.csv |
| items | 28K | פריטים.csv |
| customers | 1.4M | לקוחות.csv |
| stores | 94 | חנויות.csv |
| targets | — | יעדים.csv |
| multips | — | מולטיפס.csv |
| inventory_count_dates | — | תאריכי ספירת מלאי.csv |

Plus materialized views built for query performance: `mv_sales_by_year`, `mv_sales_by_month`, `mv_sales_by_store_month`, `mv_sales_by_store`, `mv_sales_by_customer`, `mv_sales_by_product`, `mv_sales_by_category_month`.

### How it can be used

Sales, inventory, items, customers, stores, and targets are all present, which supports questions like: revenue/transactions by period, store, category, or product; inventory levels and stockouts by warehouse; target attainment by store/category/period; customer-level purchase history (with the caveat below on table size).

### Data-quality rules that must be respected (confirmed in `services/sql-generator.service.js`, lines ~746-825)

These exist because the raw data is genuinely easy to misread — any new query surface (including a future Aspect BI dataset for zer4u) needs to encode the same rules:

- **Revenue** — the correct column has a non-ASCII Hebrew name and cannot be typed reliably in ad-hoc SQL; the plain `revenue` column excludes vouchers and under-reports. Always read `total_revenue` from a materialized view, never the raw column.
- **VAT** — all monetary figures are ex-VAT by convention. There is no VAT-inclusive column; do not invent one.
- **Transaction counts** — `COUNT(*)` on the sales table over-counts by roughly 2.7x because it counts line items, not receipts. Correct formula: `COUNT(DISTINCT invoice) WHERE NOT in hesbonithiuvi` minus `COUNT(DISTINCT invoice) WHERE IN hesbonithiuvi`.
- **Category matching** — name-matching on `item_name` (e.g. `ILIKE '%chocolate%'`) produces both false positives and false negatives (a chocolate liqueur gets miscategorized; a branded chocolate product without the word "chocolate" in its name gets missed — observed to be off by roughly 60x on at least one category/month). The correct source is `mv_sales_by_category_month`, keyed on `items.item_group`.
- **Targets** — the `targets."Target"` column is text with a trailing `%` that must be stripped before casting to numeric; the target's key is a `**`-delimited composite string (category/store/date) requiring `SPLIT_PART` + `TO_DATE` parsing.
- **Not tracked at all** — payment method/type has no column; discount totals exist only in non-aggregatable text columns.
- **Large tables** — do not aggregate directly on the 9.4M-row sales table without a date filter.

*Unconfirmed in this pass, but present in prior project notes:* a "list all customers"-style query against the 1.4M-row customers table has been observed to take ~213s and trip a 1M-row safety cap — worth re-verifying against current code before citing as a hard limit.

---

## Hyper Toy (היפר טוי — toy retail chain)

**Database:** shared `aspect-data-db` instance (schema `hypertoy`).

**Business context:** part of a retail holding group alongside The Stock (הסטוק) and Pirat (פיראט); the products table carries standard-cost columns for all three sister brands. Hyper Toy is explicitly the only chain in the group with real **item-level** sales data — The Stock's own `AGENT.md` states it lacks this, so questions like top-products, category/branch revenue, and basket analysis are possible for Hyper Toy but not (yet) for The Stock.

### Tables and scale (source: `agents/hypertoy/AGENT.md`)

| Table | Rows (approx.) | Loaded from | Notes |
|---|---|---|---|
| facts | 1.97M | Fact_CSV.csv | sales + inventory + targets, discriminated by `record_type` |
| payments | 670K | PaymentType_CSV.csv | |
| pay_accounts | 726K | PAYACCOUNT_CSV.csv | |
| credits | 38K | Credit_CSV.csv | |
| customers | 128K | Customers_CSV.csv | contains PII |
| products | 60K | Pritim_CSV.csv | carries cost columns for Hyper Toy, The Stock, and Pirat |
| warehouses | 50 | Machsanim_CSV.csv | |
| stores | 96 | עותק של חנויות_CSV.csv | |
| inventory_500 | 3K | Mlay500_CSV.csv | |
| calendar / calendar_compare | 346 each | Calander_CSV.csv / Calander_Compare_CSV.csv | |

### The Aspect BI semantic model (`bi/datasets/hypertoy.dataset.js`)

This is the dataset already wired into the Aspect BI dashboard tool (see ASPECT_OVERVIEW.md §2). Base table `facts`, discriminated by `record_type` (`מכירות`=sales, `מלאי`=inventory, `יעדים`=targets), joined to `products`, `warehouses`, `stores`, `customers`.

**19 dimensions**, grouped:
- **Time** (6) — day, week, month, quarter, year, day-of-week
- **Store** (5) — store, region, branch, store type, regional manager
- **Product** (5) — product description, SKU, product family, supplier, item status
- **Sales context** (4) — cashier, register, campaign, document type
- **Customer** (1) — customer city

**12 measures:**
- revenue, revenue_inc_vat, profit (all ex-VAT unless stated) — sales records only
- margin_pct (computed: profit / revenue × 100)
- qty_sold
- line_count — deliberately `COUNT(*)`, not `COUNT(DISTINCT transaction_id)`; a code comment notes DISTINCT over ~2M rows times out
- avg_line_value (computed)
- loyalty_signups
- sales_target — targets records only
- target_attainment_pct — the one measure spanning two record types (sales and targets) in a single query via per-measure `FILTER (WHERE record_type = ...)`
- inventory_units, inventory_value — inventory records only

### How it can be used

Because item-level sales exist and the semantic model already spans sales/inventory/targets in one place, Hyper Toy supports: revenue/profit/margin by any combination of time, store, product, or sales-context dimension; target attainment (actual vs. target) by store/period; inventory levels and value by warehouse/product; cashier- or register-level performance; campaign effectiveness. This is the dataset the current Aspect BI dashboard (`/bi/hypertoy`) is built on, so all of the above is explorable today via the self-serve query builder, not just through chat.

---

## Zer4U vs. Hyper Toy — key differences to keep in mind

| | Zer4U | Hyper Toy |
|---|---|---|
| Database | Dedicated `zer4u` DB | Shared `aspect-data-db` instance |
| Aspect BI dataset | Not yet built | Built — the only dataset live in `/bi` today |
| Sales granularity | Item-level | Item-level |
| Known data traps | Revenue column, transaction counting, category name-matching (all have documented, code-enforced fixes) | `line_count` intentionally not de-duplicated (documented in code comment) for performance |
| Largest table | inventory, 19.8M rows | facts, 1.97M rows |
