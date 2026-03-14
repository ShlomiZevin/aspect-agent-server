# Aspect Insight - Business Intelligence Agent

## Overview

Aspect is a multi-vertical Business Intelligence (BI) agent that provides financial, operational, and strategic insights for retail organizations. It hosts 4 specialized crew members, each tailored to a different retail vertical. Users manually switch between crews via tabs in the UI.

**Model:** GPT-5-chat-latest (crews 1-3), GPT-4o (Zer4U crew)
**Language:** Bilingual — responds in the language the user writes in (Hebrew/English)
**Knowledge Base:** Disabled (domain knowledge embedded in guidance text)

---

## Crew System (4 Verticals)

Aspect uses **manual crew selection** — no automatic transitions. Users click crew tabs to switch context. All crews have `transitionTo: null`.

```
[Technology] ←→ [FMCG] ←→ [Fashion] ←→ [Zer4U]
     ↑ default
```

### 1. Technology (Default)

**Domain:** Technology & Electronics Retail (TechZone)
**Business Context:** 28 branches + e-commerce, ~8,000 SKUs, ~120M NIS/month revenue

**Key Metrics:**
- Attach Rate (accessories with main devices) — target 60-75%
- Extended Warranty Attach — target 25-40%
- Inventory Turn — target 8-12x/year
- Online share — 15.4% of revenue

**Seasonality:** iPhone launch (Sep, +40-60% spike), Back-to-school (Aug-Sep), Black Friday (Nov)

**Tools:** None — pure LLM-based analysis
**Max Tokens:** 5,000

---

### 2. FMCG (Supermarket/Grocery)

**Domain:** Food & Grocery Retail (Market Plus)
**Business Context:** 42+ branches, ~25,000 SKUs, ~340M NIS/month revenue

**Key Metrics:**
- Average Basket Size — 288 NIS
- Shrinkage — target <2% (produce dept 8-15%)
- Same-Store Sales (SSS)
- GMROI (Gross profit per shekel of inventory)

**Department Economics:**
| Department | Margin | Key Challenge |
|-----------|--------|---------------|
| Produce | 30-40% | 8-15% shrinkage, freshness critical |
| Meat | 25-35% | Highest revenue per transaction, strict expiry |
| Dairy | 15-25% | Cold chain critical |
| Bakery | 50-60% | High spoilage risk |

**Seasonality:** Rosh Hashana (+40-60%), Passover (major category shift), Thu-Fri peak (35-40% of weekly sales)

**Tools:** None

---

### 3. Fashion

**Domain:** Fashion & Apparel Retail (Style Fashion)
**Business Context:** 35 branches + online, ~12,000 SKUs, ~85M NIS/month revenue

**Key Metrics:**
- ATV (Average Transaction Value) — target 280-380 NIS
- UPT (Units Per Transaction) — target 2.5-3.5
- Sell-Through Rate (full price) — target 65-75%
- Markdown Rate — target <30%

**Department Economics:**
| Department | Revenue Share | Margin |
|-----------|-------------|--------|
| Women's | 40-45% | 55-65% |
| Men's | 20-25% | 50-60% |
| Accessories | ~10% | 65-75% (highest) |

**Key Concepts:** Size breaks, dead stock (90+ days), seasonal collection drops

**Tools:** None

---

### 4. Zer4U

**Domain:** Flower Shop BI (real database connection)
**Business Context:** Zer4U flower shop chain (Israel), real PostgreSQL data

**This is the only crew with a tool** — it queries actual business data.

**Tool: `fetch_zer4u_data`**
```
Parameters:
  question: string — natural language question (Hebrew or English)

Flow:
  1. User asks business question
  2. LLM calls fetch_zer4u_data with the question
  3. SQL Generator Service translates question → PostgreSQL query
  4. Query executes on zer4u schema (15s timeout)
  5. Results returned to LLM for analysis
```

**Database:** PostgreSQL `zer4u` schema with materialized views for performance:
- `mv_sales_by_year`, `mv_sales_by_month` — aggregate sales
- `mv_sales_by_store_month`, `mv_sales_by_store` — store performance
- `mv_sales_by_customer` — customer spending
- `mv_sales_by_product` — product performance

**Performance Notes:**
- Sales table has 9.4M records — always use materialized views for aggregation
- Use `zer4u.to_int_safe()` and `zer4u.parse_date_ddmmyyyy()` helper functions (indexed)

**Model:** GPT-4o
**Max Tokens:** 4,096

---

## Architecture

### No Automatic Transitions
All crews have `transitionTo: null`. Users switch crews via the tab selector in the UI. The `overrideCrewMember` parameter in the chat request routes to the selected crew.

### No Context Persistence
Aspect crews do not use `getContext()` or `writeContext()`. Each conversation is independent — pure request-response BI queries.

### No Field Collection
No `fieldsToCollect` on any crew. Conversations start immediately with the user's question.

### No Knowledge Base
Domain knowledge is embedded in the guidance text (2,000-4,000+ lines per crew) rather than a vector store.

---

## Data Flow

```
User types question
  → ChatService sends to /api/aspect/stream with optional overrideCrewMember
  → Dispatcher resolves crew (override > conversation.currentCrewMember > default)
  → Crew builds context (guidance + conversation history)
  → LLM generates response
    → For Zer4U: may call fetch_zer4u_data → SQL generation → query execution → results
  → Response streamed via SSE
```

---

## Client Configuration

- **Crew Mode:** `"tabs"` — crew members shown as tabs
- **Crew Position:** `"right"` — tabs on the right side of chat
- **Features:** Logo upload enabled, chat history enabled, KB disabled, file upload disabled
- **Quick Questions:** 12 pre-built topics covering sales, inventory, customers, margins, and forecasting

---

## File Structure

```
agents/aspect/
├── AGENT.md                          # This file
└── crew/
    ├── index.js                      # Crew member exports
    ├── technology.crew.js            # Electronics retail BI (default)
    ├── fmcg.crew.js                  # Supermarket/grocery BI
    ├── fashion.crew.js               # Fashion/apparel BI
    └── zer4u.crew.js                # Flower shop BI (with fetch_zer4u_data tool)
```

**Related files:**
- `services/data-query.service.js` — executes NL questions as SQL queries (for Zer4U)
- `services/sql-generator.service.js` — translates natural language → PostgreSQL via Claude
