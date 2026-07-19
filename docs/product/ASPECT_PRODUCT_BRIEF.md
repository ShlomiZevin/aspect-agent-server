# Aspect — Product Brief

> Written as a standalone handoff document — no access to the repository is assumed. Facts are accurate as of 2026-07-16. Where something is a stated plan rather than a shipped feature, it is explicitly labeled "planned." No external market/competitor research was performed — "strengths" below are grounded in what the code actually does, not in comparisons to named competing products.

---

## 1. What is Aspect?

Aspect is a platform for building **AI chat agents that answer questions using a business's real data**, plus a self-serve BI dashboard tool built on the same foundation.

Concretely, a client (a retail chain, a wellness brand, a bank onboarding flow, etc.) gets:
- A **chat agent** — a conversational interface where a user asks questions in plain language and gets answers backed by that client's actual database, not scripted FAQ responses.
- Optionally, an **Aspect BI dashboard** — a point-and-click analytics tool where a non-technical user builds charts and dashboards over the same underlying data, without writing SQL.

The system is built as **one shared codebase serving many clients**, not a separate app per client. A new client is added by writing configuration and a data schema/mapping, not by forking the product.

### The two parts of the system

1. **Server** (Node.js / Express) — hosts the chat logic, talks to the LLM providers (OpenAI, Anthropic/Claude, Google/Gemini), turns natural-language questions into SQL, runs that SQL against the client's database, and serves the BI tool's API.
2. **Client** (React web app) — one web application that renders every client's chat UI (using per-client configuration/branding) and the BI dashboard UI.

Both are cloud-hosted (server on Google Cloud Run, web app on Firebase Hosting) and connect to managed PostgreSQL databases (Google Cloud SQL).

---

## 2. How it actually works, end to end

**Chat agent flow (natural language → real answer):**

1. A user types a question in the chat UI (e.g. "What was our revenue last month by store?").
2. The message is routed to the right "crew member" — a specialized AI persona configured for that client/topic — by an internal dispatcher.
3. If the question needs data, the crew member calls a data-lookup tool, which:
   a. Sends the question, plus a description of the client's database schema, to an LLM to generate a SQL query.
   b. Runs that SQL against the client's PostgreSQL schema (with a hard timeout, so a bad or slow query can't hang the system).
   c. Returns structured results (the SQL used, the row count, the actual data, and an automatic summary).
4. The crew member's LLM turns that structured result into a natural-language answer for the user.

**Aspect BI flow (self-serve dashboards):**

1. A "dataset" is defined once per client — a semantic model describing which database tables/columns count as a "dimension" (something you group by, like store or month) and which count as a "measure" (something you sum/average, like revenue or units sold).
2. A user picks dimensions and measures visually (no SQL) in a query builder; the tool auto-picks a sensible chart type (bar, line, pie, table, KPI tile).
3. The user's selections are sent to the server not as SQL, but as a small structured "spec" (which fields, which filters). The server — never the browser — translates that spec into actual parameterized SQL, using only the fields the semantic model allows. This means a business user can be given full self-serve access without any SQL-injection or "accidentally query the whole database" risk.
4. Query results can be pinned to a dashboard as a "widget." Dashboards support **cross-filtering**: clicking a bar, pie slice, or table row in one widget filters every other widget on the same dashboard by that value — this is a genuinely useful interactive analysis feature, not just static charts.

---

## 3. Core idea

**One engine, many verticals.** The same crew-dispatch / natural-language-to-SQL engine already serves five different retail businesses (flowers, toys, general retail, discount retail, footwear), a menopause-wellness consumer chatbot, and a bank-account-opening assistant — without forking the codebase. A client is identified by a single short id ("slug") that's used consistently for its folder, its configuration, and its database schema name.

**Real data, not scripted answers.** Every data-backed response is the result of a live, schema-scoped SQL query generated and executed at request time, with an enforced timeout — not a lookup table of pre-written answers.

**Provider flexibility.** Which underlying AI model answers a given agent's questions (OpenAI, Anthropic/Claude, or Google/Gemini) is a configuration choice per agent, not a code fork. Some agents even mix providers deliberately — e.g. a fast/cheap model for conversational flow and a stronger model for complex reasoning steps within the same conversation.

**Self-serve BI without SQL risk.** The Aspect BI tool lets a non-technical user explore data and build dashboards through a UI, while the server guarantees every query stays inside a whitelisted, parameterized set of fields — no free-text SQL ever reaches the database from the browser.

---

## 4. Strong sides (grounded in what's built)

- **Multi-tenant by design, not by accident** — 14+ independent client agents run on the same codebase today, each cleanly isolated by a single id used everywhere (folder name, config key, database schema, registry row).
- **Three-provider LLM support** — genuinely wired to OpenAI, Anthropic, and Google, with a central registry deciding which model uses which provider, so a client isn't locked to one AI vendor.
- **Knowledge-base content is provider-portable** — reference/FAQ content used for retrieval-augmented answers can be synced to multiple vector-store backends (OpenAI's, Google's, Anthropic's) from one source, so switching or mixing providers doesn't mean re-uploading content per vendor.
- **Two channels, one backend** — the same chat pipeline serves both a web chat UI and WhatsApp (the WhatsApp webhook and message bridge are live and route into the identical crew-dispatch logic as the website).
- **Safety-first self-serve analytics** — Aspect BI's query compiler enforces limits (max dimensions/measures per query, max filter values, row caps, query timeout) and only ever executes parameterized SQL built from a whitelisted semantic model — the browser never sends SQL.
- **Zero-downtime data refresh for at least two clients** — data reloads for the flower-shop and toy-retail clients use a two-phase approach (old and new data coexist until the swap), so the chat agent and BI tool keep answering correctly while new data loads in the background.

### Honest caveats (also part of an accurate picture)

- The platform is **not yet fully "white-label" out of the box**. An internal readiness audit rates it "5–6 out of 10": some client-specific logic is still hardcoded in a few shared files (for example, SQL-generation rules for a couple of clients are literal `if (this client) { ... }` branches rather than fully data-driven), and the main server file and the web app's routing still hand-list agents rather than auto-discovering them from folders. This is being actively worked on, not a hidden defect — it's on the team's own roadmap.
- A configuration flag to run the whole platform as a single-client "boxed" deployment (useful for reselling to one client without exposing the multi-tenant internals) is **planned but not yet implemented**.
- Aspect BI currently has exactly **one** dataset wired up (the toy-retail client). The tool itself supports any number of datasets by design; the other four retail clients simply don't have a semantic-model file written for them yet.
- Two internal-facing agents (a multi-vertical sales demo, and a bank-onboarding assistant) are explicitly partial/in-progress, not production-complete.

---

## 5. What data do the toy-retail client ("Hyper Toy") and the flower-shop client ("Zer4U") have, and how can it be used?

These are two of the platform's five live retail-BI clients. Both get natural-language chat answers today; only Hyper Toy currently has a self-serve BI dashboard built on top as well.

### Zer4U — flower shop chain

Zer4U runs on its **own dedicated database** (separate from the shared database the other retail clients use — a deliberate isolation choice, not a technical limitation).

**What's in it:**

| Data | Approx. size | What it captures |
|---|---|---|
| Sales | 9.4 million rows | Every sales transaction line |
| Inventory | 19.8 million rows | Stock levels |
| Items | 28,000 | Product catalog |
| Customers | 1.4 million | Customer records |
| Stores | 94 | Store locations |
| Targets | — | Sales targets by store/category/period |

Plus a set of pre-aggregated views (by year, month, store, customer, product, category) built specifically so common questions answer fast even though the underlying sales table is large.

**What it can be used for:** revenue and transaction-count analysis by time period, store, product, or category; inventory-level and stockout questions by warehouse; sales-target attainment by store/category/period; customer purchase-history questions.

**Important data-quality realities** (these are already handled by the existing chat agent, and would need to be handled by anyone building new tooling — like a future BI dashboard — on this data too):

- The "correct" revenue figure lives in a specially-named column that includes vouchers; a more obvious, plainly-named revenue column exists but **under-reports** (excludes vouchers) — using the wrong one silently understates revenue.
- All monetary figures are **before VAT** by convention; there's no VAT-inclusive figure anywhere in the data.
- A naive row count on the sales table **over-counts transactions by roughly 2.7x**, because each transaction has multiple line-item rows. Getting an accurate transaction count requires counting distinct receipt identifiers with specific handling of one exception category.
- Matching products to categories by **name-matching text** (e.g. "contains the word chocolate") produces materially wrong results — both false positives (a chocolate-flavored liqueur categorized as candy) and false negatives (a branded chocolate product whose name doesn't contain the word "chocolate")  — observed to be off by roughly 60x for at least one category in one month. The reliable source of truth is a proper category code field, not the product name text.
- Sales targets are stored as text with formatting quirks (a percentage sign that must be stripped, and a composite key that bundles category/store/date together as a single delimited string) rather than clean numeric/date columns.
- Payment method is **not tracked at all** in this dataset, and discount totals exist only inside free-text fields that can't be reliably summed.

None of this is a flaw specific to Aspect — it's simply what the client's underlying source data looks like, and it illustrates why a "natural-language to SQL" system needs real business-rule guardrails rather than just schema knowledge.

### Hyper Toy — toy retail chain

Hyper Toy shares a database instance with several other retail clients but has its own schema. It's part of a small retail group (alongside two sister toy/general-retail brands); its product catalog even carries cost data for those sister brands, but Hyper Toy is the one brand in the group with genuine **item-level sales data** — meaning it supports questions (top products, category performance, basket-level analysis) that aren't possible yet for at least one of its sister brands due to data gaps there.

**What's in it:**

| Data | Approx. size | Notes |
|---|---|---|
| Facts (sales + inventory + targets combined) | ~2 million rows | One table holding three record types, distinguished by a type flag |
| Payments | ~670,000 | |
| Pay accounts | ~726,000 | |
| Credits | ~38,000 | |
| Customers | ~128,000 | Contains personal data |
| Products | ~60,000 | Also carries cost data for two sister brands |
| Warehouses | ~50 | |
| Stores | ~96 | |
| Calendar | 346 | Date dimension |

**This is also the dataset the self-serve BI dashboard tool is built on**, so its structure is explicitly organized into "dimensions" (things you slice by) and "measures" (things you total):

- **19 dimensions**, grouped into: Time (day/week/month/quarter/year/day-of-week), Store (store/region/branch/store type/regional manager), Product (product/SKU/product family/supplier/status), Sales context (cashier/register/campaign/document type), and Customer (city).
- **12 measures**: revenue (before and including VAT), profit, margin %, quantity sold, line count, average line value, loyalty signups, sales target, target-attainment %, inventory units, and inventory value.

**What it can be used for:** everything above can be freely combined — e.g. "profit margin by store by month," "target attainment by category last quarter," "top-selling products by region," "cashier-level performance," "inventory value by warehouse." Because the semantic model already spans sales, inventory, and targets in one place, cross-cutting questions (actual vs. target, sales vs. stock-on-hand) are answerable without custom engineering per question — this is already live and explorable today at the BI dashboard URL, not just through chat.

One deliberate data-handling choice worth knowing: the "line count" measure intentionally does **not** de-duplicate to unique transactions (unlike a true transaction count) — de-duplicating over ~2 million rows was found to be too slow for interactive dashboard use, so it's documented as a line-item count, not a receipt count.

### Zer4U vs. Hyper Toy at a glance

| | Zer4U | Hyper Toy |
|---|---|---|
| Database | Dedicated, isolated | Shared instance, own schema |
| Self-serve BI dashboard | Not built yet | Built and live |
| Item-level sales data | Yes | Yes |
| Biggest data-quality risk | Multiple (revenue column, transaction counting, category matching) — all have documented fixes | One documented, intentional shortcut (line count vs. true transaction count) for performance |
| Largest table | Inventory, ~19.8M rows | Facts, ~2M rows |

---

## 6. Summary

Aspect is a shared platform, not a one-off app: the same natural-language-to-data engine, spanning three AI providers, already answers real questions for five different retail businesses (plus a wellness chatbot and a banking assistant) over live databases, with an additional self-serve BI dashboard layer now live for one of those clients and architected to extend to the rest without UI rework. The main remaining work to reach a fully "white-label, config-only" product is removing the last pockets of per-client hardcoded logic and building out semantic-model/dataset files for the BI tool for the clients that don't have one yet — both are scoped, understood, and already tracked internally, not open questions.
