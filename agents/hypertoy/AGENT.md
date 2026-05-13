# Hyper Toy - Toy Retail Chain Business Intelligence

## Overview

Hyper Toy (Hebrew: היפר טוי) is a toy retail chain in Israel, part of a retail holding that also includes **The Stock** (הסטוק) and **Pirat** (פיראט). The product catalog references all three brands' standard costs side by side.

Unlike The Stock, Hyper Toy data DOES include an item-level sales facts table — so this agent can answer top-products, sales-by-period, profit-margin, target-vs-actual, and cashier-performance questions.

**Model:** GPT-4o (configurable via `HYPERTOY_CREW_MODEL`)
**Language:** Bilingual — responds in the language the user writes in
**Knowledge Base:** None
**Max Tokens:** 4,096

---

## Database Schema

**Schema:** `hypertoy` (PostgreSQL, in shared aspect-data-db instance)

| Table | Rows | Description |
|-------|------|-------------|
| facts | ~1.97M | Wide fact table — mixes sales/inventory/targets by `record_type` |
| payments | ~670K | Payment lines per transaction |
| pay_accounts | ~726K | Bank account per transaction |
| credits | ~38K | Refunds / employee + special discounts |
| customers | ~128K | Customer master with PII |
| products | ~60K | Product catalog (Hyper Toy + cross-brand cost vs The Stock + Pirat) |
| warehouses | ~50 | Warehouse / branch master |
| stores | ~96 | Store master (regional manager, store type, lifecycle dates) |
| inventory_500 | ~3K | Inventory snapshot at warehouse 500 |
| calendar | 346 | Date dimension |
| calendar_compare | 346 | Comparison-period dimension |

---

## Key Insight: `facts.record_type` discriminator

The `facts` table is intentionally wide and mixes three record kinds — always filter:

| record_type | What it is | Key columns populated |
|---|---|---|
| `מכירות` (sales) | Real transactions | sale_price, qty_sold, sales_ex_vat, profit_ex_vat, cashier, transaction_id, customer_id |
| `מלאי` (inventory) | Stock snapshots | inventory_balance, inventory_value |
| `יעדים` (targets) | Sales / loyalty goals | sales_target, loyalty_target |

The SQL generator is instructed to always include `WHERE record_type = 'מכירות'` for sales questions.

---

## Tool: `fetch_hypertoy_data`

Same shape as zer4u/newdeli/thestock: NL question → SQL Generator (Claude) → query on `hypertoy` schema → analyzed response.

---

## File Structure

```
agents/hypertoy/
├── AGENT.md                    # This file
├── data-reload.js              # Registers reloader with DataReloadService
└── crew/
    ├── index.js                # Crew exports
    └── hypertoy.crew.js        # Single BI crew with fetch_hypertoy_data tool
```

**Related files:**
- `services/data-query.service.js` — executes NL questions as SQL queries
- `services/sql-generator.service.js` — translates NL → PostgreSQL (hypertoy rules block included)
- `services/db.hypertoy.js` — DB pool re-export
- `scripts/reload-hypertoy.js` — two-phase zero-downtime data reload
- `scripts/column-aliases-hypertoy.js` — CSV header → English DB column mapping (132 columns across 11 tables)
- `scripts/create-hypertoy-schema.js` — schema creation
- `scripts/create-hypertoy-indexes.js` — index creation (28 indexes)
- `scripts/seed-hypertoy-agent.js` — seeds the `agents` row in the main DB
