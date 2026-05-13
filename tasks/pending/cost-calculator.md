# Task: Per-Customer Cost Estimator

**Domain:** `aspect` (admin UI, data-included environments only)
**Type:** Feature
**Priority:** Medium
**Language:** Hebrew (RTL)

---

## Background

Itzik (Aspect owner) needs a quick way to estimate the monthly cost of running the agent for a specific customer, so he can decide on pricing and usage limits. Today there's no way to know "what does X cost us per month?" without manually adding up token usage.

The tool is a **rough ballpark calculator** — not exact accounting. It should answer questions like *"if a customer asks 200 queries/day with 10 users, what's our monthly cost?"* in under 30 seconds.

It must only be exposed in the **admin section of data-included agents** (Zer4U, NewDeli, TheStock, HyperToy, Aspect/OneZero, and similar). It must NOT appear for non-data agents (Freeda, Lybi, etc.) — Kosta knows which agents have customer data schemas.

---

## What Changes

### 1. New admin page

Add a new page under the agent admin: `/<agent>/admin/cost-calculator` (e.g. `/zer4u/admin/cost-calculator`).

The page reads the **current agent's customer schema** (already in the per-customer dedicated DB) and uses it for schema-size assumptions. No customer selection needed — one agent = one customer.

### 2. Inputs (Hebrew labels, all with defaults)

| Input | Default | Notes |
|---|---|---|
| מספר משתמשים פעילים | 5 | Active users using the agent |
| שאלות בלי SQL ליום למשתמש | 5 | Pure LLM questions (no DB query) |
| שאלות עם SQL ליום למשתמש | 15 | Questions that need SQL translation |
| ממוצע הודעות בשיחה | 4 | Conversation history depth (affects history tokens) |
| אורך תשובה ממוצע (טוקנים) | 400 | Output tokens per answer |
| מודל Claude (תרגום ל-SQL) | Claude Sonnet 4 | Locked dropdown — only Sonnet for now |
| מודל OpenAI (יצירת תשובה) | GPT-5 latest | Locked dropdown — only GPT-5 for now |
| כולל תמלול אודיו (Whisper)? | ☐ unchecked | Checkbox — if checked, adds Whisper cost |
| דקות אודיו ליום למשתמש | 0 | Only relevant if audio is checked |

### 3. Schema-based auto-calculation

The page should automatically fetch from the customer's DB:

- **Number of tables** in the schema
- **Total columns count** across all tables
- **Total DB size** (bytes — used for DB tier estimation)

Use `information_schema.tables` and `information_schema.columns` queries.

Calculate **schema description tokens** as a rough function:
```
schema_tokens ≈ (tables × 30) + (columns × 15)
```
This becomes part of every Claude SQL-translation call.

### 4. Cost formulas (rough ballpark — early 2026 prices)

**Model pricing (defaults, editable in a "Pricing" section at bottom of page):**

| Service | Input ($/1M tokens) | Output ($/1M tokens) |
|---|---|---|
| Claude Sonnet 4 | $3.00 | $15.00 |
| GPT-5 | $5.00 | $15.00 |
| Whisper | $0.006/min | — |

**Per question (no SQL):**
```
openai_input  = system_prompt(1500) + history(avg_msgs × 200) + question(50)
openai_output = avg_answer_length

cost = (openai_input × $5/1M) + (openai_output × $15/1M)
```

**Per query (with SQL):**
```
claude_input  = system_prompt(2000) + schema_tokens + history(avg_msgs × 200) + question(50)
claude_output = 150  // SQL is short

openai_input  = system_prompt(1500) + history(avg_msgs × 200) + question(50) + sql_results(500)
openai_output = avg_answer_length

cost = claude_cost + openai_cost
```

**Daily total:**
```
daily_cost = users × (questions × cost_per_question + queries × cost_per_query)
```

**Monthly total:**
```
monthly_llm_cost = daily_cost × 30
```

**Audio (if checked):**
```
audio_cost = users × audio_minutes_per_day × 30 × $0.006
```

### 5. DB tier (SQL cost when upgrading)

Show DB cost as a separate line. Use a simple step function based on **total DB size + concurrent users**:

| Tier | When to upgrade | Cloud SQL cost/month |
|---|---|---|
| db-f1-micro (small) | Up to ~20 customers / <10GB | $25 |
| db-g1-small (medium) | 20-50 customers / 10-50GB | $75 |
| db-custom-2-7680 (large) | 50+ customers / 50GB+ or >20 concurrent users | $250 |
| db-custom-4-15360 (xl) | Heavy load / 100GB+ | $500 |

Calculate this customer's DB tier based on its schema size. Display:
- Current tier (e.g. "Medium — $75/mo")
- **Note**: DB is shared across all customers — show this customer's *amortized share* (e.g. $75 ÷ number of customers on shared instance).

Add a small **"Cloud cost note"** under the result: *"Cloud Run, Cloud Storage, and network costs are negligible per query and not included."*

### 6. Result display

Three big numbers at the top:

```
₪ XX.XX  →  עלות חודשית כוללת
₪ X.XX   →  עלות חודשית למשתמש
₪ 0.0X   →  עלות ממוצעת לשאלה
```

Below: a breakdown table showing each line item (Claude SQL, OpenAI answer, Whisper, DB share, total).

Currency: NIS (₪). Use a fixed FX rate (3.7 ₪/$) — editable in the Pricing section.

### 7. Visibility (CRITICAL)

This page must **only render** for agents that have a customer data schema. Kosta will identify the data-included agents (currently: Zer4U, NewDeli, TheStock, HyperToy, Aspect/OneZero). For non-data agents (Freeda, Lybi, Banking, Byline, Compass, Foreman, TikTok), the admin nav should NOT show the cost calculator link.

Simplest implementation: maintain a constant array `DATA_INCLUDED_AGENTS = ['zer4u', 'newdeli', 'thestock', 'hypertoy', 'onezero']` and only show the menu item if `currentAgent` is in this list.

---

## Out of Scope

- Multi-customer comparison view — one customer (= one agent) at a time
- Historical cost tracking / actual usage data — this is forecast only, not accounting
- Alerts or limits — purely a ballpark estimator
- English UI — Hebrew only
- Exact accounting / invoicing — this is a planning tool, not a billing system

---

## Files Touched

| File | Change |
|---|---|
| `aspect-react-client/src/pages/CostCalculatorPage.tsx` | New page — RTL Hebrew calculator |
| `aspect-react-client/src/pages/CostCalculatorPage.module.css` | Page styles, match admin theme |
| `aspect-react-client/src/pages/index.ts` | Export new page |
| `aspect-react-client/src/App.tsx` | Add route `/:agent/admin/cost-calculator` |
| `aspect-react-client/src/pages/DashboardPage.tsx` (or admin nav) | Add menu link — visible only for data-included agents |
| `aspect-agent-server/server.js` | New endpoint: `GET /api/admin/:agent/schema-stats` → returns `{ tables, columns, dbSizeBytes }` |
| `aspect-agent-server/services/schema-descriptor.service.js` (or new file) | Query `information_schema` for table count, column count, DB size |

---

## Acceptance Criteria

- [ ] Page accessible at `/<data-agent>/admin/cost-calculator` (e.g. `/zer4u/admin/cost-calculator`)
- [ ] Page is **NOT** accessible / linked from non-data agents (Freeda, Lybi, etc.)
- [ ] All inputs have sensible defaults — page shows a meaningful cost without any user input
- [ ] Schema stats auto-populate from the current customer's DB
- [ ] Three big numbers (total/month, per user/month, per question) update live as inputs change
- [ ] Breakdown table shows: Claude cost, OpenAI cost, Whisper cost (if checked), DB amortized cost
- [ ] Audio checkbox shows/hides the audio minutes input
- [ ] DB tier reflects the customer's schema size
- [ ] All text in Hebrew (RTL)
- [ ] Pricing assumptions are editable in a section at the bottom of the page

---

## Verification Steps

1. **Default load** — open `/zer4u/admin/cost-calculator`. → Page loads, shows default monthly cost (~₪200-500 range), schema stats populated from Zer4U DB.
2. **Adjust users** — change "active users" from 5 to 50. → Total cost scales roughly 10x, per-user cost stays the same.
3. **Toggle audio** — check the audio checkbox, set 5 min/day. → Whisper line appears in breakdown, total cost increases by ~₪25-50/month.
4. **Non-data agent guard** — try opening `/freeda/admin/cost-calculator` or check Freeda's admin nav. → Page should return 404 or redirect, and no menu link visible.
