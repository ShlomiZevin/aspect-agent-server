# Zol Stock - Discount Retail Chain Business Intelligence

## Overview

Zol Stock (Hebrew: זול סטוק; website: zolstock.co.il) is a discount retail chain in Israel selling everyday consumer products (kitchenware, textiles, office supplies, disposables, gifts, electrical appliances, seasonal goods, cleaning products, home furnishings) across many branches nationwide.

This agent answers business questions by generating and executing SQL queries against a PostgreSQL database, then analyzing results with actionable insights — same pattern as zer4u / thestock / hypertoy.

> **NOT** the same customer as **The Stock** (הסטוק, hastok-sale.com). Zol Stock (זול סטוק, zolstock.co.il) is a separate, unrelated chain. Keep schemas, themes, and slugs distinct.

**Model:** GPT-4o (configurable via `ZOLSTOCK_CREW_MODEL`)
**Language:** Bilingual — responds in the language the user writes in (Hebrew/English)
**Knowledge Base:** None
**Max Tokens:** 4,096

---

## Status: LIVE — rebuilt 2026-08-19 for the four-file delivery

The client reduced the feed to four files: `Fact`, `Items`, `Stores`,
`Calander`. Two previously-loaded sources are retired and no longer mapped:
`Facts_ZolStock_CSV.csv` (plural, 7.8GB, last exported 2026-06-05) and
`Inventory_ZolStock_CSV.csv` (3.1GB). Both remain in the GCS folder for audit;
the loader skips anything absent from `FILE_TO_TABLE`.

**The single most important consequence: this dataset no longer contains any
money.** The retired plural file was the only source of actual revenue, cost of
sales, discounts, campaigns, sellers, invoices, retail customers and store
targets. Everything monetary is now DERIVED from item list prices — see below.

---

## Database Schema

**Schema:** `zolstock` (PostgreSQL, in the shared aspect-data-db instance)

### facts — one table, 29,910,277 rows, five row kinds

The delivered file concatenates five kinds of row and ships **no discriminator
column** — the kind is implied by which columns are populated. Because guessing
that from NULL patterns is exactly what produced silently-empty answers before,
Phase 2 adds a STORED generated `record_type` column at load time.

| record_type | Rows | Key columns |
|---|---|---|
| `sales` | 26,905,987 | `row_date`, `store_number`, `item_number_sales`, `qty_sold` |
| `store_inventory` | 2,983,200 | `store_number`, `store_inventory_qty` — **no date** |
| `warehouse_inventory` | 8,924 | `sku`, `warehouse`, `warehouse_qty` — **no date** |
| `customer_order` | 11,488 | `priority_customer_number`, `sku`, `row_date`, `customer_order_id`, `customer_order_qty` |
| `purchase_order` | 677 | `sku`, `row_date`, `purchase_order_id`, `purchase_order_qty` |

### Money is derived, and it is an estimate

`items.consumer_price` (99.6% populated) and `items.cost_ex_vat` (98.7%) are the
only prices in the dataset. The materialized views compute:

```
revenue_list_ex_vat = qty_sold * consumer_price / 1.18
profit_list_ex_vat  = qty_sold * (consumer_price / 1.18 - cost_ex_vat)
```

VAT is 18%, verified against the delivered item master (26.02 / 22.05 = 1.1800).
`consumer_price` is the shelf price and therefore VAT-inclusive, so dividing by
1.18 is what makes it comparable with `cost_ex_vat`; mixing the two bases
overstates margin by roughly 18 points.

**These figures exclude discounts and promotions.** They are list-price
estimates, not takings, and the column names say so on purpose. Never present
them as actual revenue.

### Two item keys, not interchangeable

- `facts.item_number_sales` → `items.item_number` — the SALES key, joins at
  99.9% (26,877,988 of 26,905,987). 139,089 distinct items have sales.
- `facts.sku` → `items.sku` — the REPLENISHMENT key, used by warehouse stock and
  orders. Only 14,649 of 298,555 items have a sku at all.

### Materialized views

| View | Grain | Rows |
|---|---|---|
| `mv_sales_daily` | day | ~600 |
| `mv_sales_daily_store` | day × store | ~58k |
| `mv_sales_monthly_item` | month × item | ~1-2M |
| `mv_sales_item_total` | item, lifetime | ~139k |
| `mv_sales_monthly_category` | month × category | ~1k |
| `mv_store_inventory` | store × sku | ~433k |
| `mv_warehouse_inventory` | sku | ~8.9k |
| `mv_open_orders` | order line | ~12k |

There is deliberately **no daily-by-item view**: distinct (date, store, item)
exceeds 16.7M of 26.9M sales rows, so that grain barely compresses the base
table — and it is what made item questions take 566 seconds and time out in
chat. Every view carries a UNIQUE index so refreshes can run CONCURRENTLY
instead of taking ACCESS EXCLUSIVE.

### Dimensions

- `items` — 303,508 rows, 298,555 distinct `item_number`. **1,859 item numbers
  repeat**, a silent 1.7% fan-out on a naive join; deduplicate before aggregating.
- `stores` — 139 rows, 96 with sales. `store_number` is clean in this delivery
  and joins directly; the old `SPLIT_PART(store_label,' ',1)` workaround is obsolete.
- `calendar` — 733 rows with Hebrew holiday names on 111 dates.

### Known data-quality gaps

- 2,549,776 store-inventory rows (85% of that kind) carry **no item key and no
  date**. They are loaded rather than dropped so nothing vanishes silently, but
  they cannot be attributed to a product — `mv_store_inventory` covers only the
  433,424 rows that can.
- Inventory has no history at all, only a current snapshot. It cannot be trended.
- Sales run **2025-01-01 to 2026-08-17**. Purchase-order rows carry dates ahead
  of the last sale, so anchor "now" to sales rows only.

---

## Modules

**Smart Replenishment** is available for this dataset (`status=ready`,
binding stored). It answers "what to order, how much, when" from a nightly-
built `mv_replenishment_base` plus a per-supplier delivery time the client
configures. When it is enabled it adds a `fetch_replenishment` crew tool, a
client page at `/intelligence/zolstock/purchasing`, and a `replenishment`
category in the Intelligence report. When it is not, none of those exist.

The gate number: **only 2 of 446 suppliers** have catalogue coverage you can
order against. See `docs/features/replenishment.md`.

## Two supplier columns — and the views changed meaning

`items.positive_supplier` is the supplying COMPANY (what a buyer means by
"ספק"); `items.supplier` is the manufacturer, whose Latin values are stored
character-reversed. Until 2026-08-27 the sales MVs carried the manufacturer
under the name `supplier`, so every "sales by supplier" answer grouped by the
wrong dimension. On the views `supplier` now means the supplying company and
the old value is available as `manufacturer`. Takes effect on the next
reload.

## Tool: `fetch_zolstock_data`

The single tool that powers all data queries.

```
Flow:
  1. User asks a business question (Hebrew or English)
  2. LLM decides to call fetch_zolstock_data
  3. SQL Generator Service translates question → PostgreSQL query
  4. Query executes on the zolstock schema with 15-second timeout
  5. Results returned: { sql, data, rowCount, columns, summary, confidence }
  6. LLM analyzes results and responds with business insights
```

---

## File Structure

```
agents/zolstock/
├── AGENT.md                # This file
├── data-reload.js          # Registers reloader with DataReloadService (disabled until ZOLSTOCK_RELOAD_ENABLED=true)
└── crew/
    ├── index.js            # Crew member exports
    └── zolstock.crew.js     # Single BI crew with fetch_zolstock_data tool
```

**Related files:**
- `services/data-query.service.js` — executes NL questions as SQL queries
- `services/sql-generator.service.js` — translates natural language → PostgreSQL (zolstock rules block: TODO)
- `services/db.zolstock.js` — DB pool re-export
- `scripts/reload-zolstock.js` — two-phase zero-downtime data reload (FILE_TO_TABLE: TODO)
- `scripts/column-aliases-zolstock.js` — CSV header → English DB column mapping (COLUMN_MAP: TODO)
- `scripts/create-zolstock-schema.js` — schema creation (data-agnostic)
- `scripts/create-zolstock-indexes.js` — index creation (INDEXES: TODO)
- `scripts/seed-zolstock-agent.js` — seeds the `agents` row in the main DB
```
