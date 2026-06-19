# Teva Naot — Footwear Retail Business Intelligence

## Overview

Teva Naot (Hebrew: טבע נאות) is an Israeli footwear (shoes) retail company. This agent
answers BI questions over real sales, inventory, product, customer, order and supplier
data, following the same pattern as zer4u / hypertoy / zolstock: NL question → SQL
Generator (Claude) → query on the `tevanaot` PostgreSQL schema → analyzed answer.

**Model:** GPT-4o (configurable via `TEVANAOT_CREW_MODEL`)
**Language:** Bilingual — responds in the language the user writes in
**Knowledge Base:** None
**Max Tokens:** 4,096

---

## Data model — QlikSense star schema (KEY INSIGHT)

The source is a QlikSense export. The fact tables carry only measures + a **synthetic
composite key**; every dimension component is embedded in the key, so we resolve them by
regexp/`split_part` and do NOT load the 1.2GB `LINK_TABLE` bridge or the 12M-empty-row
`Calendar` files (skipped — see `reload-tevanaot.js` FILE_TO_TABLE).

| Fact | Composite key | Encodes |
|------|---------------|---------|
| sales | `warhs_cust_part_date_key` | WARHS-CUST-PART-DATE (DATE = Excel serial, e.g. `11-13-55396-44890`) |
| inventory | `branch_part_key` | BRANCH-PART (`17-8538`) |
| inventory_in_date | `end_month_branch_part_key` | DATE(dd/mm/yyyy)-BRANCH-PART |
| orders | `part_cust_date_key` | PART-CUST-DATE |

`scripts/create-tevanaot-mvs.js` materializes **`mv_sales`** — the sales key resolved
ONCE into typed `transaction_date` / `warhs` / `part` / `cust` columns + measures — so the
agent queries clean columns instead of parsing keys on every request.

---

## Database Schema

**Schema:** `tevanaot` (PostgreSQL, in shared aspect-data-db instance)

| Table / View | Description |
|--------------|-------------|
| mv_sales | RESOLVED item-level sales (~2.7M rows) — **use for all sales questions** |
| mv_sales_daily | daily sales totals (fast revenue / trend) |
| sales | raw key-only sales fact (resolved by mv_sales — do not query directly) |
| parts | product master (model / color / size / shoe type / gender / collection / season / supplier) |
| sites | store / warehouse master |
| inventory | current stock (BRANCH-PART key) |
| inventory_in_date | end-of-month stock (DATE-BRANCH-PART key) |
| orders | customer orders (PART-CUST-DATE key) |
| customers | customer master |
| purchase_orders | supplier purchase orders |
| suppliers | supplier master |
| sales_rate | per branch-part sales velocity (Qlik-derived) |

**Skipped (not loaded):** LINK_TABLE, Calendar, CalendarGroupA/B, Dynamic_Report_* (bridge / metadata / empty junk).

---

## Tool: `fetch_tevanaot_data`

Same shape as zer4u/hypertoy/zolstock: NL question → SQL Generator (Claude) → query on
`tevanaot` schema → analyzed response. SQL rules live in
`services/sql-generator.service.js` (the `tevanaot` rules block).

---

## File Structure

```
agents/tevanaot/
├── AGENT.md                    # This file
├── data-reload.js              # Registers reloader with DataReloadService
└── crew/
    ├── index.js                # Crew exports
    └── tevanaot.crew.js        # Single BI crew with fetch_tevanaot_data tool
```

**Related files:**
- `services/db.tevanaot.js` — DB pool re-export (shared aspect-data-db)
- `scripts/reload-tevanaot.js` — two-phase zero-downtime reload (GCS folder `tevanaot/`)
- `scripts/column-aliases-tevanaot.js` — CSV header → English DB column mapping
- `scripts/create-tevanaot-schema.js` — schema creation
- `scripts/create-tevanaot-indexes.js` — index creation
- `scripts/create-tevanaot-mvs.js` — materialized views (mv_sales resolves the key)
- `scripts/seed-tevanaot-agent.js` — seeds the `agents` row in the main DB
- `scripts/test-tevanaot-flow.js` — agent test harness

## Enabling the data reload

The reloader is DISABLED by default. To run Phase 1/2 from the admin Data Loader UI, set
`TEVANAOT_RELOAD_ENABLED=true` in the prod env (`.env.production.aspect`). Optional import
window via `TEVANAOT_IMPORT_MONTHS` (0 = all). CSVs already in GCS `aspect-clients-data/tevanaot/`.
