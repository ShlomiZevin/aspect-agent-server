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

## Status: FACTS MODELED — ready to load; dimension files pending

The `Facts_ZolStock_CSV.csv` export (~39.5M rows) has been analyzed and fully
modeled (single wide `facts` table + indexes + materialized views, the
thestock/hypertoy pattern — decided against splitting per-record-type).
Dimension files (products / customers / stores / calendar) have NOT been
delivered yet. See `tasks/pending/task-zolstock-agent-setup.md`.

**Done:**
- Client: config, page, theme (blue+yellow from logo), registry, routes, i18n, logo
- Server: crew + tool (`fetch_zolstock_data`), `db.zolstock.js`, data-reload registration, seed script
- Pipeline (facts): `column-aliases-zolstock.js` (52 cols), `create-zolstock-schema.js`, `create-zolstock-indexes.js`, `create-zolstock-mvs.js`, `reload-zolstock.js` (`FILE_TO_TABLE` → facts)
- `services/sql-generator.service.js` — full `zolstock` rules block (record_type, revenue/profit, MV usage, examples)

**To do:**
- Upload `Facts_ZolStock_CSV.csv` to GCS `zolstock/` prefix
- Set `ZOLSTOCK_RELOAD_ENABLED=true`; run Phase 1 + Phase 2 from the admin UI
- When dimension files arrive: add their maps to `column-aliases-zolstock.js` + `FILE_TO_TABLE`, indexes, and JOINs in the crew/sql-generator (item/store/customer names)

---

## Database Schema

**Schema:** `zolstock` (PostgreSQL, in the shared aspect-data-db instance)

### facts — wide table (~39.5M rows), `record_type` discriminator

| record_type | What it is | Rows | Key columns |
|---|---|---|---|
| `מכירות` | Retail sales | ~34.8M | qty_sold, unit_price, line_total (rev ex-VAT), cogs, store_number, item_number, seller, customer_number |
| `מלאי` | Inventory snapshots | ~2.8M | store_number, item_number, inventory_qty, min_inventory |
| `` (empty) | Agent/branch wholesale | ~1.9M | agent_sales_ex_vat, agent_sales_inc_vat, agent_sale_customer, agent |

**Revenue (ex-VAT) = SUM(line_total). Profit (ex-VAT) = SUM(line_total - cogs)** — cost is on the line, no JOIN needed.

### Materialized views (heavy aggregations)
`mv_sales_daily`, `mv_sales_daily_item`, `mv_sales_daily_store`, `mv_sales_daily_seller` — all carry revenue_ex_vat / revenue_inc_vat / total_cogs / profit_ex_vat / total_qty / line_count.

### Not yet delivered
No products / customers / stores / calendar dimension tables. Group by `item_number` / `store_number` / `seller` keys until those files arrive.

---

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
