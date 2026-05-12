# The Stock - Retail Chain Business Intelligence

## Overview

The Stock (Hebrew: הסטוק; website: hastok-sale.com) is a retail chain in Israel. This agent answers business questions by generating and executing SQL queries against a PostgreSQL database, then analyzing results with actionable insights.

The Stock and Hyper Toy are sister brands inside the same retail group — the product catalog references both brands' standard costs.

**Model:** GPT-4o (configurable via `THESTOCK_CREW_MODEL`)
**Language:** Bilingual — responds in the language the user writes in (Hebrew/English)
**Knowledge Base:** None
**Max Tokens:** 4,096

---

## Crew System (Single Crew)

The Stock has a single crew member — no transitions, no crew selector switching. The user interacts directly with the BI advisor.

---

## Tool: `fetch_thestock_data`

The single tool that powers all data queries.

```
Parameters:
  question: string — natural language business question (Hebrew or English)

Flow:
  1. User asks a question
  2. LLM decides to call fetch_thestock_data
  3. SQL Generator Service translates question → PostgreSQL query
  4. Query executes on thestock schema with 15-second timeout
  5. Results returned: { sql, data, rowCount, columns, summary, confidence }
  6. LLM analyzes results and responds with business insights
```

---

## Database Schema

**Schema:** `thestock` (PostgreSQL, in the shared aspect-data-db instance)

**Tables:**

| Table | Records | Description |
|-------|---------|-------------|
| payments | ~9.8M | Payment lines per transaction (amount, type, transaction_id) |
| credits | ~158K | Credits / refunds / employee + special discounts |
| customers | ~1.07M | Customer master with PII (names, ID, phone, email, city) |
| products | ~61K | Product catalog with supplier mix and cross-brand cost |
| warehouses | ~168 | Warehouse / branch master |
| inventory_c100 | ~901K | Inventory at C100 ("disconnected" items) warehouse |
| calendar | 868 | Date dimension |
| calendar_compare | 868 | Comparison-period dimension |

---

## Important Data Limitations

The dataset does NOT include an item-level sales / transactions fact table linking products to transactions (no analog to newdeli's `order_items`). Cannot answer:
- Top-selling products
- Sales by product category or family
- Revenue per branch (no link from `payments` to branch)
- Customer baskets / what customers buy together
- Sales trends over time

The source system (QlikSense) likely has this data — the `Measures_CSV.csv` metadata file from the original zip references columns like `[כמות שנמכרה]` (qty sold), `[מכירות ללא מעמ]` (sales ex-VAT), `[Invoice ID]`, `[Campaign]` that are absent from the loaded data. When this becomes a blocker, ask Shlomi to export the missing sales fact table.

---

## Architecture

### No Transitions
Single crew, no `transitionTo`, no crew switching logic.

### No Context Persistence
Stateless conversations — each message is independent.

### No Field Collection
No `fieldsToCollect`. Conversations start immediately with the user's question.

---

## Data Flow

```
User types business question
  → ChatService sends to /api/{agentName}/stream
  → Dispatcher routes to The Stock crew (only option)
  → LLM decides to call fetch_thestock_data
  → SQL Generator creates PostgreSQL query
  → Query executes with 15s timeout
  → Results returned to LLM
  → LLM provides analysis with business insights
  → Response streamed via SSE (includes thinking steps showing SQL)
```

---

## File Structure

```
agents/thestock/
├── AGENT.md                # This file
├── data-reload.js          # Registers reloader with DataReloadService
└── crew/
    ├── index.js            # Crew member exports
    └── thestock.crew.js    # Single BI crew with fetch_thestock_data tool
```

**Related files:**
- `services/data-query.service.js` — executes NL questions as SQL queries
- `services/sql-generator.service.js` — translates natural language → PostgreSQL
- `services/db.thestock.js` — DB pool re-export
- `scripts/reload-thestock.js` — two-phase zero-downtime data reload
- `scripts/column-aliases-thestock.js` — CSV header → English DB column mapping
- `scripts/create-thestock-schema.js` — schema creation
- `scripts/create-thestock-indexes.js` — index creation
- `scripts/seed-thestock-agent.js` — seeds the `agents` row in the main DB
