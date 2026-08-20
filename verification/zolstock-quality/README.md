# ZolStock quality — post-rebuild verification

**Run:** 2026-08-19 · **Dataset:** `zolstock`, rebuilt for the four-file delivery
**Cases:** 35 investigations + 30 chat questions · **Raw results:** `reports-1-35.json`, `chat-1-30.json`, `reports-28-35.json`

## Reproduce

```bash
node scripts/zolstock-qa-run.js reports 1 35    # investigations (~42 min)
node scripts/zolstock-qa-run.js chat 1 30       # chat questions (~5 min)
node scripts/test-schema-contract.js            # every relation named in the rules must exist
node scripts/test-insights-unit.js              # 53 offline assertions
node scripts/test-chat-regression.js hypertoy   # cross-client regression
node scripts/test-chat-regression.js zer4u
```

## What changed underneath this run

The client cut the feed to four files (`Fact`, `Items`, `Stores`, `Calander`) and
retired `Facts_ZolStock_CSV.csv` (plural, 7.8GB) and `Inventory_ZolStock_CSV.csv`.
**The retired plural file was the only source of actual money** — line totals, cost of
sales, discounts, campaigns, sellers, invoices, retail customers and store targets all
went with it.

So results here are **not comparable to the 2026-08-17 baseline**: that measured a
different dataset. This run is a new baseline. The true before/after for the C1–C6 work
is the hypertoy and zer4u regression, whose data did not change.

## Headline results

| | Reports (35) | Chat (30) |
|---|---|---|
| Completed without error | **35 / 35** | **29 / 30** first pass, **30 / 30** after fix |
| Median latency | 53.7s | 5.2s |
| Max latency | 135.8s | 23.9s |
| Language mirrored correctly | 31 / 32 scoreable | — |
| Fact-check (VERIFY) satisfied | 30 / 35 | — |

The 5 unsatisfied fact-checks are **not silent failures** — each is capped at confidence
40, which is the mechanism working. The VERIFY step was observed rejecting a synthesis
mid-run for arithmetic that did not add up ("claims 389,133 units, actual sum ~407,054")
and regenerating.

## Figures verified by hand against the database

| Claim | Independent check | Verdict |
|---|---|---|
| Total units 69.1M | 69,081,704 | exact |
| Monthly units, all 20 months | matched CSV month by month | exact |
| Catalogue 298,555 items | CSV distinct `item_number` | exact |
| R02 פריט כללי 4,010,932 units, 38% of top-10 | 4,010,932, 38.2% | exact |
| R13 / C29 revenue ₪659M | 659,487,569 | exact |
| R09 ק.מוצקין 2.79M units | 2,793,006 | exact |
| R01 subcategory decline 535,950 units | 541,922 across 87 decliners | 1.1% low — materiality filter drops sub-0.5% contributors |
| R01 lead decliner חד פעמי ומתכלים | 257,226 units | exact |

## Defects found by this run, and fixed

1. **Silent substitution in chat.** "Top 10 sales staff by revenue" returned *daily
   revenue rows* — right arithmetic, wrong subject, no signal. Fixed with a generic
   anti-substitution rule in the shared SQL prompt: the model must now name the missing
   thing and emit an explanatory row rather than measure a neighbour. Verified on three
   cases including Hebrew. **Applies to all six datasets.**
2. **NULLs sort first on DESC.** "Top 10 by warehouse stock value" led with empty rows,
   because 99 of 5,015 SKUs have no item-master cost and Postgres sorts NULLs first.
   Generic `NULLS LAST` guidance added; visible in hypertoy's regenerated SQL.
3. **Undocumented view columns.** `mv_warehouse_inventory` exposes
   `stock_value_at_cost_ex_vat`, not `cost_ex_vat`; the rules listed views without their
   columns, so generated SQL referenced a column that does not exist.

## Defects in the harness itself, and fixed

Both produced **false readings about a system that was working**, which is worse than a
missing test — a wrong measurement gets believed.

1. **Departure fields were never captured.** The suite reported "0 declared departures"
   while every one had in fact been set. `zolstock-qa-run.js` recorded `dataQuestion` and
   `sql` but not `substitution` / `scopeAdded` / `coverage`. Confirmed by inspecting the
   live insight object, then fixed.
2. **Language check counted characters, not prose.** It failed any English answer
   containing a Hebrew entity name — but entity names come from the data and must never
   be translated, so "כלי בית leads with ₪71.6M profit" is a *correct* English headline.
   It reported 13 mismatches; re-scoring by comparing Hebrew-to-Latin letter counts gives
   **1 real mismatch** (R22, a Hebrew prompt answered in English).

## C3 / C4 / C5 confirmed live on the new model

| Case | Behaviour | Confidence |
|---|---|---|
| R28 "which sales staff sell the most" | `substitution: sales staff → store` | 55 |
| R29 "revenue lost to discounts" | `substitution: discounts → total list-price revenue` | 30 |
| R30 "which retail customers buy most" | `substitution: retail customers → items` | 55 |
| R31 (Hebrew) "commission per salesperson" | `substitution: commission → gross profit per store` | 40 |
| R33 "how did stock change over 3 months" | `substitution: change over 3 months → current stock level` | 55 |
| R34 "this month vs last month" | `scopeAdded: August 2026 month-to-date` | 40 |
| R35 (Hebrew) "sales today" | `scopeAdded: single day 2026-08-17` | 50 |
| R32 "total revenue and gross profit" | `coverage: partial, 17 of 31 days` | 50 |

**C4** (all-NULL filter): a date filter on dateless warehouse rows is diagnosed as
`zolstock.facts."row_date" empty where record_type = 'warehouse_inventory'` in **0.20s**
— against 56s before the probe was changed from `EXISTS(... LIMIT 1)` to `MAX()`, which
lets the planner use an index instead of a sequential scan. Both controls stay silent.

**C5** (partial period): chat now resolves `dataThroughDate = 2026-08-17` and anchors SQL
to it instead of `CURRENT_DATE`, emitting `partial: true, daysCovered: 17`.

**C2** (item timeouts) is resolved as a by-product of the rebuild: item questions that
took **over 120s standalone and 566s in a report** now answer in **3.8–5.1s**, because
`mv_sales_item_total` replaced the 8.2M-row daily-by-item grain.

## Cross-client regression

| Dataset | Result |
|---|---|
| hypertoy | 4/4 pass, 0 errors, 0 empty |
| zer4u | 4/4 pass, 0 errors, 0 empty |
| schema contract | 9/9 across all six datasets |
| offline unit suite | 53/53 |

## Known and accepted

- **`פריט כללי` ("general item") is the top seller** at 4,010,932 units, 38% of the
  top-10. Genuinely true and genuinely unhelpful — a catch-all SKU. Now more visible than
  before because its list revenue shows ₪0 (no price on the catch-all), so it reads as a
  placeholder. Excluding it is a business decision about the item master (parked, P2).
- **Money is list-price.** Every revenue and margin figure is qty × consumer price ex-VAT,
  excluding discounts and promotions. Column names carry the caveat
  (`revenue_list_ex_vat`) and the write-ups state it.
- **2,549,776 store-inventory rows (85%) carry no item key and no date.** Loaded for
  audit, excluded from `mv_store_inventory`. Item-level stock covers the 433,424 rows
  that can be attributed.
- **R22** answered a Hebrew prompt in English — the one real language failure in 32.

---

## Follow-up round — fact-check handling and planner date bounds (2026-08-19, later)

Three changes after the main run, driven by what it found.

**A · The unresolved fact-check is now visible.** The verifier's specific objections
were already captured in `evidence.verification.issues` but nothing rendered them —
only the capped confidence hinted at a problem. They now show as a banner above the
finding, in the same pattern as the substitution and partial-period banners.

**B · Two regeneration attempts instead of one.** 5 of 35 reports still failed the
fact-check after a single retry, and three shipped a genuinely wrong headline figure.
Each attempt is fed the *current* complaint rather than the original, because the second
rejection is usually about a different number.

| Case | Before | After |
|---|---|---|
| R15 | "−0.5% YoY" — wrong by ~9x | **"−4.5%, ~1.13M units"**, verified (matches CSV: 24,990,328 → 23,858,591) |
| R14 | "47–49% supplier margins" — wrong | reframed to profit share, verified, conf 80 |
| R23 | wrong monthly average | factual range, verified, conf 82 |
| R01 | failed | verified |
| R04 | failed | verified |
| R02 | verified, conf 88 | **regressed to failed** |

Net 2 → 5 verified across the six. R02 moved the other way: synthesis prose is not
temperature-0, so report content varies run to run and **a single re-run is not a
rigorous measurement of B**.

**C · PLAN now receives both ends of the data.** The zer4u chip "steepest revenue
decline" planned July 2026 against July 2025 — but `zer4u.sales` begins 2026-03-01, so
the comparison period does not exist. Zero rows came back and surfaced as "data not
available", when the fault was the question. PLAN was told where data ENDS but never
where it BEGINS.

The lower bound is deliberately not a plain `MIN()`: every dataset has a stray-row tail
that drags it backwards, and one junk row put zolstock's start at **1988-01-01**. The
bound is taken from the ANALYZE histogram (a catalog read, and outliers are almost never
in the sample), but only accepted after a counted check that the rows it would discard
are under 0.05% of the table — the histogram alone over-corrects.

| Dataset | Plain MIN | Corrected | Rows discarded |
|---|---|---|---|
| zolstock | 1988-01-01 | 2025-01-01 | 45 of 26,918,153 |
| hypertoy | 2025-01-01 | 2025-06-04 | 16 of 2,188,599 |
| thestock | 2023-01-01 | 2023-10-26 | 88 of 39,129,358 |
| zer4u | 2026-03-01 | unchanged | — |
| newdeli | 2023-05-17 | unchanged | — |
| tevanaot | none | none (no date column — omits the bound) | — |

### Regression across three clients, after all three changes

| Client | Result |
|---|---|
| zer4u chips | **3/3 verified, 0 errors** (was 2/3 + 1 error) |
| hypertoy full suite | **7/7 verified, 0 errors** |
| zolstock | 5 of 6 previously-failing cases now verified |
| schema contract | 9/9 |
| offline unit suite | 53/53 |
| client typecheck | clean |
