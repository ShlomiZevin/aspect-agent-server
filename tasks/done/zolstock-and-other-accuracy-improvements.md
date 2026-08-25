# Accuracy improvements — ZolStock findings, applied generically

**Created:** 2026-08-17 · **Updated:** 2026-08-18 · **Evidence:** `verification/zolstock-quality/` (62 verified cases)

Every change below is **generic across all six datasets**. Where per-client content is
unavoidable it lives in the existing per-dataset seam (`services/schema-rules/<ds>.rules.js`
or the admin-editable config), never hardcoded in shared code. Two findings are business
decisions and are explicitly parked, not guessed at.

**Multi-tenant rule for this work:** no change may alter behaviour for a dataset that does
not exhibit the defect. Every guard is either (a) driven by live introspection, or (b) a
no-op when its precondition is absent. Regression-check hypertoy and zer4u after each change.

## Status at a glance — CLOSED 2026-08-19

| | Change | State |
|---|---|---|
| C1 | MV refresh + staleness detection | Done. Gated off (`MV_REFRESH_ENABLED`) until one clean production cycle is observed |
| C2 | Item roll-up views | **Done via the zolstock rebuild** — item questions 566s → 3.8-5.1s |
| C3 | PLAN fidelity contract | Done and verified live on 7 cases |
| C4 | All-NULL filter detection | Done and verified live (0.20s probe) |
| C5 | Partial-period coverage + chat parity | Done and verified live |
| C6 | Timeout discipline + data-model description | Done |
| — | Chip review | Done — 2 of 3 chips replaced (sellers and product family no longer exist) |

Plus three defects this work surfaced and fixed, all generic:
- **Silent substitution in chat** (answered about the wrong entity with no signal)
- **NULLs sort first on DESC** (empty rows led every "top N by value" ranking)
- **Premature schema swap** (a shadow with 1 of 8 views was promoted to production, and
  the swap killed the builder) — see below

Evidence: `verification/zolstock-quality/README.md`.

---

> **Everything below this line describes the dataset as it was BEFORE 2026-08-19.**
> On that date the client cut the feed to four files and retired the plural
> `Facts_ZolStock_CSV.csv`, which was the only source of actual money. Sellers,
> campaigns, discounts, invoices, retail customers, store targets and the
> `recommendation_facts` / `inventory` tables no longer exist. The sections below are
> kept because the *reasoning* still applies to the other five datasets — but the
> zolstock specifics in them are historical, not current. Current state:
> `verification/zolstock-quality/README.md` and `agents/zolstock/AGENT.md`.

## Correction to the original findings — customer data DOES exist

The first report stated that zolstock has no customer data and that the planner had
substituted sellers for customers. **That was wrong**, and it was my error, not the
system's. Checking the schema properly:

- `facts.customer_number` is populated on roughly a quarter of retail sales lines — an
  identified club/loyalty id — and it has its own index (`idx_facts_customer_number`),
  so it was built deliberately.
- Wholesale rows (`record_type IS NULL`, 1.9M) carry `customer_number` **and**
  `customer_name` (the business name).
- A real ranking runs and returns sensible results: top identified customers for 2026-05
  came back in 43.8s — within the reports budget, over chat's.

Consequences, all applied:

1. The zolstock `dataModelDescription` has been rewritten to describe customers accurately
   (previously it wrongly claimed name dimensions were "not yet loaded" at all).
2. `R28` and `C26` are reclassified from `absent` to `partial` in
   `scripts/zolstock-qa-cases.js` — the correct behaviour is to answer with a coverage
   caveat, not to decline.
3. The C3 example table below is corrected: the customers case is a **coverage** problem,
   not an absent-entity one.

---

## C1 · Materialized views never refresh — DONE, deliberately gated off

**Problem.** `REFRESH MATERIALIZED VIEW` appeared only in `scripts/lib/mv-builder.js`, run
by hand. Nothing in the reload pipeline refreshed anything, while the SQL rules deliberately
route most aggregate questions through MVs — so a reload without that manual step makes
every aggregate answer **silently stale**, for all clients.

**Built.** `insights/services/mv-refresh.service.js` — discovers views from `pg_matviews`,
measures each view's own `MAX(date)` against its source, refreshes only what is behind,
`CONCURRENTLY` where a UNIQUE index permits. Wired into `scheduler-tick.service.js`.

**Two bugs found in my own implementation, both caught before shipping:**

1. *Future-dated rows.* zolstock's wholesale rows carry dates to 2026-12-06. A bare `MAX()`
   read the data as ending in December and flagged every view stale. Fixed by excluding
   `> CURRENT_DATE`.
2. *Mismatched baseline.* The views aggregate sales only; the fact table also holds
   wholesale rows running two months later. Comparing against the unfiltered table marked
   every view permanently stale — which would have rebuilt an **868 MB view on every tick,
   forever**. Fixed by reading each view's own `record_type` predicate out of
   `pg_get_viewdef` and applying it to the baseline.

**Verified.** zolstock and thestock all views `stale=false`; tevanaot correctly reports
`stale=null` (no recognisable date column — it declines to guess); hypertoy no-ops.

**GATED OFF BY DEFAULT — `MV_REFRESH_ENABLED=true` to enable.** Three reasons:

- **None of zolstock's four MVs has a UNIQUE index**, so `CONCURRENTLY` is unavailable and
  a refresh takes `ACCESS EXCLUSIVE` — a full read outage on that view for its duration.
- The per-view cost is **still unmeasured** (the one open item from the original plan).
- It additionally refuses to run while a schema's import window is open, and the staleness
  probe is throttled to once per 15 minutes per dataset rather than every tick.

**Still to do:** measure per-view refresh seconds; decide whether to add UNIQUE indexes to
enable `CONCURRENTLY`; then enable the flag.

---

## C2 · Item-level questions time out — NOT STARTED, needs the database

**Problem.** `mv_sales_daily_item` is 8.2M rows / 868 MB. A plain `GROUP BY item_number`
over it took **over 120s** run alone, reproduced twice. Chat's budget is 15s, so every item
question fails there; in reports it cost 566s. Store and seller views (38k / 78k rows)
answer in seconds. The grain is the problem, not the query.

**Plan.** Two roll-ups built **from `mv_sales_daily_item`** (8.2M rows) rather than `facts`
(39M), so the added refresh cost is a fraction of one fact scan:

- `mv_sales_item_total` — one row per item (~300k): lifetime qty, revenue, profit, lines.
- `mv_sales_item_month` — item by month (~1–2M rows).

Then point the zolstock rules at them: lifetime for unscoped "top items", monthly for
period questions, daily only for genuine day-level analysis.

**This creates schema objects on the client database — confirm before running**, and build
it outside the import window. Give each a UNIQUE index so C1 can refresh it concurrently.

---

## C3 · PLAN silently rewrites the question — DONE

**Problem.** The worst failures all originated in PLAN, which rewrote the question;
everything downstream faithfully implemented the rewrite, so every existing guard passed:

| asked | PLAN's dataQuestion | result |
|---|---|---|
| which product **categories** yield most profit | "broken down by **item ID**" | 90,929 items, no categories |
| what is our **total** gross profit | "for the most recent **complete month**" | ₪13.5M against a true ₪231.5M |
| which **customers** buy the most | "each seller **(customer proxy)**" | answered about sellers — and needlessly, since customer data exists |

No numeric guard can catch this: the arithmetic is correct, the entity or period is not.

**Built.** PLAN's JSON contract gains two fields, both `null` in the normal case:

- `substitution: { asked, used, reason }` — set whenever the entity answered differs from
  the entity requested.
- `scopeAdded: { scope, reason }` — set whenever a period is imposed on a question that did
  not ask for one.

Both are validated (an empty object or a stray string is discarded, so a malformed
declaration cannot cap confidence forever), flow into `evidence`, cap confidence (55 for a
substitution, 75 for an added scope), and force the synthesis prompt to **lead** with the
departure rather than bury it in a footnote. The client renders each as a fixed banner
above the finding — a caveat under the chart is read after the reader already believed the
headline.

**Done when:** the categories question groups by category; "total profit" returns the total
or states its scope in the headline; the customers question answers about customers with a
coverage caveat. **Needs a live run to confirm.**

---

## C4 · Filters that can never match return silence — DONE

**Problem.** `facts` rows with `record_type = 'מלאי'` have **NULL `transaction_date`** —
confirmed exactly: 0 non-null in all 2,772,637 of them — while the rules mandate filtering
to the latest snapshot date. The predicate can never match, so six cases returned zero rows
with no explanation, indistinguishable from "no data for your question".

**Built.** `services/empty-result-diagnosis.service.js`. On a zero-row result it parses the
SQL that actually ran, and tests whether a filtered column is empty **within the subset the
query asked about** — the literal equality predicates (`record_type = 'מלאי'`) define that
subset. Whole-table emptiness would have missed this case entirely: `transaction_date` is
fully populated on sales rows.

It then distinguishes "the column is empty here" from "the subset itself is empty", since
only the first is a broken question. Both surfaces consume it: insights replaces the 422
message, and `table-format.service.js` tells the chat model to report a data gap rather
than "No data found" — one shared formatter, so all seven clients get it at once.

**One performance trap worth recording.** The natural probe,
`EXISTS(SELECT 1 ... LIMIT 1)`, makes the planner expect an immediate hit and choose a
sequential scan; when the answer is "no" that scan runs to completion — **56s over 39M
rows**, measured. `MAX(col)` answers the same question, ignores NULLs and walks the index
backwards: **0.04s**. Where no index helps, the probe's own 5s statement timeout stops it
and no diagnosis is offered.

**Verified so far:** the defect reproduces exactly; controls (a genuine empty result, and
hypertoy) correctly produce no diagnosis. **The rewritten `MAX()` probe still needs one
live re-run** — it was changed after the last DB test.

---

## C5 · Partial periods, and chat/report parity — DONE

**Problem.** Reports handled this well; **chat did not**, and reported a store falling
₪1,306,264 to ₪167,208 (−87%) between May and June without noting June holds four days.

**Built.** `services/period-coverage.service.js` — deterministic, no schema knowledge. It
derives the trailing partial month from `dataThroughDate` and emits
`coverage: { partial, period, expectedEnd, actualEnd, daysCovered, daysExpected, pctCovered, note }`,
but only when the answer actually involves that period (a banner on a 2024 question is
noise, and noise trains people to ignore banners). 11 unit tests, including leap years.

**The deeper fix underneath it.** Chat never passed `dataThroughDate` at all, so relative
expressions anchored to `CURRENT_DATE` — "the last 7 days" searched a week the export does
not contain. Rather than edit seven per-agent crew files, `DataQueryService` now resolves it
itself via a new `services/data-through.service.js` (30-minute cache, single-flight, future
dates excluded). Every client gets both date anchoring and coverage, including the next one
added. `mv-refresh` now imports its fact-table map from that same module, so a new dataset
is registered in exactly one place.

**Done when:** a partial-period comparison is labelled in both surfaces, on any dataset.
**Needs a live run to confirm.**

---

## C6 · Small and low-risk — DONE

- **Timeout-retry discipline.** Retries were already capped at one for timeouts. Added: the
  retry hint now names the schema's **real** pre-aggregated views, read live from
  `pg_matviews` rather than from a per-client string, so it self-adapts and never invents a
  phantom table; plus a wall-clock budget so a retry cannot become a second 75s failure.
- **Regenerated the zolstock data-model description.** The old one told the planner that
  "product/customer/store name dimensions are not yet loaded" — false on every count. The
  replacement describes the three record types, the joinable `items` (303,508) and `stores`
  (139) tables, the customer situation above, and the fact that inventory rows carry no
  date (which is what makes C4's diagnosis necessary).

---

## Proposed-report prompts — review, replace only if clearly better

Current chips: "Main risks for the next few months" · "What are the top 10 items by quantity
sold" · "Which product family has the steepest margin decline".

Assessment against the run: the risks and margin-decline chips produced genuinely valuable,
materiality-filtered findings and should stay. The "top 10 items" chip is the weakest — it
timed out once, and when it worked it was led by the catch-all `פריט כללי`, which is
truthful but not insightful. Replace that one only, and only after C2 makes item queries
fast. Any replacement must be concise, attractive, and answerable from data that exists.

---

## Parked — business decisions, not engineering

**P1 · Which table is authoritative for stock?** Three candidates disagree in structure:
`facts` where `record_type = 'מלאי'` (2.77M rows, no dates) · `inventory` (~125M rows,
`in_stock` flag only) · `recommendation_facts` (29.9M rows, quantities **and** `row_date`).
`recommendation_facts` looks right, but that is inference from column names. Someone who
knows the business must declare it, and say whether `in_stock` is a flag or a quantity.

**P2 · Should catch-all items appear in rankings?** `פריט כללי` ("general item") genuinely
holds 1,018,814 units and ₪15.8M revenue; `פריט מבצע` is second; the seller dimension has
the same pattern (`כללי`). The system reports the truth — the truth is simply not a useful
"top products" answer. Excluding them is a product decision about the item master.

---

## What is blocked on database access

Everything below waits for the sync to finish:

1. **Measure per-view MV refresh cost** (C1), then decide on UNIQUE indexes and enable
   `MV_REFRESH_ENABLED`.
2. **Build C2's two roll-up MVs** — needs explicit go-ahead, it creates schema objects.
3. **Re-verify C4's rewritten `MAX()` probe** against the live inventory case.
4. **Live confirmation of C3 and C5** — both are prompt-and-contract changes whose effect
   only shows in a real run.
5. **Re-run the full 62-case suite** and produce the before/after comparison report.
   Reclassify expectations for R28/C26 per the correction above.

## Verification commands

```bash
node scripts/test-insights-unit.js       # 53 offline assertions, no DB or LLM
node scripts/test-schema-contract.js     # every relation/column named in the rules must exist
node scripts/zolstock-qa-run.js reports 1 32
node scripts/zolstock-qa-run.js chat 1 30
```

After each change: a spot regression on hypertoy plus zer4u, to prove no cross-client impact.

---

## Continuation (added 2026-08-24 at close-out)

This work continued as two further stages, both complete and verified:

- **Stage 2** (`zolstock-and-other-accuracy-improvements-stage-2.md`, closed 21-08) — the
  processing-flow hardening: per-dataset **capability manifest** (truth card), deterministic
  **capability gate** (absent-dimension refusals in ~1ms, pre-SQL), coverage/basis/entity/scope
  **annotations** enforced by an answer contract, ops invariants. Verified by a frozen 74-question
  **real-customer replay corpus**: 74/74 answered, verdicts better 12 / worse 0 vs baseline.
- **Stage 3** (`…-stage-3.md`, closed 24-08) — answer directness ("no data for today" first lines),
  **validated suggestions** (only re-anchored to dates that exist — proven by re-asking them),
  partial-day guard (caught the near-empty 23-08 delivery live), VAT-basis matching, user-figure
  discipline, per-table data-status panel, post-reload MV freshness assertion. Final replay:
  74/74, better 13 / worse 0, money answers 100% basis + 100% data-coverage disclosure.

Root-cause closure on the data side: the client's Qlik runs on the retired transaction export
(May 2026 matches ₪31,270,689 to the shekel) — the standing ask to the client is resuming that
export; see the Qlik evidence artifact referenced in stage-3.
