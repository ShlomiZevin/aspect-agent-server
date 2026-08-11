# aspect-agent-server

Node 22 / Express 5 backend for the Aspect platform. Serves three largely independent product lines from one repo and one Cloud Run service:

1. **Agent chat platform** — multi-tenant conversational agents built from *crew members* (`agents/`, `crew/`, plus most of `services/`).
2. **Builder V2** — the visual agent authoring tool and its runtime (`builder/`, `alfred/`).
3. **Data products over customer schemas** — **Aspect BI** (ad-hoc, spec-driven, `bi/`) and **Aspect Intelligence / Insights** (proactive AI investigations, `insights/`).

`hq/` is a fourth, internal-only tier (see import rule below).

## Commands

```bash
npm start                  # node server.js (port 3000)
npm run db:studio          # drizzle-kit studio
./deploy.sh aspect         # → Cloud Run, project aspect-agents
./deploy.sh freeda         # → Cloud Run, project menopause-bot

# Verification (run these before/after touching the data pipeline)
node scripts/test-insights-unit.js          # fast, offline — 38 assertions, no DB or LLM
node scripts/test-schema-contract.js        # every relation/column named in the rules must exist; exit 1 on violation
node scripts/test-insights-suite.js <ds> all # real investigations + auto-verify every figure (slow, ~1-2 min/case)
node scripts/recheck-insights-suite.js      # re-verify captured results without re-running them
node scripts/summarize-insights-suite.js    # render the report
node scripts/test-chat-regression.js [ds]   # Data Chat path — it shares the NL→SQL engine, so verify it too
node scripts/test-chat-regression.js --hebrew        # Hebrew + mixed-language chat questions
node scripts/test-insights-suite.js <ds> hebrew      # Hebrew investigations
```

Suites write into `verification/<topic>/` automatically — don't move files by hand.

There is no test runner and no lint config. `scripts/` holds ~75 ad-hoc operational and battery scripts; the `test-*.js` ones are real pass/fail batteries, not unit tests.

**Never mutate dataset config while a suite is running.** The suites enable a disabled dataset and restore it in a `finally`; a concurrent `setConfig` killed two cases mid-run and produced a false result during the 2026-08 work.

Env: `.env` locally, `.env.production` in the container; `deploy.sh` picks `.env.production.<target>`. Local dev against Cloud SQL goes through `cloud-sql-proxy.exe` (repo root, port 5433).

## Layout

| Path | What it is |
|---|---|
| `server.js` | **6.4k-line monolith.** ~234 inline routes plus 9 `app.use()` mounts, then `startServer()` at the bottom (DB init, DataReloadService registration, provider-config preload). |
| `agents/<name>/` | Per-agent assets: `AGENT.md` (its documentation), `crew/*.crew.js`, optional `data-reload.js`. 16 agents. |
| `crew/` | Chat runtime. `base/CrewMember.js` + `DynamicCrewMember.js`, `services/dispatcher.service.js` (routing + transitions), `services/crew.service.js` (loading), `micro-agents/` (fields extractor, profiler, thinking advisor). |
| `services/` | 65 flat modules — LLM routing, DB pools, KB, conversations, billing, data-query/SQL generation, schema descriptor, scheduling. |
| `builder/` | Builder V2: `addons/*.addon.json` (shared descriptors), `runtime/`, `plugins/`, `routes/`, `types/index.ts` (**canonical, client mirrors it**). |
| `alfred/` | In-builder AI helper (Builder Chat tab). |
| `bi/` | Spec-driven BI. Clients send whitelisted field ids, never SQL; `services/query-compiler.js` emits the SQL. See `bi/README.md`. |
| `insights/` | Aspect Intelligence. See `docs/features/insights.md` — full pipeline, current measured state, and a "Known limitations & leftovers" section listing what is still broken and how to approach it. |
| `verification/` | Verification runs, one subfolder per thing checked. See the rule below. |
| `hq/` | Lybi HQ — internal company brain. See `hq/README.md`. |
| `db/schema/*.js` | Drizzle table definitions (`index.js`, `builder.js`). |
| `db/migrations/` | ~46 `.sql` + ~43 `run-*.js` runners. |
| `docs/` | See `docs/INDEX.md`. `docs/features/` documents shipped features; `docs/guides/` is how-to. |

## Conventions that matter

**LLM calls go through `services/llm.js`.** Never call `llm.openai/claude/google` directly — the router resolves the provider from the model id and logs token usage. One-shot helper:

```js
await llmService.sendOneShot(systemPrompt, userMessage, {
  model: 'claude-sonnet-4-6', maxTokens: 2048, jsonOutput: true,
  context: 'my_feature_step',   // required — this is the usage-log key
  agentName, conversationId, userId,   // optional, for attribution
});
```

Model ids live in `services/models.service.js` (the single source of truth, exposed via `GET /api/models`). Never hardcode a model string that isn't in that list.

**Two databases, and the naming is misleading.**
- `services/db.pg` → **platform DB** (`agents_platform_db`): agents, users, conversations, tasks, builder, `provider_config`, `intelligence_insights`. Drizzle lives here.
- `services/db.zer4u` → **customer data DB** (`aspect-data-db`). `db.hypertoy`, `db.newdeli`, `db.thestock`, `db.zolstock`, `db.tevanaot` all **re-export the same pool** — every dataset is a *schema* inside the one `zer4u_db` database. The pool logs itself as `[db.zer4u]` regardless of which dataset you are querying.
- Consequence: **always schema-qualify** (`hypertoy.facts`, not `facts`). `search_path` will not save you and an unqualified name can hit the wrong tenant.

**Verification results are organised, never left in the repo root.** Every verification run writes to `verification/<what-was-checked>/` — create the folder if it doesn't exist, name the subfolder for the thing under test (`insights-accuracy`, `chat-regression`), and put the raw JSON there alongside a short `README.md` saying what was checked, how to reproduce it, and a summary table of results. A results file sitting loose in the root is a bug.

```
verification/
├── insights-accuracy/     suite-results-<dataset>.json + README.md
├── chat-regression/       chat-regression-<dataset>.json + README.md
└── hebrew-language/       Hebrew + mixed-language runs + README.md
```

**Bilingual: user-facing text mirrors the PROMPT — nothing else.** These are Israeli retailers; users ask in Hebrew, in English, or mix both in one sentence, and the answer must come back in the language it was asked in. Insights enforces this with a LANGUAGE rule in the synthesize prompt. Two failures happened here, in both directions, so get the wording right:

- Without any rule, 4 of 6 Hebrew questions came back in English.
- With a rule that *mentioned* Hebrew being the clients' main language, English questions came back in **Hebrew** — the model read the context as an instruction.

The rule must say only "mirror the prompt", and must state that Hebrew **in the data** (record types like `'מכירות'`, store and product names) says nothing about the requested language — the data is Hebrew regardless of what was asked. Database values and ₪ are never translated; only the prose follows.

**Verify any prompt change in both languages.** Correctness and language are independent failure modes: the Hebrew runs had perfectly correct numbers and the wrong language, which an English-only pass cannot see.

**Customer-data queries go through `DataQueryService`** (`services/data-query.service.js`), not raw pool queries. It owns SQL generation (`sql-generator.service.js`), the DDL/DML keyword guard, the `statement_timeout`, the row cap, and a 3-attempt self-correcting retry that feeds the real Postgres error back to the model.

- SQL generation runs at **`temperature: 0`** — it is a single-correct-answer task, and the provider default of 1.0 meant the same question produced materially different SQL (and different numbers) each run.
- Chat uses the **15s default** timeout; Insights passes **75s** (`INSIGHTS_QUERY_TIMEOUT_MS`) because it is async background work, not a user waiting on a reply.
- Callers that know their dataset's real end date pass **`dataThroughDate`** so relative windows ("last 4 weeks") anchor to the data rather than `CURRENT_DATE`. These datasets are periodic exports and can be months behind.
- Per-schema semantics (record-type filters, materialized-view mandates, column quirks) live in `_getSchemaSpecificRules()`. **These rot silently** — zer4u's named 9 materialized views that no longer existed, breaking every store/revenue question for months. `scripts/test-schema-contract.js` now fails on that, and a runtime corrector overrides stale references. New per-dataset rules should go in their own module under `services/schema-rules/` (see `zer4u.rules.js`).
- **Lookup joins fan out.** `hypertoy.products` holds 62,163 rows for 55,189 distinct `part`, which inflated every product-dimension total by 44.6% (₪190.7M against a true ₪131.8M). Deduplicate with `DISTINCT ON` before aggregating; in the BI semantic layer declare `dedupeOn` on the join.

**Suggested reports are shared, not per-user.** `bootstrap()` writes under the fixed `system` user; `listGenerated` merges those into every session's own list as read-only suggestions. Saving one **clones it to the user** (`seededFrom` links the copy, so the original stops showing) — ownership starts at Save, which is also why a saved report is a frozen snapshot while suggestions keep refreshing. Deleting a suggestion is not offered: it belongs to everyone. Copying per-user on first visit was tried and rejected — each copy freezes at that user's first visit, so two people would see different "current" numbers for the same dataset.

**Scheduled work that depends on a data load is self-checking, not clock-scheduled.** `scheduler-tick.service.js` runs every minute from one Cloud Scheduler job. Jobs with a fixed hour (`import`, `drive_sync`) read their window from `schedule-config.service`; jobs that must follow the load — `ensureIndexed`, and `insights-refresh.service.js` — instead run every tick and no-op unless their precondition holds ("loaded today, not yet done today"). A nightly report built before the load lands describes yesterday's data.

**New features get their own folder with a router**, mounted with one line in `server.js` — the pattern `bi/`, `insights/`, `hq/`, `builder/` all follow. Do not add to the inline-route pile.

**Config that admins edit** goes in the generic `provider_config` key/value table as one JSON blob, layered over code defaults — see `insights/services/intelligence-config.service.js` and `services/schedule-config.service.js`. No new table needed.

**Migrations** are hand-written: add `NNN_description.sql` and a paired `run-NNN-description.js` runner, then run the runner. The `drizzle-kit` npm scripts exist but the repo has no drizzle journal; do not assume `db:migrate` reflects reality.

**Import rule — one direction only.** `hq/` may import from `services/` and `builder/`. **Nothing in the product may import from `hq/`.**

**`builder/types/index.ts` is server-owned.** The client mirrors it at build time via its `sync-builder-types.cjs`; the client copy is gitignored. Edit it here.

## Gotchas

- `require('dns').setDefaultResultOrder('ipv4first')` at the top of `server.js` is load-bearing — googleapis hosts are unreachable over IPv6 from Cloud Run.
- Anything written to a path inside the build context is baked into the Docker image by `COPY . .` and reset on every deploy. Persist state in Postgres or GCS, never a repo-relative file. (This cost live production insights once; see `docs/features/insights.md`.)
- Production CORS is a hardcoded allowlist in `server.js` — a new frontend origin must be added there.
- Startup is fault-tolerant: if the DB fails to initialise the server still listens. A "working" health check does not mean the DB is up.
- Agent folder names are fuzzy-matched from DB agent names (`crewService.resolveCrewPath`) — "Freeda 2.0" resolves to `agents/freeda/`.
