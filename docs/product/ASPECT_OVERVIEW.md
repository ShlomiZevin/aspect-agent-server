# Aspect — Platform Overview

> Scope note: this document describes what is **built and verifiable in code today** (2026-07-16). Where a capability is a documented plan rather than a shipped feature, it is explicitly labeled "planned." No claims are made about actual competing products — those comparisons would require external market research, which is out of scope here.

## 1. What Aspect is

Aspect is a multi-tenant platform for building **AI chat agents that talk to a business's real data**, plus a growing set of shared tooling around them (a self-serve BI dashboard builder, a task board, an admin query optimizer, a KB/RAG system, and internal agent-authoring tools).

Two repos make up the product:
- **`aspect-agent-server`** — Express 5 backend. Talks to OpenAI, Anthropic, and Google LLM APIs; runs a crew-based agent dispatcher; executes natural-language-to-SQL queries against per-client PostgreSQL (Cloud SQL) schemas; serves the BI tool's compiled-SQL API; hosts WhatsApp integration.
- **`aspect-agent-client-react`** — React 19 + TypeScript + Vite frontend. One codebase serving every agent's chat UI via per-agent config files, plus the BI dashboard UI, task board, and internal builder tools.

Both are deployed to Google Cloud Run (server) and Firebase Hosting (client).

## 2. Core idea

Each client (a retail chain, a wellness brand, a bank onboarding flow, etc.) gets an **agent**: a chat interface, backed by one or more "crew members" (LLM personas with specific jobs), that can answer natural-language questions by generating and running real SQL against that client's data — not canned reports. The same codebase serves every client; a client is identified end-to-end by a single `slug` (folder name, config key, DB schema name, `agents` table row).

On top of that shared foundation, two product surfaces exist today:

1. **Chat agents** — natural-language Q&A over a client's data (see §4), or, for non-BI agents, task-oriented conversation flows (e.g. Freeda's wellness intake, LYBI's bank-account-opening flow).
2. **Aspect BI** — a self-serve dashboard/analytics builder (`/bi/<dataset>`), architecturally independent from the chat-agent system, sharing only the database and one mount point in `server.js`. Users build ad-hoc queries (pick dimensions + measures, get an auto-selected chart) and pin them to dashboards with cross-filtering (clicking a bar/slice/row filters every other widget on the dashboard). Currently wired to one dataset (`hypertoy`); the query compiler and dashboard store are dataset-agnostic by design, so adding a client means adding a semantic-model file, not rewriting UI.

## 3. Architecture building blocks

| Block | Location | What it does |
|---|---|---|
| LLM routing | `services/llm.js`, `services/models.service.js` | Central model registry maps a model id to its provider — **OpenAI, Anthropic, or Google** — and dispatches accordingly. Not a simple string-prefix check: each model id is explicitly registered against a provider. |
| Crew/agent system | `agents/<slug>/crew/*.crew.js`, `crew/base/CrewMember.js`, `crew/services/dispatcher.service.js` | Each agent is one or more "crew members" (specialist personas); a dispatcher routes each incoming message to the right one, either by explicit override, conversation state, or default. |
| NL → SQL query engine | `services/data-query.service.js`, `services/sql-generator.service.js`, `services/schema-descriptor.service.js` | Question → LLM-generated SQL, scoped to the client's schema → execution (15s timeout) → structured result (`sql`, `data`, `rowCount`, `columns`, `summary`, `confidence`) → LLM narrates the answer in chat. |
| Aspect BI | `bi/routes/`, `bi/services/query-compiler.js`, `bi/services/dashboards.store.js`, `bi/datasets/<name>.dataset.js` | A dataset's semantic model (dimensions, measures, joins) is the only trusted SQL source; the client sends a structured **spec**, never raw SQL. Compiler enforces caps (3 dimensions, 8 measures, 200 filter values, 5000 rows) and a query timeout. Dashboards are saved as JSONB with pinned widgets. |
| Query Optimizer | `services/slow-query.service.js`, `services/optimization-job.service.js`, admin UI | Logs slow (>5s), errored, and timed-out (>15s) queries; an admin can request an LLM-generated index recommendation and run `CREATE INDEX CONCURRENTLY` as a background job. |
| Knowledge Base (KB) | `services/kb.service.js` | RAG content synced to multiple vector-store backends at once — a KB entry can carry file/document ids for OpenAI, Google, and Anthropic simultaneously, so the same source content serves whichever provider a given agent uses. |
| Data reload pipeline | `agents/<slug>/data-reload.js`, `scripts/reload-<slug>*.js`, `services/reload-guard.js` | Per-client loaders read from a GCS folder, load into Postgres; several clients (zer4u, hypertoy) use a zero-downtime two-phase reload (old + new schema coexist until swap). |
| WhatsApp integration | `server.js` webhook (`/api/whatsapp/webhook`), `whatsapp/bridge.service`, `whatsapp/provider` | Confirmed wired: inbound WhatsApp messages are handled and routed into the same chat pipeline as the web UI; outbound web replies are forwarded to linked WhatsApp users. Provider is abstracted behind an interface (Green API is the current implementation per README/env vars). |
| Task board | Internal tool, referenced in `tasks/pending/white-label-readiness.md` alongside `query-optimizer`, `crew-editor`, `playground`, `super-admin` | Internal project-management tool used to run this project's own work (not a client-facing feature). |

## 4. Agent inventory

16 agent folders exist under `agents/`; **8 have an `AGENT.md`** describing them (the rest are undocumented in this pass and should not be characterized without separate review):

| Agent | Business | Type |
|---|---|---|
| zer4u | Flower shop chain | BI chat agent (dedicated DB) |
| hypertoy | Toy retail chain | BI chat agent + Aspect BI dataset |
| thestock | Retail chain (sister brand to hypertoy) | BI chat agent — **no item-level sales data** (see dataset doc) |
| zolstock | Discount retail chain | BI chat agent — facts table modeled, dimension data not yet delivered |
| tevanaot | Footwear retailer | BI chat agent, QlikSense-export schema with synthetic composite keys |
| aspect | Internal multi-vertical demo (Technology / FMCG / Fashion / Zer4U tabs) | Demo agent — only the Zer4U tab has a real DB behind it |
| freeda | Menopause wellness companion | Consumer wellness chatbot — 5-stage sequential intake flow, not BI |
| banking-onboarder-v2 (LYBI) | Hebrew bank-account-opening assistant | Task-flow agent, hybrid Gemini (talker) + Claude (thinker), partially implemented (no identity verification / account creation yet) |

The five retail BI agents (zer4u, hypertoy, thestock, zolstock, tevanaot) share one pattern: single crew, stateless per-message conversation, one tool (`fetch_<slug>_data`) that always runs the same NL→SQL→answer pipeline described in §3.

*Undocumented, not characterized here:* `banking-onboarder` (v1), `byline`, `compass`, `foreman`, `newdeli`, `onezero`, `sample`, `tiktok`.

## 5. What's shipped vs. what's planned

**Shipped and verified in code:**
- Folder-isolated multi-tenant pattern across 14+ agents, each identified end-to-end by one `slug`.
- Three-provider LLM routing (OpenAI, Anthropic, Google), not just two.
- Multi-provider KB/RAG sync.
- Self-serve BI builder with cross-filtering dashboards, running on a whitelisted-spec query compiler (no free-text SQL from the client).
- WhatsApp channel alongside the web chat UI, same backend pipeline.
- Zero-downtime data reload for at least two clients.

**Documented as intent, not yet shipped** (source: `tasks/pending/white-label-readiness.md`, self-rated "5-6/10" readiness, and `tasks/pending/boxed-version-plan.md`):
- An `ENABLED_AGENTS` config flag to run the same codebase as a single-client "boxed" deployment without code changes — planned, not found implemented.
- Full white-label readiness: `services/sql-generator.service.js` still hardcodes per-client `if (schemaName === '<slug>')` branches rather than being fully data-driven; `server.js` (5500+ lines) and the client's `App.tsx` still hand-list agents/routes rather than auto-discovering them.

## 6. Where this leaves "strong sides"

Grounded, defensible strengths of the current build:
- **One platform, many verticals** — the same crew/dispatcher/NL-to-SQL engine already serves five different retail data models plus a wellness chatbot plus a banking flow, without forking the codebase per client.
- **Real data, not canned answers** — every BI-agent response is backed by a live, schema-scoped SQL query with an enforced timeout, not a pre-written FAQ.
- **Provider flexibility** — a client-facing feature (which model answers) is a config choice, not a code fork, across three LLM vendors.
- **Aspect BI's query safety model** — structured spec → compiler → parameterized SQL means the self-serve dashboard tool can be handed to a non-technical business user without SQL-injection or unbounded-query risk.

These are architectural/technical strengths, not market-validated "competitive advantages" — no external competitor research was performed for this document.
