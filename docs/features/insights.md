# Insights — Aspect Intelligence (proactive reports)

## Overview

**Insights** (product name: *Aspect Intelligence*) is the proactive half of the product. Where `/api/bi` answers a question the user typed, Insights *investigates* the customer's data on its own and writes up a finding as a **report**: a headline with real numbers, a detail page of self-chosen content blocks, a reasoning trail, a confidence score, and the actual SQL that produced it.

Two things define the feature:

1. **Nothing is canned.** There is no seed content, no illustrative sample, no fallback insight. Every number on screen came out of a real SQL query executed against the customer's real database seconds earlier. A failed investigation is returned as an error, not as a plausible-looking fake.
2. **The write-up is checked before it ships.** Between "the model wrote a finding" and "the user sees it" sit four independent guards (two deterministic code checks, one independent LLM fact-checker, one hard downgrade rule). See [Correctness](#how-correctness-is-enforced).

An insight is produced by a **four-step pipeline** — `PLAN → QUERY → SYNTHESIZE → VERIFY` — implemented in `insights/services/investigation.service.js`. The QUERY step is not insight-specific: it reuses the exact same NL→SQL engine (`services/data-query.service.js`) that the live chat agents use, so generated SQL goes through the same schema knowledge, the same anti-pattern learning, and the same safety validation as every other query on that dataset.

---

## Where the code lives

| Path | Responsibility |
|---|---|
| `insights/services/investigation.service.js` | The pipeline. Plan, query, synthesize, verify, normalize, persist. Also propose / bootstrap / track / action plan. |
| `insights/services/result-digest.service.js` | **Authoritative aggregates.** Re-aggregates the FULL result set in code to the grain PLAN asked for; grand totals, true per-entity ranking, roll-ups, per-row extremes, materiality. The model never sums rows itself. |
| `insights/services/measure-baseline.service.js` | **Possibility check.** Each dataset's fact-table totals; a result exceeding them has fanned out and is rejected outright. |
| `insights/services/investigation-progress.service.js` | Real per-stage progress (plan/query/aggregate/synthesize/verify) polled by the browser. |
| `services/schema-rules/zer4u.rules.js` | Per-dataset SQL rules extracted to their own module (pattern for the rest). |
| `insights/services/insights-store.service.js` | Postgres persistence (`intelligence_insights`, one JSONB row per insight). |
| `insights/services/intelligence-config.service.js` | Per-dataset admin config (enabled flag, brand label, data-model description, prompts) + per-section version history. |
| `insights/datasets/registry.js` | Static registry of the 6 datasets: schema name, pg pool, branding, and the *default* config values. |
| `insights/routes/insights.routes.js` | Public API, mounted at `/api/insights`. Per-session (per `userId`). |
| `insights/routes/insights-admin.routes.js` | Admin API, mounted at `/api/admin/intelligence`. Cross-user. |
| `services/data-query.service.js` | Question → SQL → rows, with execution retry + safety validation. |
| `services/sql-generator.service.js` | Builds the SQL-generation prompt: schema description + schema-specific rules + anti-patterns. |
| `services/schema-descriptor.service.js` | Introspects a live Postgres schema (tables **and** materialized views) into a description, DB-cached. |
| `db/migrations/037_add_intelligence_insights.sql` | The storage table. |
| `scripts/test-insights-battery.js` | Slow, real, end-to-end pass/fail battery against a live server + DB. |
| `scripts/test-insights-unit.js` | Fast offline regression tests for the pure (non-LLM, non-DB) logic. |

Client side (`aspect-agent-client-react`): `src/components/intelligence/*`, `src/services/insightsService.ts`, `src/types/insights.ts`.

---

## The exact flow

### A. Entry points — four ways an investigation starts

```
 ┌──────────────────────────── CLIENT ─────────────────────────────────────┐
 │                                                                         │
 │  ①  User types a prompt          ②  User clicks an example chip         │
 │     "why did margin drop?"          (config.examplePrompts — pre-vetted)│
 │              │                                    │                     │
 │              ▼                                    │                     │
 │   POST /:ds/classify-prompt                       │                     │
 │   ┌───────────────────────┐                       │                     │
 │   │ 1 cheap LLM call      │                       │                     │
 │   │ no SQL, no DB         │                       │                     │
 │   │ SIMPLE or INVESTIGATE?│                       │                     │
 │   └──────────┬────────────┘                       │                     │
 │       simple │  investigation                     │                     │
 │              ▼         │                          │                     │
 │   ┌────────────────────┴──┐                       │                     │
 │   │ "Gentle helper" modal │                       │  (chips skip the    │
 │   │  → Ask in Data Chat   │                       │   classifier: they  │
 │   │  → Run anyway ────────┼───────────┐           │   are already known │
 │   │  ☐ don't show again   │           │           │   to be worth it)   │
 │   └───────────────────────┘           │           │                     │
 │                                       ▼           ▼                     │
 │  ③  "Request a new insight" (no text typed) ──────┤                     │
 │  ④  Admin/system: POST /:ds/bootstrap ────────────┤                     │
 └───────────────────────────────────────────────────┼─────────────────────┘
                                                     │
                       POST /api/insights/:datasetId/investigate
                                { userId, prompt? }
                                                     │
                                                     ▼
                          investigate(datasetId, userId, prompt)
```

Notes:

- **① typed** — `InvestigateHero.tsx` calls `classify-prompt` first. `isSimpleQuery: true` shows a "this looks like something Data Chat can answer instantly" dialog instead of burning a multi-minute investigation. The user can override ("Run anyway") and can suppress the dialog permanently (`localStorage` flag). If classification itself throws, the investigation runs — ambiguity never blocks.
- **② chip** — `config.examplePrompts`, editable per dataset in the admin panel. Skips the classifier.
- **③ no prompt** — the empty-prompt path. The server picks the angle itself (see [Proposed insights](#how-proposed-insights-are-created)). `origin` is recorded as `'proposed'` rather than `'user'`, which is what the History page uses to distinguish "my report" from "Aspect suggested this".
- **④ bootstrap** — runs `config.bootstrapPrompts` **sequentially** (each is already 4+ round trips; parallel would just multiply load) under the fixed `userId` `'system'`. Failures are logged and skipped, never thrown — it's a best-effort populate.

The client models a running investigation as a **job** (`JobsContext.tsx`) persisted in `sessionStorage`, with a progress ticker capped at 96% and a resume-by-diffing path if the page is reloaded mid-run. The POST itself completes server-side regardless of whether the browser is still listening.

### B. The server pipeline

```
investigate(datasetId, userId, prompt)
  │
  ├─ registry.get(datasetId)              → schema name + pg pool   (404 if unknown)
  ├─ intelligenceConfigService.getConfig  → enabled? brandLabel? dataModelDescription?
  │                                          (404 if not enabled)
  ├─ origin = prompt ? 'user' : 'proposed'
  └─ actualPrompt = prompt || await proposeInvestigationPrompt(...)   ← +1 LLM call
  │
  ▼
╔═════════════ STEP 1 · PLAN ══════════════════════════════════════════════╗
║ planQuestion(datasetId, config, actualPrompt)                            ║
║   in : free-text prompt + config.dataModelDescription + dataThroughDate  ║
║   LLM: claude-sonnet-4-6, maxTokens 512, jsonOutput      × up to 2 tries ║
║   out: { category, dataQuestion }                                        ║
║        category ∈ cross-sell | margin | inventory | trend | risk         ║
║        dataQuestion = ONE concrete, SQL-answerable question              ║
║        (measure + breakdown dimension + time window)                     ║
╚══════════════════════════════════╤══════════════════════════════════════╝
                                   │  "Which 10 stores have the largest
                                   │   negative gap between sales_target
                                   │   and actual revenue in Q3 2026?"
                                   ▼
╔═════════════ STEP 2 · QUERY ═════════════════════════════════════════════╗
║ DataQueryService.queryByQuestion(dataQuestion, schemaName)               ║
║   (the SAME engine the chat agents use — nothing is bypassed)            ║
║                                                                          ║
║   ┌── attempt 1..3 ──────────────────────────────────────────────────┐   ║
║   │  sqlGenerator.generateSQL()                                      │   ║
║   │    ├─ schema description  (DB-cached introspection, see §C)      │   ║
║   │    ├─ schema-specific hard rules (per schemaName)                │   ║
║   │    ├─ anti-patterns: last 20 slow/error/timeout queries (5-min   │   ║
║   │    │    cache) — "do NOT reproduce these"                        │   ║
║   │    └─ previousError + previousSql, if this is a retry            │   ║
║   │  _validateSQL()   → reject DROP/DELETE/UPDATE/INSERT/TRUNCATE/   │   ║
║   │                      ALTER/CREATE  (whole-word match)            │   ║
║   │  _enforceLimit()  → append LIMIT 1000000 if the SQL has none     │   ║
║   │  execute with SET statement_timeout = 15000                      │   ║
║   │                                                                  │   ║
║   │  generation failed (bad JSON)? → retry, feed the parse error back│   ║
║   │  execution failed (PG error)?  → retry, feed the PG error back   │   ║
║   │  timeout?                      → 1 retry ("rewrite it cheaper")  │   ║
║   └──────────────────────────────────────────────────────────────────┘   ║
║   out: { sql, explanation, confidence, data[], rowCount, columns }       ║
║   error → the whole investigation throws (no fabricated fallback)        ║
╚══════════════════════════════════╤══════════════════════════════════════╝
                                   │ real rows
                                   ▼
╔═════════════ GUARD 1 · detectSuspiciousResult(data) ═════════════════════╗
║ Deterministic code. No LLM. Runs before either model sees the rows.      ║
║  · all-zero      — a numeric column exactly 0 on EVERY row               ║
║  · all-same-value— a numeric column pinned to the same NON-zero value    ║
║                    on every row (benchmark/percentile/threshold/avg-     ║
║                    named columns excluded: those are supposed to be flat)║
║ → flagged means "this smells like a broken JOIN, not a finding"          ║
╚══════════════════════════════════╤══════════════════════════════════════╝
                                   │ { flagged, reason, columns }
                                   ▼
╔═════════════ STEP 3 · SYNTHESIZE ════════════════════════════════════════╗
║ synthesizeInsight({ rows(≤30), sql, explanation, rowCount, anomaly,      ║
║                     dataThrough, verifierFeedback? })                    ║
║   LLM: claude-sonnet-4-6, maxTokens 6144, jsonOutput     × up to 2 tries ║
║   Writes the whole insight from the REAL ROWS only:                      ║
║     tag · categoryLabel · confidence · headline · title · impactValue    ║
║     · chart (card preview) · reasoning[] · confidenceChecks[]            ║
║     · blocks[]  ← 1–3 chosen from a palette, per THIS finding:           ║
║         chart | ranked_list (≤10) | stat_callout | comparison | scenarios║
║   Built-in instructions: SANITY CHECK (uniform data ⇒ DATA QUALITY, cap  ║
║   confidence at 40) and ARITHMETIC SELF-CHECK (a stated total must equal ║
║   the sum of the items actually listed).                                 ║
╚══════════════════════════════════╤══════════════════════════════════════╝
                                   │
                                   ▼
╔═════════════ GUARD 2 · reconcileImpactValue(synthesized) ════════════════╗
║ Deterministic code arithmetic — cannot hallucinate. If impactValue       ║
║ states an aggregate across items that a ranked_list/comparison block     ║
║ also lists individually, re-add them in JS and splice the corrected      ║
║ magnitude back in (preserving sign, currency symbol, "/ mo", …).         ║
║ Deliberately conservative — bails out when:                              ║
║   · impactValue already matches ONE listed item (±5%) — the "here's the  ║
║     standout, the rest is context" shape, not an aggregate claim         ║
║   · sign(claimed) ≠ sign(sum)          — a different, more serious error ║
║   · ratio ∈ [0.98, 1.02]               — normal rounding                 ║
║   · ratio < 0.5 or > 2                 — probably an unrelated metric    ║
╚══════════════════════════════════╤══════════════════════════════════════╝
                                   │
                                   ▼
╔═════════════ STEP 4 · VERIFY ════════════════════════════════════════════╗
║ verifyInsight({ rows(≤30), synthesized })  — a SEPARATE LLM call         ║
║   LLM: claude-sonnet-4-6, maxTokens 1024, jsonOutput                     ║
║   It is given ONLY the raw rows + the finished factual fields —          ║
║   never the reasoning that produced them, and it has no stake in the     ║
║   write-up sounding good.                                                ║
║   Checks: every number traceable to the rows or a simple aggregate of    ║
║   them · explicit re-addition of any claimed total · internal            ║
║   consistency across blocks · not overstating a thin result.             ║
║   Exempt: a scenarios block's good/neutral/negative projections.         ║
║   out: { verified, issues[] }                                            ║
║   (verifier itself erroring ⇒ treated as "unable to verify", not fail)   ║
╚══════════════════════════════════╤══════════════════════════════════════╝
                     verified? ────┴──── no ──┐
                       │ yes                  │
                       │                      ▼
                       │        ┌─────────────────────────────────────┐
                       │        │ REGENERATE ONCE                     │
                       │        │  synthesize again, with the         │
                       │        │  verifier's exact complaints fed    │
                       │        │  back as verifierFeedback           │
                       │        │  → reconcileImpactValue again       │
                       │        │  → verify again                     │
                       │        └──────────────┬──────────────────────┘
                       │                       │ still not verified?
                       │                       ▼
                       │        ╔══════════ GUARD 3 · DOWNGRADE ═══════════╗
                       │        ║ Not discarded — the QUERY was real, only ║
                       │        ║ the write-up over-claimed:               ║
                       │        ║   tag        → "DATA QUALITY"            ║
                       │        ║   confidence → min(confidence, 40)       ║
                       │        ║   confidenceChecks ← prepend the         ║
                       │        ║     verifier's issues as a caveat        ║
                       │        ╚══════════════┬═══════════════════════════╝
                       ▼                       │
        (same downgrade is applied unconditionally if GUARD 1 flagged)
                       └───────────┬───────────┘
                                   ▼
╔═════════════ ASSEMBLE ═══════════════════════════════════════════════════╗
║ normalizeChart()  — card-preview chart; 2 series ⇒ primary + dashed      ║
║                     orange baseline; 3+ series ⇒ distinct palette colors ║
║ normalizeBlocks() — keep ≤3 valid blocks, ranked_list ≤10 items,         ║
║                     comparison ≤3 items, clamp pct to 0..100;            ║
║                     empty ⇒ fall back to [{ type:'chart', chart }]       ║
║ id = `investigate-${Date.now()}` · createdAt · origin · viewed:false     ║
║ tracked:false · confidenceLabel (≥85 High, ≥65 Medium, else Low)         ║
║ evidence = { prompt, dataQuestion, sql, verification }                   ║
╚══════════════════════════════════╤══════════════════════════════════════╝
                                   ▼
              store.insert(datasetId, userId, insight)  → Postgres JSONB
                                   ▼
              200 { prompt, status:'ready', resultLabel, findingsCount,
                    combinedImpactLabel, insightIds:[id] }
```

### Round-trip budget for one investigation

| Step | Calls | Model / cap | Retry policy |
|---|---|---|---|
| classify-prompt (client-side gate, optional) | 1 | sonnet-4-6, 64 tok | none — failure ⇒ treat as investigation |
| propose (only when no prompt typed) | 1 | sonnet-4-6, 256 tok | none |
| PLAN | 1–2 | sonnet-4-6, 512 tok | 2 attempts on malformed/incomplete JSON |
| QUERY → SQL generation | 1–3 | sonnet-4-6, 4096 tok | 3 attempts; parse errors *and* PG errors both fed back |
| QUERY → execution | 1–3 | Postgres, 15 s timeout | retried with the same budget; timeouts get 1 retry |
| SYNTHESIZE | 1–2 per round, up to 2 rounds ⇒ ≤4 | sonnet-4-6, 6144 tok | 2 attempts per round on bad JSON / missing headline |
| VERIFY | 1–2 | sonnet-4-6, 1024 tok | one regenerate-and-recheck cycle |
| action plan (on demand, later) | 1 | sonnet-4-6, 1024 tok | cached on the insight after the first call |

Typical wall clock: **30–100 s** per investigation.

---

## How proposed insights are created

"Proposed" means Aspect chose the angle itself — the user clicked **Request a new insight** without typing anything, or an admin ran **bootstrap**. Two different mechanisms:

### 1. `proposeInvestigationPrompt()` — the model picks a genuinely new angle

This is **not** a hardcoded rotation of topics. The call is:

```
listGenerated(datasetId, userId)          ← everything already found for THIS user+dataset
        │
        ▼
covered = existing.map(i => `- [${i.category}] ${i.evidence.dataQuestion || i.headline}`)
        │
        ▼
LLM prompt = brandLabel
           + config.dataModelDescription       ← what data actually exists
           + "Already investigated:\n" + covered
           + "Propose ONE new investigation … meaningfully different from
              everything already investigated: a different measure,
              dimension, or angle — not a rephrasing of an existing one."
        │
        ▼
{ "prompt": "Which product families are losing share to their own promotions?" }
        │
        ▼
feeds straight into the normal PLAN → QUERY → SYNTHESIZE → VERIFY pipeline
```

The coverage list is the whole point: the model is shown *what it already knows*, so it is pushed toward a real gap rather than a rephrasing. (A bug fixed 2026-08-07: this called `listGenerated(datasetId)` without `userId`, so `existing` was always empty and the anti-repeat instruction had nothing to compare against.)

The resulting insight is stored with `origin: 'proposed'`; the History page uses that to label it as Aspect-suggested rather than "my report". The auto-chosen prompt is returned to the client in the response's `prompt` field so the job badge isn't blank.

### 2. `bootstrap()` — the curated starter set

For an empty feed. Runs `config.bootstrapPrompts` (registry defaults, admin-editable) one at a time under `userId = 'system'`. Each is a full real investigation. Individual failures are logged and skipped so a partial populate still succeeds.

### 3. Admin-side proposals

`POST /api/admin/intelligence/datasets/:id/generate-example-prompt` proposes one new *example chip* (a short, clickable end-user question) using the same "must differ from everything already listed" idea, scoped to `examplePrompts`. Returns a **draft** — the admin reviews it and saves it explicitly.

---

## How correctness is enforced

Five layers, deliberately of different kinds — code where code is reliable, an LLM only where judgment is genuinely needed, and a hard rule that doesn't trust either.

```
┌────────────────────────────────────────────────────────────────────────┐
│ L0  GROUNDING (structural)                                             │
│     SYNTHESIZE never sees the plan alone — it sees the real result     │
│     rows (≤30), the executed SQL, the row count. "Do not invent any    │
│     figure that isn't directly computable from the provided rows."     │
│     The only licensed extrapolation in the entire output is a          │
│     `scenarios` block's good/neutral/negative projections.             │
├────────────────────────────────────────────────────────────────────────┤
│ L1  SQL SAFETY + SELF-CORRECTION (code + engine)                       │
│     Whole-word DDL/DML rejection, statement_timeout, row cap, and 3    │
│     attempts where the actual Postgres error text is fed back to the   │
│     generator. Anti-patterns from real production slow/error queries   │
│     are injected into the prompt so known-bad shapes aren't repeated.  │
├────────────────────────────────────────────────────────────────────────┤
│ L2  detectSuspiciousResult (deterministic, pre-LLM)                    │
│     Catches the JOIN-bug signature: a metric that is 0 on every row,   │
│     or the identical non-zero value on every row. Real business data   │
│     essentially never does this across 3+ rows for a dimension that    │
│     is supposed to vary. Benchmark/percentile/threshold/avg-named      │
│     columns are excluded — flat is correct there.                      │
│     ORIGIN: the false "19 stores at 0% Q3 attainment" finding, caused  │
│     by a target-vs-actual join that added `part` to the join key.      │
├────────────────────────────────────────────────────────────────────────┤
│ L3  reconcileImpactValue (deterministic arithmetic)                    │
│     Re-adds the block's own listed item values in JS and overwrites    │
│     impactValue if the model's mental math disagreed. Fixes the single │
│     most common real failure (headline total ≠ sum of listed items)    │
│     for free, without spending the one regenerate retry on arithmetic  │
│     that code can just do exactly.                                     │
├────────────────────────────────────────────────────────────────────────┤
│ L4  verifyInsight (INDEPENDENT LLM fact-check)                         │
│     A separate call, not another instruction in the synthesis prompt — │
│     asking one call to both "write something compelling" and           │
│     "critically fact-check yourself" is a conflict of incentives.      │
│     Catches what L2/L3 structurally cannot: a plausible number that    │
│     was simply invented. One regenerate-and-recheck retry with the     │
│     verifier's exact complaints fed back.                              │
├────────────────────────────────────────────────────────────────────────┤
│ L5  HARD DOWNGRADE (code, unconditional)                               │
│     Independent of whether L2's prompt hint or L4's verdict "took":    │
│     if the data was flagged OR verification still fails after the      │
│     retry → tag = "DATA QUALITY", confidence = min(c, 40), the         │
│     verifier's issues prepended to confidenceChecks.                   │
│     DOWNGRADE, NOT DISCARD — the query was real; a less-confident but  │
│     honest insight beats nothing, and beats a canned fallback.         │
└────────────────────────────────────────────────────────────────────────┘
```

### What the user can audit

Everything above leaves a visible trail on the detail page:

| Field | Contents |
|---|---|
| `evidence.prompt` | what was actually asked (typed, or Aspect's own proposal) |
| `evidence.dataQuestion` | the concrete question PLAN committed to |
| `evidence.sql` | the exact SQL that ran — rendered by "View SQL queries" |
| `evidence.verification` | `{ verified, issues[] }` — proof the write-up itself was checked |
| `reasoning[]` | the steps taken, referencing the real measures used |
| `confidenceChecks[]` | strengths and caveats, with any verifier complaint first |
| `confidenceBasis` | the real sample size / time window behind the score |
| `sourceNote` | e.g. `Source: facts table · 1,860 rows` |

### The "now" problem

Without an anchor, the model dates its own output from its training era — it was caught writing "as of Q3 2024" against data that runs through mid-2026. `getDataThroughDate(datasetId)` resolves the dataset's real last data date via `DataReloadService.getDataInfo(schemaName)` — the same per-schema freshness lookup the `DataStatusBar` uses, not a dataset-specific hardcoded query — caches it per dataset, and injects it into both PLAN and SYNTHESIZE as "treat this as *now*".

### Known failure modes and how they were closed

| Symptom | Root cause | Fix |
|---|---|---|
| "19 stores at 0% Q3 attainment" | target rows have no `part` dimension; adding it to the join made every actual resolve to 0 | schema rule 4.7 in the generator + `detectSuspiciousResult` all-zero |
| Same non-zero value on every row | same class of pipeline gap, just not zero | `all-same-value` branch (with benchmark-column exclusion) |
| Headline total ≠ sum of listed items | model mental math | `reconcileImpactValue` (code arithmetic) |
| `reconcileImpactValue` *introducing* an error | it summed a ranked_list that was context, not addends | bail out when impactValue matches a single listed item (±5%) |
| Insight shipped "verified" without being checked | verifier response hit its 512-token cap and was swallowed by the catch | raised to 1024; `looksTruncated()` makes the log line actionable |
| Whole investigation killed by one bad JSON response | PLAN/SYNTHESIZE had no retry; SQL *generation* errors returned before using the existing attempt budget | 2 attempts each; generation errors now retry like execution errors |
| Multi-month trend labelled "Leader: Jun" | `toTrackedMetric` classified any 1-series >2-point chart as a ranking | `looksLikeTimeSeries()` checks the actual category labels first |
| Live insights vanishing after every deploy | insights were a JSON file inside the Docker build context (`COPY . .`), so each image baked in a stale snapshot | moved to Postgres (migration 037) |

---

## How the pipeline knows what to extract from a given schema

This is the part that makes one generic pipeline work across six unrelated retail datasets. Knowledge is layered from *most generic* to *most specific*, and each layer has a different author.

```
                    ┌─────────────────────────────────────────┐
                    │ THE QUESTION                            │
                    │ "Main risks for the next 6 months"      │
                    └─────────────────┬───────────────────────┘
                                      │
   ╭──────────────────────────────────┴─────────────────────────────────╮
   │ LAYER 1 — BUSINESS-LEVEL DATA MODEL   (read by PLAN)               │
   │ config.dataModelDescription — ONE plain-language paragraph, no     │
   │ table or column names. Shape: what the core data is · "Common      │
   │ measures: …" · "Common dimensions: …".                             │
   │                                                                     │
   │ hypertoy example (registry default, admin-editable):                │
   │   "a facts table with sales, inventory, and target rows (record     │
   │    types), joined to products, stores/warehouses, and customers.    │
   │    Common measures: revenue (ex VAT), profit, margin %, units       │
   │    sold, target attainment %, inventory value/units, loyalty        │
   │    signups. Common dimensions: store, region, branch, product,      │
   │    product family, date (day/week/month/quarter), cashier,          │
   │    campaign, customer city. IMPORTANT: sales targets/attainment     │
   │    exist only at store+time granularity — never ask for target      │
   │    attainment broken down by product/product family/SKU, that       │
   │    dimension does not exist on target rows."                        │
   │                                                                     │
   │ ⇒ PLAN can only commit to a question the data can actually answer.  │
   │   The trailing IMPORTANT clause is a real negative constraint —     │
   │   it stops the false-attainment question from being ASKED at all,   │
   │   one layer earlier than the SQL rules that stop it being WRITTEN.  │
   │ ⇒ Source: registry.js default, overridable per dataset in admin;    │
   │   admin can also auto-draft it from the live schema (see below).    │
   ╰──────────────────────────────────┬─────────────────────────────────╯
                                      │  dataQuestion (English)
   ╭──────────────────────────────────┴─────────────────────────────────╮
   │ LAYER 2 — PHYSICAL SCHEMA        (read by SQL generation)          │
   │ schema-descriptor.service.js introspects the LIVE database:        │
   │   information_schema.tables  → every table                         │
   │   pg_matviews               → every materialized view              │
   │        (Postgres does NOT list MVs in information_schema — missing │
   │         this once meant the generator never learned MV columns,    │
   │         e.g. mv_sales_by_store.store_number)                       │
   │   information_schema.columns → columns, types, nullability         │
   │   pg_attribute/pg_class      → MV columns (same reason)            │
   │   SELECT * LIMIT 3           → real sample values per table/MV     │
   │   COUNT(*)                   → row counts (drives "use the MV")    │
   │                                                                     │
   │   → deterministic raw schema map (rawSchemaText)                   │
   │   → Claude PRETTIFIES it into prose. If that call fails, the RAW   │
   │     map is used as-is — the generator always gets real columns,    │
   │     never a guess.                                                 │
   │   → cached in public.schema_descriptions (regenerate on demand)    │
   ╰──────────────────────────────────┬─────────────────────────────────╯
                                      │
   ╭──────────────────────────────────┴─────────────────────────────────╮
   │ LAYER 3 — HAND-WRITTEN SCHEMA RULES   (_getSchemaSpecificRules)    │
   │ Per-schema, no cross-contamination. This is where the knowledge    │
   │ introspection CANNOT recover lives — semantics, quirks, traps:     │
   │   · `facts` mixes record types → ALWAYS filter record_type         │
   │     ('מכירות' sales / 'מלאי' inventory / 'יעדים' targets)          │
   │   · 40M-row facts ⇒ MUST use mv_sales_daily_* for top-N/revenue    │
   │   · never COUNT(DISTINCT transaction_id) over the whole facts table│
   │   · franchisee_code is empty — attribute via register_name         │
   │   · campaign_name is a NUMBER, not a label — don't present it as   │
   │     a name                                                         │
   │   · partial-month vs full-month needs pace adjustment, not raw     │
   │     totals (otherwise everything "declines")                       │
   │   · "anomalies" = Z-score > 2, never an invented ±% band           │
   │   · targets have no product dimension — join on (warehouse, month) │
   │   · some Latin payment names are stored character-reversed         │
   │   + canonical reference queries per dataset                        │
   ╰──────────────────────────────────┬─────────────────────────────────╯
                                      │
   ╭──────────────────────────────────┴─────────────────────────────────╮
   │ LAYER 4 — LEARNED ANTI-PATTERNS   (_buildAntiPatternsSection)      │
   │ The last 20 real slow/error/timeout queries for this schema from   │
   │ slow-query.service (5-minute cache), up to 8 rendered into the     │
   │ prompt with their label and question:                              │
   │   -- TIMEOUT (15003ms) / -- ERROR: column "x" does not exist       │
   │   <the actual SQL>                                                 │
   │ "Study them and do NOT reproduce their patterns."                  │
   │ ⇒ the system gets harder to break over time, from production       │
   │   traffic, with no code change.                                    │
   ╰──────────────────────────────────┬─────────────────────────────────╯
                                      │
   ╭──────────────────────────────────┴─────────────────────────────────╮
   │ LAYER 5 — EXECUTION FEEDBACK      (previousError / previousSql)    │
   │ If the SQL errors at execution, the exact Postgres message plus    │
   │ the failing SQL go back into the next attempt, with targeted hints │
   │ (qualify ambiguous columns · cast TEXT numerics before SUM ·       │
   │  NULLIF every denominator · wrap measures in SUM under GROUP BY ·  │
   │  if the data genuinely doesn't exist, return zero rows rather      │
   │  than referencing a missing column).                               │
   ╰──────────────────────────────────┬─────────────────────────────────╯
                                      ▼
                       SQL that is valid for THIS schema
```

### Choosing what to *present* from the result

Knowing which columns exist is only half of it — the pipeline also decides what shape the finding should take. SYNTHESIZE is given a **palette**, not a template, and must pick 1–3 blocks for *this* finding:

| Block | Use when | Normalization applied |
|---|---|---|
| `chart` | a real trend or multi-item breakdown worth plotting | 2 series ⇒ primary + dashed orange baseline; 3+ ⇒ distinct palette colors |
| `ranked_list` | "which N stores/products/families…" — the ranking *is* the finding | ≤10 items, `pct` clamped 0–100 |
| `stat_callout` | one single-fact finding | value/label/description coerced to strings |
| `comparison` | the finding *is* a contrast between 2–3 groups | ≤3 items, `direction` validated |
| `scenarios` | "what happens if we act vs don't" | exactly 4 cards (current/good/neutral/negative) |

The instruction is explicit that using all of them out of habit is wrong, and that a block adding no information beyond another chosen block must not be included. The top-level `chart` field is separate and always filled — it is the small list-card preview, independent of whether a `chart` block was chosen for the detail page.

### Adding a seventh dataset

Add one entry to `insights/datasets/registry.js` (id, `schemaName`, `getPool`, branding, default brand label / data-model description / bootstrap + example prompts), then enable it in the admin panel. Nothing else changes — the public list endpoint auto-discovers enabled datasets. Optionally add a `_getSchemaSpecificRules()` block in `sql-generator.service.js` for that schema's quirks; without one, the generator falls back to Layers 2, 4 and 5 only.

An admin can auto-draft Layer 1 from Layer 2: `POST /api/admin/intelligence/datasets/:id/generate-description` runs a live schema introspection (with that dataset's own pool) and asks the model to rewrite it as the plain-language paragraph, in the exact "core data · Common measures · Common dimensions" shape. It returns a **draft only** — the admin reviews and PUTs it.

> **Caveat worth knowing:** `sql-generator.service.js` calls `schemaDescriptorService.getDescription(schemaName, false, null, getZer4uPool())` — the zer4u pool is passed as the **cache** pool, and the generation pool is left `null` (i.e. the platform `db.pg` pool). All six datasets currently live in the same `aspect-data-db` instance, so cached descriptions resolve fine; but on a **cache miss** in an environment where the platform DB is a different instance from the data DB, introspection would find no tables for that schema. The admin `generate-description` route does not have this issue — it passes `entry.getPool()` explicitly.

---

## The insight object

Every insight is stored as one atomic JSON object. Abbreviated shape:

```jsonc
{
  "id": "investigate-1754557200123",     // `investigate-${Date.now()}`
  "category": "risk",                    // cross-sell|margin|inventory|trend|risk
  "categoryLabel": "Risk",
  "tag": "RISK",                         // or "DATA QUALITY" when downgraded
  "confidence": 82,
  "confidenceLabel": "Medium",           // ≥85 High · ≥65 Medium · else Low
  "confidenceScore": 82,
  "foundAgo": "just now",
  "isGenerated": true,
  "createdAt": 1754557200123,
  "origin": "user",                      // 'user' | 'proposed'
  "viewed": false,                       // flips on first detail-page open
  "tracked": false,                      // the ONLY source of "Tracked by you"
  "trackedOrder": 0,                     // set when tracked; drag-to-reorder

  "headline": "…one sentence with real numbers (list card)…",
  "title": "…longer headline, same numbers (detail page)…",
  "breadcrumbLabel": "Q3 target gap",
  "impactValue": "-₪10.04M",
  "impactLabel": "revenue at risk",
  "impactDirection": "negative",         // positive | negative | neutral
  "ctaLabel": "action plan",

  "chart": {                             // list-card preview only
    "title": "…", "unit": "₪K",
    "categories": ["…"],
    "series": [{ "key": "s0", "label": "…", "color": "#C2410C",
                 "dashed": false, "points": [/* numbers */] }]
  },

  "blocks": [ /* 1–3 of: chart | ranked_list | stat_callout |
                          comparison | scenarios */ ],

  "reasoning":        [{ "title": "…", "description": "…" }],
  "confidenceChecks": [{ "positive": true|false, "text": "…" }],
  "confidenceBasis":  "…real sample size / time window…",
  "sourceNote":       "Source: facts table · 1,860 rows",

  "evidence": {
    "prompt": "…what was actually asked…",
    "dataQuestion": "…what PLAN committed to…",
    "sql": "SELECT …",
    "verification": { "verified": true, "issues": [] }
  },

  "actionPlan": null                     // filled + cached on first plan request
}
```

The list endpoint returns a **summary** projection (`toSummary`) — the card fields plus a `chartPreview` — not the full blocks/reasoning/evidence payload.

---

## Storage

`intelligence_insights` (migration 037), in the **main platform DB** (`db.pg`) — never a per-dataset business-data pool.

```
intelligence_insights
 ├─ id             BIGSERIAL PK
 ├─ dataset_id     TEXT      ┐
 ├─ user_id        TEXT      ├─ UNIQUE (dataset_id, user_id, insight_id)
 ├─ insight_id     TEXT      ┘
 ├─ data           JSONB     ← the whole insight object, atomic
 ├─ tracked        BOOLEAN   ┐ promoted out of JSONB purely so listing /
 ├─ tracked_order  BIGINT    │ sorting / filtering never has to parse
 ├─ created_at     BIGINT    ┘ every row's JSONB in JS
 └─ updated_at     TIMESTAMPTZ

 idx (dataset_id, user_id, created_at DESC)
 idx (dataset_id)
 idx (dataset_id, tracked) WHERE tracked = true
```

`rowToInsight()` is the single place the promoted columns are resolved back onto the plain object. All single-field updates (mark viewed, toggle tracked, cache an action plan) go through one generic `updateInsight(…, mutate)` read-modify-write, so each keeps its simple "just set a field" logic.

**Ownership:** reports are private per anonymous browser session, using the same identity model as chat conversations (`users.externalId`, created by `POST /api/user/create`, kept in `localStorage`). Every public route requires a `userId` and throws 400 rather than silently falling back to a shared bucket — a shared bucket would leak one user's reports into another's feed. Bootstrap output lives under the sentinel `userId` `'system'`.

**Why Postgres, not a file:** the earlier implementation wrote `insights/data/generated-insights.json`, which sat in the Docker build context and was baked into every image by `COPY . .`. Every deploy silently reset live production insights to whatever stale snapshot was on the deploying machine. Caught in production on 2026-08-07.

---

## API

### Public — `/api/insights` (per-session, `userId` required)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | enabled datasets, auto-discovered from registry + config |
| GET | `/:datasetId/insights?userId=` | insight summaries for this session |
| GET | `/:datasetId/tracked?userId=` | tracked insights condensed into strip cards |
| POST | `/:datasetId/tracked/reorder` | `{ userId, insightIds[] }` — full new order |
| GET | `/:datasetId/:insightId?userId=` | full detail; **also marks it viewed** (fire-and-forget, after the response is built) |
| POST | `/:datasetId/classify-prompt` | `{ prompt }` → `{ isSimpleQuery }` |
| POST | `/:datasetId/investigate` | `{ userId, prompt? }` → runs the pipeline |
| POST | `/:datasetId/bootstrap` | curated populate under `userId: 'system'` |
| POST | `/:datasetId/:insightId/track` | `{ userId, tracked }` |
| POST | `/:datasetId/:insightId/plan` | generate (or return cached) action plan |
| DELETE | `/:datasetId/:insightId?userId=` | remove a generated insight |

Route order matters: `/:datasetId/insights`, `/:datasetId/tracked`, and `/:datasetId/tracked/reorder` are registered **before** `/:datasetId/:insightId` so those segments aren't matched as insight ids.

Any dataset that is unknown or not enabled returns **404** from `requireEnabled()`.

### Admin — `/api/admin/intelligence` (cross-user, no auth, not linked from public nav)

| Method | Path | Purpose |
|---|---|---|
| GET | `/datasets` | every registered dataset + config + insight/tracked counts |
| PUT | `/datasets/:id` | update config; auto-snapshots the pre-write section into history |
| GET | `/datasets/:id/versions/:section` | version history for `config` or `prompts`, newest first |
| POST | `/datasets/:id/versions/:section/:savedAt/restore` | restore a past version (itself snapshotted ⇒ undoable) |
| DELETE | `/datasets/:id/versions/:section/:savedAt` | drop one history entry (live config untouched) |
| POST | `/datasets/:id/generate-description` | draft a `dataModelDescription` from the live schema |
| POST | `/datasets/:id/generate-example-prompt` | draft one new example chip |
| GET | `/datasets/:id/insights` | every insight for the dataset across all sessions |
| DELETE | `/datasets/:id/insights/:insightId` | cross-user delete |
| POST | `/datasets/:id/insights/:insightId/track` | cross-user track toggle |

The public routes can't be reused for admin because they scope strictly by `userId`, and the admin page manages content across every anonymous session at once — hence the deliberate `…Any` duplicates (`deleteGeneratedAny`, `setTrackedAny`, `getByIdAny`).

---

## Configuration

Registry defaults are layered **underneath** an admin override stored as one JSON blob per dataset in the generic `provider_config` table (key `intel_config_<datasetId>`) — the same pattern `schedule-config.service.js` uses, so no dedicated table or migration was needed.

```
registry.js defaults ──────┐
  defaultBrandLabel        │
  defaultDataModelDescr.   ├──► parseEntry() ──► resolved config
  defaultBootstrapPrompts  │         ▲
  defaultExamplePrompts    │         │
  enabled: id==='hypertoy' │   provider_config['intel_config_<id>']  (admin override)
───────────────────────────┘
```

Editable fields: `enabled`, `brandLabel`, `dataModelDescription`, `bootstrapPrompts`, `examplePrompts`.

**Version history is per section, not dataset-wide.** `config` (`brandLabel`, `dataModelDescription`) and `prompts` (`bootstrapPrompts`, `examplePrompts`) are edited on separate admin screens, so each carries its own history array (`configHistory`, `promptsHistory`, capped at 20, newest first) on the same blob. `setConfig()` snapshots the pre-write state of only the section(s) the patch actually touched. `restoreVersion()` re-applies a snapshot *through* `setConfig()`, so restoring is itself snapshotted — nothing is destructively lost. Histories are stripped from the hot list/get paths to keep dataset-list responses small.

Only `hypertoy` is enabled by default; the other five are registered but off until verified.

### Registered datasets

| id | schema | brand |
|---|---|---|
| `hypertoy` | `hypertoy` | Hyper Toy — toy retail chain |
| `zer4u` | `zer4u` | Zer4U — florist & gift retail |
| `newdeli` | `newdeli` | New Deli — food ordering/delivery |
| `thestock` | `thestock` | The Stock — discount retail |
| `zolstock` | `zolstock` | Zol Stock — discount retail |
| `tevanaot` | `tevanaot` | Teva Naot — footwear retail |

All six currently share the `aspect-data-db` pool (`db.zer4u` is re-exported by the rest), but the registry keys the `DataQueryService` instance per dataset so a dedicated pool for any of them stays valid.

---

## Tracked metrics and action plans

**"Tracked by you"** is genuinely user-curated — there is no separately auto-computed metric set. It is exactly the insights whose `tracked` flag was toggled from their own detail page, condensed by `toTrackedMetric()` into a strip card that reuses **the insight's own card chart**, so what you tracked is literally what you see.

The trend label is derived from that chart's first series:

```
points.length > 2  AND  series.length === 1  AND  categories are NOT calendar-shaped
        ⇒ RANKING       → label "Leader: <category of max point>"
otherwise, points ≥ 2
        ⇒ TREND         → pct = (last - first) / |first| × 100
                          ▲/▼ shown only when |pct| ≥ 1, else "— flat"
```

`looksLikeTimeSeries()` inspects the actual category labels (`Jan…Dec`, `Q1–Q4`, `W12`, a bare year) *before* the point-count heuristic — a 6-month margin trend has the identical shape (1 series, >2 points) as a ranking and was being mislabelled "Leader: Jun".

**Action plans** ("Open margin plan" on the detail page) run **no new SQL**. Every number needed to recommend next steps was already established when the insight was found, so `generateActionPlan()` is grounded only in that insight's own `headline`, `categoryLabel`, `impactValue`, `blocks`, and `reasoning`, and produces 3–5 prioritized steps plus an expected impact. The result is cached onto the insight so reopening the modal doesn't re-run the LLM.

---

## Testing

**`node scripts/test-insights-unit.js`** — fast, offline, deterministic. Exercises the pure exported logic (`detectSuspiciousResult`, `looksLikeTimeSeries`, `reconcileImpactValue`) with cases that lock in each of the 2026-08-07 bugs. These three are exported *solely* for this script — no route calls them directly.

**`API_BASE=… node scripts/test-insights-battery.js [datasetId]`** — the real thing: 7 varied prompts (including the empty-prompt auto-propose path and the historically flaky basket-affinity one) driven through the live HTTP API against a real DB. "PASS" means the pipeline completed and returned a well-formed insight, not merely HTTP 200. A **downgraded** result (DATA QUALITY / still-unverified) is reported as a `[note]`, not a failure — that's the safety net working as designed. Every insight it creates is deleted at the end under a disposable per-run `userId`, so a battery run never leaves cruft in a real feed.

Most of the fixes in the failure-mode table above were found by the battery, not by users.

---

## Design decisions worth remembering

- **No canned fallback, anywhere.** A failed investigation returns an error and the UI shows its error/restart state. A fabricated success would be worse than nothing.
- **Downgrade, don't discard.** The query was real even when the write-up over-claims; a hedged low-confidence insight tagged DATA QUALITY is more useful — and more honest — than silence.
- **Verification is a separate call.** One model call cannot both advocate for a finding and skeptically audit it.
- **Code does arithmetic; the model does judgment.** Anything a deterministic function can check (uniform columns, sums) is checked in code, before and independently of any LLM.
- **The detail page is a palette, not a template.** Blocks are chosen per finding; a simple fact gets a `stat_callout`, a multi-store comparison gets `ranked_list` + `scenarios`.
- **The insight is one atomic object** end to end — in the service, in the JSONB column, and over the wire. Promoted columns exist only for indexing.

---

# Current state (2026-08-11)

Measured across all six datasets — 42 investigations, every displayed figure re-verified by re-executing the cited SQL. Full data in `verification/insights-accuracy/`.

| | before this round | now |
|---|---|---|
| Cases producing a report | 21/42 (50%) | **34/42 (81%)** |
| Figures verified true | 60/74 | **133/135 (98.5%)** |
| Schema contract test | 7/9 | **9/9** |
| Data Chat regression | not tested | **24 questions, 0 wrong answers** |

Hypertoy reconciles to the client's Qlik dashboard **to the shekel** (total ₪131,801,440; Lego ₪19,000,391).

## Guards now in the pipeline, in order

1. **Determinism** — every LLM step at `temperature: 0` (SQL generation included; it previously ran at the provider default of 1.0, so the same question produced different SQL each run).
2. **Data-recency anchor** — relative windows ("last 4 weeks", "this quarter") are pinned to the date the data actually ends, not `CURRENT_DATE`. Datasets are periodic exports; thestock was 106 days behind, newdeli 100, which made every recent-window query correctly empty.
3. **Rule corrector** — hand-written per-dataset rules are diffed against the live catalog at generation time; relations that no longer exist are named and overridden.
4. **`detectSuspiciousResult`** — all-zero / all-same-value columns, with a coverage floor so sparse annotation columns don't false-fire.
5. **`buildResultDigest`** — the authoritative numbers. See below.
6. **`reconcileImpactValue`** — code arithmetic overrides the model's mental math, skipped when the block is a top-N excerpt of a larger population.
7. **Measure baselines** — a result exceeding the whole fact table is impossible; rejected with a 422.
8. **Independent VERIFY** — a separate LLM pass fact-checking against the digest, with one regenerate-and-recheck.
9. **Confidence ceiling** — the model's self-reported score is only an upper bid; the final number is `min(claimed, evidence-derived ceiling)`, with every deduction shown.

## Why the digest is the centre of it

The original failure was not bad SQL — it was that the write-up model saw 30 rows of a 20,723-row result and treated them as the population. Every total, ranking and percentage was computed over 0.14% of the data, and VERIFY passed it all because those numbers really were in the rows it was shown.

| reported | true | error |
|---|---|---|
| Campaign 78: ₪7,885 | ₪555,229 | 70× |
| Campaign 90: ₪3,320 | ₪421,229 | 127× |
| "99.7% unattributed" | 94.90% | — |
| top campaign #193 | actually ~20th | — |

The digest re-aggregates the entire result in plain JS, collapsing accidental extra grain back to what PLAN asked for, and hands the model exact figures plus pre-computed roll-ups. **It works even when the SQL is wrong** — a later run still produced the 20,723-row grain, and the digest collapsed it to 28 campaigns with every number correct.

---

# Known limitations & leftovers

Everything below is real, reproducible, and *not* fixed. Reproduce with `node scripts/test-insights-suite.js <dataset> all`.

## 1. Eight cases still fail (of 42)

| dataset | count | shape |
|---|---|---|
| tevanaot | 3 | timeouts / inventory sell-through |
| thestock | 2 | zero-row, inventory & sell-through |
| zolstock | 1 | zero-row, "items overstocked" |
| hypertoy | 1 | timeout on target-vs-actual |
| zer4u | 1 | *baseline guard correctly rejecting a fan-out* — a wanted failure |

**The pattern worth chasing:** the remaining zero-rows cluster on **inventory / sell-through** questions across three unrelated datasets. That smells like a shared cause (inventory rows live under a different `record_type`, with no date column, so a date-filtered query returns nothing) rather than three coincidences. One focused look before the architectural work.

## 2. Two figures still wrong — prefix-colliding entity names

`verification/insights-accuracy/suite-results-newdeli.json`, "Main risks for the next few months":

| label | reported | actual | off by |
|---|---|---|---|
| `עזריאלי חיפה` | 308,084 | 288,398 | 7% |
| `עזריאלי תל אביב (Egz)` | 178,499 | 224,914 | 21% |

newdeli has several branches sharing the prefix `עזריאלי`. The digest groups them correctly; the write-up appears to attribute one branch's figure to another. **Approach:** have the digest emit an explicit disambiguation warning when two group keys share a prefix, and require the write-up to use full keys verbatim.

## 3. Chat times out where Insights succeeds

4 of 24 chat questions hit chat's 15s statement limit. Two of them (`tevanaot` revenue-by-store, `zolstock` top-10 items) **succeed under Insights' 75s** — same query, different budget. **Approach:** raise chat's timeout, or pre-aggregate. See `verification/chat-regression/`.

## 4. zer4u can still build bad SQL

Even after rewriting its rules, one run produced a `JOIN … ON TRUE` cartesian reporting **₪362.9B** for a florist chain whose sales table totals ₪51M. The measure baseline caught it (6,379× over ceiling) and the confidence ceiling had already capped the model's self-reported 72 down to 45 — but the query should never have been built. **Approach:** a cartesian-join detector is tempting, but `CROSS JOIN` to a single-row CTE is legitimately used for benchmark columns, so a hard block would break working queries. The semantic layer is the real answer.

## 5. Statistical significance is still not tested

Materiality now excludes tiny-denominator rows from superlatives, and every extreme carries its base (`-194.1pp, on revenue=119`). But nothing computes significance, controls for seasonality, or compares against a baseline. A finding can be materially correct and still be noise. **Approach:** let PLAN emit a second baseline query (prior period or population average) so the write-up can say "N deviations from its own history" instead of "lowest".

## 6. Causal and forward-looking claims are unverified by design

"Why did margin drop" cannot be established from one aggregate query, and `scenarios` good/neutral/negative values are explicitly exempt from fact-checking. Both are plausible, not derived. No current plan changes this.

## 7. The architectural fix, not started

`bi/` already contains a working semantic layer (`bi/datasets/hypertoy.dataset.js` + `bi/services/query-compiler.js`) where record types, joins and non-summable measures are correct **by construction** and an unknown field returns a 400 rather than a plausible wrong answer. PLAN already emits `{measures, dimensions}` — most of a spec. Routing Insights through it, with NL→SQL as the fallback for what a spec can't express, is the change that makes an entire category of defect impossible instead of merely detected. Requires writing the 5 missing dataset definitions (~130 lines each). See `tasks/pending/insights-quality-plan.html`.
