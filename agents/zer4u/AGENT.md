# Zer4U - Flower Shop Business Intelligence

## Overview

Zer4U is a standalone Business Intelligence agent for the Zer4U flower shop chain in Israel. It answers business questions by generating and executing SQL queries against a real PostgreSQL database, then analyzing results with actionable insights.

**Model:** GPT-4o
**Language:** Bilingual — responds in the language the user writes in (Hebrew/English)
**Knowledge Base:** None
**Max Tokens:** 4,096

---

## Crew System (Single Crew)

Zer4U has a single crew member — no transitions, no crew selector switching. The user interacts directly with the BI advisor.

```
[Zer4U] — single specialist, always active
```

### Zer4U Crew

**Purpose:** Financial business intelligence advisor with real database access.

**Capabilities:**
- Analyze sales data, inventory, customer behavior
- Identify trends and patterns
- Provide actionable insights and recommendations
- Answer specific questions about business metrics

**Personality:**
- Professional but friendly
- Always bases answers on actual data (never makes up numbers)
- Includes relevant business terms with context
- Proactively translates Hebrew business jargon

---

## Tool: `fetch_zer4u_data`

The single tool that powers all data queries.

```
Parameters:
  question: string — natural language business question (Hebrew or English)
             Examples: "total sales last month", "top 10 customers", "inventory levels"

Flow:
  1. User asks a question
  2. LLM decides to call fetch_zer4u_data
  3. SQL Generator Service (Claude) translates question → PostgreSQL query
  4. Query executes on zer4u schema with 15-second timeout
  5. Results returned: { sql, data, rowCount, columns, summary, confidence }
  6. LLM analyzes results and responds with business insights

Error Handling:
  - Timeout detection (15s limit)
  - Suggests narrower date ranges or rephrasing on failure
  - Returns generated SQL for transparency
```

---

## Database Schema

**Schema:** `zer4u` (PostgreSQL)

**Core Tables:**
| Table | Records | Description |
|-------|---------|-------------|
| Sales | 9.4M | All transactions — dates, amounts, products, customers, stores |
| Inventory | 19.8M | Stock levels and values |
| Items | 28K | Product catalog, pricing, classifications |
| Customers | 1.4M | Customer info, locations, demographics |
| Stores | 94 | Store master data, managers, types, lifecycle |
| Targets | — | Business goals and targets |
| Calendar | — | Date dimensions with Hebrew fields |

**Materialized Views (critical for performance):**
| View | Use Case |
|------|----------|
| `mv_sales_by_year` | Annual totals |
| `mv_sales_by_month` | Monthly totals/trends |
| `mv_sales_by_store_month` | Store performance by month |
| `mv_sales_by_store` | All-time store totals |
| `mv_sales_by_customer` | Customer spending / top customers |
| `mv_sales_by_product` | Product performance / top products |

**Performance Rules:**
- NEVER aggregate directly on the 9.4M sales table without date filters
- ALWAYS use materialized views for aggregated queries
- Use `zer4u.to_int_safe()` for store/customer number conversions (expression-indexed)
- Use `zer4u.parse_date_ddmmyyyy()` for date parsing (expression-indexed)
- NEVER use `TO_DATE()` or direct `::integer` casts (skips indexes)

---

## Architecture

### No Transitions
Single crew, no `transitionTo`, no crew switching logic.

### No Context Persistence
No `getContext()` or `writeContext()` calls. Each message is independent — stateless conversations.

### No Field Collection
No `fieldsToCollect`. Conversations start immediately with the user's question.

### Chat History
Messages stored in PostgreSQL. Users can view past conversations.

---

## Data Flow

```
User types business question
  → ChatService sends to /api/{agentName}/stream
  → Dispatcher routes to Zer4U crew (only option)
  → LLM decides to call fetch_zer4u_data
  → SQL Generator (Claude) creates PostgreSQL query
  → Query executes with 15s timeout
  → Results returned to LLM
  → LLM provides analysis with business insights
  → Response streamed via SSE (includes thinking steps showing SQL)
```

---

## Client Configuration

- **Theme:** Green natural theme (`theme-zer4u`) — primary #16a34a
- **Welcome Icon:** green leaf emoji
- **Crew Mode:** `"tabs"` with right-side positioning
- **Features:** Chat history enabled, KB/file upload/logo upload disabled
- **Quick Questions:** 10 categories — sales overview, top products, store performance, inventory, top customers, YoY comparison, savings tips, inventory issues, targets, slow-moving products

---

## Dual Presence

Zer4U exists in two places:
1. **Standalone agent** (`/zer4u` route) — this folder, single-crew dedicated BI
2. **Aspect crew member** (`agents/aspect/crew/zer4u.crew.js`) — one of 4 tabs within the Aspect agent

Both share the same tool and database schema.

---

## File Structure

```
agents/zer4u/
├── AGENT.md                 # This file
└── crew/
    ├── index.js             # Crew member exports
    └── zer4u.crew.js        # Single BI crew with fetch_zer4u_data tool
```

**Related files:**
- `services/data-query.service.js` — executes NL questions as SQL queries
- `services/sql-generator.service.js` — translates natural language → PostgreSQL via Claude
- `agents/aspect/crew/zer4u.crew.js` — same crew exported within Aspect agent
