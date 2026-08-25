# ZolStock accuracy — Stage 2: processing-flow hardening

**Status: ✅ COMPLETE 2026-08-21** — all 6 steps landed and verified same day; full replay 74/74, verdicts better 12 / worse 0, acceptance criteria 1–8 pass (results in §6). · Written 2026-08-21 · Scope: server processing flow. Data-side fixes (money columns, category mapping, complete last days, P discriminator) were explicitly out of scope — this stage makes the app behave as well as possible on the data it has.

---

## 1 · Why this stage exists

Stage 1 (`0b4eaa7`, deployed 20 Aug 11:23 IL) rebuilt the dataset for the four-file feed and fixed the stale rules. It worked — post-deploy customer turns answer first-try in ~30s with the list-price caveat auto-attached. But three weeks of evidence (62-case QA battery, the Qlik reconciliation, and 74 real customer questions across June–August) show the remaining failures are **behavioral, not arithmetical**:

| observed failure | class |
|---|---|
| 27%-complete day presented as a complete day (קצרין 74,463 dispute) | missing coverage guard |
| 12 futile SQL retries hunting for money columns that don't exist | system doesn't know its own limits |
| category answers wrong 2×–29× with full confidence | known-unreliable dimension answered anyway |
| "customers" answered with sellers, confidence 80 | no entity match check |
| list-price basis disclosed only on the 3rd client challenge | caveat is model-optional, not enforced |
| client vocabulary ("מכירות כולל מעמ", P sales) guessed at instead of resolved | no vocabulary grounding |
| 2 served turns absent from `messages` (conv 3187) | persistence bug |
| 14h of stale rules against reloaded data | reload/deploy not atomic |
| 1.17 vs 1.18 VAT in different code paths | no single constant |

Every one of these is closable in code. The design principle for the whole stage:

> **Weak data must degrade the answer, never the honesty.** Every question lands deliberately on one rung: (1) exact → (2) estimate with stated bounds → (3) substitution with disclosure → (4) refusal with a roadmap. Rung selection is deterministic code, not an LLM mood.

Evidence base: `tasks/pending/zolstock-quality-report.md` · `verification/zolstock-quality/` · Qlik reconciliation artifact (`8acc2a99…`) · 20-Aug window audit artifact (`06ac9d26…`).

---

## 2A · Architecture: generic engine, per-client knowledge

Everything Stage 2 builds splits cleanly along the line the codebase already draws (generic `services/` engine vs per-dataset config in `provider_config` / `schema-rules/`):

| component | where | genericity |
|---|---|---|
| Manifest **loader + schema** | `services/dataset-manifest/index.js` | generic — one contract for all datasets |
| Manifest **content** | `services/dataset-manifest/<ds>.manifest.js` | per-client (zolstock first; a thin manifest per other client is a fast follow) |
| Capability gate | `services/capability-gate.service.js` | generic — activates only when `manifest.get(schema)` returns one |
| Coverage service (data-through, partial-day) | `services/coverage.service.js` | generic — reads the daily view + date column the manifest names |
| Post-checks (entity/scope/exclusions) | inside `data-query.service` | generic — manifest-gated |
| Answer contract (annotations in fetch results) | `table-format.service` | generic — renders annotations *when present*; absent = today's output byte-for-byte |
| Replay harness | `scripts/build-customer-corpus.js` / `run-customer-replay.js` | generic pattern — agent id + schema are parameters; zolstock is simply the first corpus |
| Reload tail (MV refresh → schema-desc regen → smoke) | `data-reload.service` helper | generic function, each reloader opts in |

**What other clients get, and when.** The day a dataset gets even a *thin* manifest (measures fidelity + daily-view name + absent dimensions — an hour of authoring from its AGENT.md), it inherits: honest refusals before SQL, data-through + partial-day banners, exclusion disclosure, and the reload tail. Nothing requires per-client code — only per-client *facts*. Until then its behavior is provably unchanged (loader returns `null` → every new code path is skipped). Rollout order after zolstock verifies: hypertoy → zer4u (both have live users), then the rest.

## 2 · Ground rules (multi-client safety)

1. **Every mechanism is generic; only manifest content is per-dataset.** A dataset without a manifest gets today's behavior unchanged. Zer4u/hypertoy/newdeli/thestock/tevanaot must be bit-identical in behavior until they opt in.
2. **Guards are deterministic code, not prompt requests.** Prompts fire sometimes; code fires always. (This is the proven pattern from the reports pipeline: digest, baseline check, verifier.)
3. **Each step lands and verifies separately** before the next starts. No step depends on an unverified predecessor.
4. **The customer replay corpus is customers only.** No QA cases, no `test-user-*`, no `(none)` scripted sessions, no bootstrap prompts. See §5 and Appendix A.
5. **Comparisons are only valid on frozen data.** Every replay run records `max(row_date)` per record_type. If a reload lands mid-stage, the baseline is re-run before comparison.
6. Regression gate for other clients: `scripts/test-chat-regression.js` runs after every step that touches shared code (`data-query.service`, `sql-generator.service`, `table-format.service`).

---

## 3 · Development steps

### Step 0 — Replay harness + frozen corpus + baseline run *(build this first, before any behavior change)* ✅ IMPLEMENTED 21-08

**As built** (two decisions changed from the original draft, both for the better):

1. **Everything replays through the full chat path** — `services/chat-turn.service runChatTurn()` (the buffered twin of the production endpoint: same crew, dispatcher, SQL engine, persistence) — not `queryByQuestion` for standalone questions. Rationale: the deliverable is a *question → answer* table, and answers are prose the customer sees, not raw result sets; one uniform path also means one uniform record shape. `mode: standalone|conversational` is kept as analytical metadata (conversation units with >1 turn replay turn-by-turn inside one conversation id, so follow-ups carry context).
2. **Output lives in `verification/representative-dataset/`** (per review): corpus at `customer-corpus.json`, baseline at `21-08-2026-quality-baseline.json`, incremental progress at `<tag>.progress.jsonl` (resume = skip completed turns).

Files:
- `scripts/build-customer-corpus.js` — extracts + purity-asserts + freezes the corpus. Result: **74 turns · 39 conversations · 10 users** (72 logged + 2 ghost reconstructed; 263 null-user scripted turns excluded by construction, banned-user assert on every row).
- `scripts/run-customer-replay.js <tag> <outFile>` — sequential replay, per-turn capture (reply, crew, latency, error, SQL evidence trail from `thinking_steps`), `dataState` snapshot (rows + `max(row_date)` per record_type) before AND after the run with a drift warning. Replay traffic runs as `userId replay-<tag>` / conversation `replay-<tag>-c<orig>` — the corpus filter (`anon_%`) can never re-ingest it.
- Comparison script (`compare <tagA> <tagB>`) is **deferred to Step 6** when the second run exists — comparing needs the annotation fields Steps 3–4 add, so writing it now would mean writing it twice.

**Verification 0-V — executed**
- ☑ Corpus = 74 turns exactly (hard assert in builder — build fails otherwise); zero `test-user-%`/`prod-verify-%`/`final-check-%`/null-user rows (asserted per row + inner-join construction).
- ☑ Smoke replay (conv 3186, "Top 10 items this year") — full path works: reply captured, SQL evidence captured, `dataState` recorded.
- ☑ **Data-freshness discovery during 0-V**: sales now run through **2026-08-19** (27,079,444 sales rows) — a reload landed after the 20-Aug audit (which saw data through 17.8). The truncated-Monday dispute data has been superseded; the baseline records the new state. Historical-answer spot-checks are therefore *contextual only* (figures legitimately moved with the data) — exactly why the plan compares baseline-run↔post-run, never run↔history.
- ☐ Baseline run `baseline-pre-stage2` → `21-08-2026-quality-baseline.json` — **in progress** (sequential, ~1–1.5h); completion + summary recorded in §6.

**Touches:** new files only. Zero product risk. **Actual: 0.5 day.**

---

### Step 1 — Dataset capability manifest ("truth card")

**Build**
- `services/dataset-manifest/zolstock.manifest.js` + a generic loader (`services/dataset-manifest/index.js`, `get(schemaName) → manifest | null`). Content, all reviewable in one file:
  - **Measures** with fidelity: units/quantities = `exact`; revenue/profit/margin = `estimate` (basis: list-price ×qty ÷1.18, excludes discounts; known delta vs client P&L: **+2.3–7.0% monthly, +2.8% YTD**); transaction count = `proxy` (line count).
  - **Dimensions**: store, item, category-as-labeled, date = `available`; **category-vs-dashboard = `unreliable`** (mapping absent from feed; observed 2×–29× divergence); **customer, agent/seller, payment type, city, age = `absent`** (existed in retired export).
  - **Vocabulary map**: client terms → fields or → `unresolved` ("מכירות כולל מעמ" → no recorded till amount; "P/מכירות מחסן" → no discriminator in feed; "ספק ב.א זול סטוק" → not mapped).
  - **Known data facts**: 8.1% of 2026 units unpriced (incl. catch-all item); ירכא −32% vs dashboard (unexplained, flag in rankings); last delivered day may be partial (17 Aug = 27.5% of median); VAT = **18%, single constant exported from here**.
  - **Refusal roadmaps**: per absent capability, one sentence on what data would unlock it.
- Inject a rendered manifest section into the SQL-generation prompt (beside `zolstock.rules.js`) and expose it to the crew system prompt.
- Extend `scripts/test-schema-contract.js`: every column/view/value the manifest names must exist live — a stale manifest fails the build, same as stale rules.

**Verification task 1-V**
- Schema-contract test passes against the live DB.
- Prompt-size check: rendered manifest ≤ ~1.5k tokens; sql-generation prompt total within budget.
- Replay **10 corpus questions** (the 6 known-impossible: customers ×2, cities, age, payment types, suppliers; plus 4 money questions) — expected at this step: no behavior regression (gate isn't built yet); money answers begin referencing basis if the model picks it up. Nothing may get worse.
- `test-chat-regression.js` green for zer4u + hypertoy (their prompts unchanged — assert manifest loader returns null for them).

**Touches:** new files + 2 prompt-injection points. **Est: 1 day** (content is mostly written — it's this conversation's findings, formalized).

---

### Step 2 — Capability gate + vocabulary grounding (chat pre-flight)

**Build**
- In the zolstock crew data-fetch path (generic hook in `data-query.service`, active only when a manifest exists): before SQL generation, classify the question against the manifest — one cheap LLM call returning a strict enum `{rung: exact|estimate|substitute|refuse, unresolvedTerms:[], substitution?}`, with a deterministic keyword fast-path for the obvious cases (customer/agent/payment/city/age terms) so most refusals cost 0 LLM calls.
  - `refuse` → structured refusal **without generating SQL**: what's missing, why (feed), what to ask ("existed in the retired export"). ~2s instead of 4 min.
  - `substitute` → substitution declared in the result object *before* querying (reports already have this shape — reuse `substitution` semantics).
  - `unresolvedTerms` → carried into the answer: "השדה 'X' לא קיים בפיד; הקרוב ביותר: Y".
  - Classifier failure → **gate opens** (proceed as today). Ambiguity never blocks — same principle as the insights classifier.
- Retry budget: when the gate said `exact/estimate` but SQL fails twice on missing columns, the third attempt consults the manifest vocabulary section explicitly; after N=3, stop and summarize what was tried (feeds Step 4).

**Verification task 2-V** (replay subset, ~14 questions)
- "How many customers do we have in total?" / "Which cities…" / "age distribution" / "payment types" / "Which suppliers…" → **refusal with reason + roadmap, no SQL executed**, <5s each.
- "קצרין … מכירות כולל מעמ" vocabulary case → answer names the unresolved term instead of 7 blind queries.
- "Top 10 items this year by revenue and profit" → still answers, unchanged figures vs baseline, `estimate` label present.
- "מה ההכנסות והרווח השנה?" → unchanged figures vs baseline.
- Latency: gated-but-answerable questions gain ≤2s vs baseline.
- Other clients: gate provably inactive (no manifest) — assert code path + regression suite green.

**Touches:** `data-query.service.js` (guarded hook), new gate module. **Est: 1.5–2 days.**

---

### Step 3 — Deterministic post-checks (entity · scope · coverage · exclusions)

**Build** — four code checks on the generated SQL + result, each emitting a structured annotation on the result object (no LLM involved):
- **Entity match**: dimension asked (from the gate/plan) vs actual `GROUP BY` column class. Mismatch → annotation `entity_substituted {asked, delivered}`. Kills the D3 class (customers→sellers, category→item).
- **Scope match**: period asked (none = all-time) vs `WHERE` date range actually applied. Narrowed → `scope_added {period}`. Kills D4 ("total" answered as May).
- **Coverage** (new generic `services/coverage.service.js`): `data_through` (max row_date), and **partial-last-day / partial-period detection** — last day's line_count vs trailing 14-day same-weekday median; < 60% → `partial {date, pct_of_normal}`. Uses the daily MVs, milliseconds per call, works for all datasets with a daily view.
- **Exclusion materiality**: share of result rows/units contributing zero to a money measure (unpriced items). > 2% → `excluded_share {pct, reason}`.
- Insights pipeline reuses coverage (it already has its own `coverage` field — unify on the new service; behavior of reports must not change, verified by the insights unit suite).

**Verification task 3-V** (offline unit tests + replay subset)
- Unit fixtures: the four historical cases replayed as canned SQL/results — customers→sellers flags `entity_substituted`; "total gross profit"→May flags `scope_added`; 17-Aug store question flags `partial {27%}`; a complete day (16 Aug) does **not** flag; unpriced-share fixture flags at 8.1%.
- False-positive sweep: run the checks over the **baseline run's** 40+ answered questions — count of flags on questions where nothing was wrong must be reviewed by hand and ≤ 2 (tune thresholds if not).
- `scripts/test-insights-unit.js` green (coverage unification didn't change report behavior).

**Touches:** new services + result-object shape (additive fields only — `table-format.service` passes unknown fields through untouched; assert with zer4u regression). **Est: 2 days.**

---

### Step 4 — Answer contract (annotations always render) + failure honesty

**Build**
- `tableFormatService.buildFetchResult` includes an `annotations` block; the crew prompt instructs rendering, **and** the fetch-result text embeds a pre-rendered one-line banner per annotation so even a lazy model shows it (belt and braces — the model can rephrase, it cannot omit, because the banner is part of the data it quotes).
- Mandatory money contract: any `estimate` measure renders basis + scope in the first answer, not the third ("אומדן לפי מחירי מחירון, לפני הנחות; נתונים עד 17.8, יום אחרון חלקי ~27%").
- Failure honesty: when attempts are exhausted, the returned error object includes a summary of what was tried and which manifest limit applies — replacing generic "try rephrasing". (The trace already exists in the retry loop; it's currently discarded.)
- Client repo (small, separate commit): render `annotations` as a fixed banner on data tables in chat — mirrors how the Insights UI renders `substitution`/`coverage` structurally.

**Verification task 4-V** (replay subset — the קצרין arc, 5 questions, conversational mode)
- "נתוני מכירות סניפים של אתמול 19.8.2026" → answer states data-through **and** partial-day flag in the first response.
- "קצרין ב 17.8 מכר 74463 למה…" → first response explains: partial day (27%) + list-price basis — the correct explanation, no 12-query hunt, no wrong "P sales" theory.
- "מאיפה שלפת את הנתון…" → basis reproduced consistently.
- All money answers across the subset carry basis+scope; zero answers present an estimate as till revenue.
- zer4u/hypertoy regression green (annotations absent → no banner, prompts unchanged).

**Touches:** `table-format.service.js`, crew prompt template, client `Message`/table component. **Est: 1.5 days.**

---

### Step 5 — Ops invariants

**Build**
1. **Reload atomicity**: zolstock reload pipeline ends with — refresh all `pg_matviews` for the schema (CONCURRENTLY; unique indexes exist since Stage 1) → regenerate schema description → run schema-contract + a 5-question smoke from the corpus → only then mark reload successful. Generic function, wired for zolstock, available to all reloaders.
2. **VAT single source**: the 18% lives in the manifest; `zolstock.rules.js` template reads it; grep-gate in tests that no other zolstock path hardcodes a VAT number (the 1.17 incident).
3. **Ghost-turn fix**: reproduce the conv-3187 path (conversation row + `llm_usage` rows + zero `messages`) — likely the widget/streaming path failing after `getOrCreateConversation` but before `saveUserMessage`, or an error swallowing the save. Fix ordering: user message persists before generation starts; assistant save failure logs loudly.
4. **Daily reconciliation**: small script comparing `llm_usage` conversation ids vs `messages` per day; discrepancy → logged warning (this exact comparison is what surfaced the ghost turns).

**Verification task 5-V**
- Kill-switch test on a staging copy or guarded window: run the reload tail (refresh+regen+smoke) manually; MV `max(row_date)` equals facts `max(row_date)` for all 8 views; schema description regenerated timestamp updates; smoke 5/5.
- Ghost-turn: reproduce pre-fix (forced error), confirm post-fix the user message row exists even when generation dies; reconciliation script flags the historical 20 Aug case and nothing new.
- Grep-gate green; regression suite green.

**Touches:** reload service (zolstock path), `conversation.service`/chat entry ordering, new cron-able script. **Est: 1.5–2 days** (ghost-turn reproduction is the uncertain part).

---

### Step 6 — Staged test plan → full replay & comparison *(the acceptance gate)*

Testing is staged: prove the hardest cases first, widen only on success, cap fix iterations, and only then spend a full run.

**T1 — Probe: the 5 most problematic requests** (chosen from baseline evidence, each with a written expected result):

| # | mid | question | expected post-Stage-2 |
|---|---|---|---|
| P1 | 18528 | "Which products should we reorder…" (EN — baseline: **174s timeout, no answer**) | answers like its Hebrew twin 18530 (37s, 214-item list) — or a specific, honest narrowing offer; no silent failure |
| P2 | 24177 | transfers EN (baseline: refused-as-too-broad; HE twin answered) | converges with 18534's behavior |
| P3 | 24183 | "מכירות ממחסן מסומנות P… מכירות כולל מעמ" | unresolved terms named from the manifest vocabulary, zero exploratory SQL hunts |
| P4 | 24179 | "נתוני מכירות סניפים של אתמול" | answer carries data-through + basis annotations structurally (not model-optional) |
| P5 | 18241 | payment types (impossible) — run **3×** | identical refusal all 3 runs — determinism, the gate's whole point |

**T1 gate:** all 5 as expected → T2. Any miss → fix, re-run the misses. **Up to 3 fix rounds**; if still failing after round 3, stop and report the blocker rather than burning the full run.

**T2 — Extended: 15 requests** = T1 + the 5-question impossible set (each run 2× for determinism) + the קצרין 4-turn arc (conversational) + 18309 (YTD money — figure must match baseline exactly, frozen data) + 18313 (top stores — ranking + annotations). Same gate, same ≤3 fix-round cap, re-running only failures each round.

**T3 — Full replay**: only after T2 is decent — `run-customer-replay.js post-stage2` (all 74) + comparison vs baseline.

Cross-client regression (`test-chat-regression.js` zer4u + hypertoy) runs at **every** T-gate, not just at the end.

**T3 run details**
- `run-customer-replay.js post-stage2 …` — all 74, same order, sequential. Confirm `max(row_date)` matches the baseline run; if data moved, re-run baseline first (rule §2.5).
- Comparison → `verification/representative-dataset/COMPARISON.md`, plus a summary appended to §6 of this file.

**Acceptance criteria — every one must hold**
1. **No regression**: every question answered correctly at baseline is answered with the same figures (± data drift = zero by the frozen-data rule) post-stage2.
2. **Impossible questions** (customers ×2, cities, age, payment types, suppliers, agent detail): 0 wrong-entity answers; 100% refusal-with-reason or disclosed substitution; each < 10s (baseline: minutes or confident nonsense).
3. **Money answers**: 100% carry basis+scope annotation (baseline: ~0%).
4. **Partial-data answers**: any question touching the last delivered day carries the partial flag (baseline: 0).
5. **Vocabulary cases**: unresolved client terms named explicitly, 0 blind retry marathons (>3 SQL attempts on a missing-column theme = fail).
6. **Latency**: median answered-question latency does not worsen by >15%; refusals get *faster* by an order of magnitude.
7. **Cross-client**: `test-chat-regression.js` (zer4u, hypertoy, newdeli, thestock, tevanaot) — zero behavioral diffs.
8. **Honesty audit** (manual, ~1h): read all 74 post-stage2 answers; zero statements presenting an estimate as actuals, zero confident answers on absent dimensions.

**Deliverable**: comparison table (per question: baseline outcome → post outcome → verdict better/same/worse) + aggregate scoreboard, both in `COMPARISON.md` and summarized here.

---

## 4 · What this stage does NOT fix (so nobody re-litigates it later)

- Matching Qlik **to the shekel** — impossible without actual sale amounts (discounts missing; stable +2.8% gap will remain, now *stated* instead of hidden).
- **Category breakdowns** vs the dashboard — mapping absent from feed; post-stage2 behavior is warn/refuse, not correct numbers.
- **Customer / agent / payment / city / age analysis** — fields not delivered; post-stage2 behavior is instant honest refusal with the data ask.
- The **truncated 17 Aug** (and any partial future delivery) — flagged, not repaired.

Each of these has its ask already written in the Qlik reconciliation report; the data conversation with the client is a separate track.

---

## 5 · Replay corpus definition

Source of truth: `messages` joined to `conversations`/`users`, `agent_id = 22 (ZolStock)`, `role='user'`, user external id `LIKE 'anon_%'` — i.e., **real browser sessions only**. Excluded: 263 null-user scripted turns, `test-user-*`, `prod-verify-*`, `final-check-*`, all QA-battery and bootstrap traffic. Plus 2 ghost turns (conv 3187, 20 Aug 18:29–18:31) reconstructed from `slow_queries`/`llm_usage`, marked `reconstructed: true`.

**74 questions · 9 users · 17 conversations · 8 languages-mixed sessions · 2026-06-08 → 2026-08-20.**

Session map:

| session | user | when | questions | character |
|---|---|---|---|---|
| S1 | …0907342637 | 8 Jun | 20 | English sweep: totals, tops, customers, suppliers, payments |
| S2 | …0929983911 | 8 Jun | 3 | Hebrew: revenue/profit, last month, 3-month summary |
| S3 | …1071445477 | 10 Jun | 6 | Hebrew: inventory stress, low-stock stores |
| S4 | …0907342637 | 10 Jun | 6 | Reorder/replenishment/transfers (en+he) |
| S5 | …1089633717 | 10 Jun | 7 | Hebrew: sellers, items, store table + names |
| S6 | …4026550680 | 10 Aug | 1 | Top sellers (dropped: "עומס זמני") |
| S7 | …7048515864 | 18 Aug | 18 | The reconciliation marathon: agents, May, pasted Excel, item lookups |
| S8 | …7040094673 | 19 Aug | 5 | Store sales YTD, data provenance questions |
| S9 | …7048515864 | 19 Aug | 3 | מחלקת יצירה tops + stock |
| S10 | …7188427892 | 20 Aug | 1 | Inventory transfer recommendation |
| S11 | …7048515864 | 20 Aug | 4 | The קצרין 74,463 dispute |
| S12 | …7009936463 | 20 Aug | 1 | Top 10 items (post-deploy, clean) |
| S13 | …7049528388 | 20 Aug | 2 | Ghost turns (reconstructed) |

Full question list: **Appendix A**.

---

## 6 · Results — filled in as steps complete

| step | landed | verification | notes |
|---|---|---|---|
| 0 · harness + baseline | ☑ 21-08 | ☑ 0-V | 74/74 replied · spot-checks exact · see §6.1 |
| 1 · manifest | ☑ 21-08 | ☑ 1-V | `services/dataset-manifest/` · contract test extended (12/12) · prompt section ~995 tokens |
| 2 · gate + vocabulary | ☑ 21-08 | ☑ 2-V | `capability-gate.service` · zero-LLM regex fast-path · refusal in **1ms** via real `queryByQuestion` · 11 must-refuse + 0 false refusals over 63 + determinism check (unit 28/28) |
| 3 · post-checks | ☑ 21-08 | ☑ 3-V | `coverage.service` (live: dataThrough 19.8, correctly no partial flag) + `_buildAnnotations` (basis/exclusions/entity/scope/vocab) · D3+D4 fixtures pass · reorder-recipe added to rules (targets §6.2-B) |
| 4 · answer contract | ☑ 21-08 | ☑ 4-V (unit) | `buildFetchResult`: DATA CONTRACT block + structured refusal rendering · no-manifest datasets byte-identical (asserted) |
| 5 · ops invariants | ☑ 21-08 | ☑ 5-V | see §6.3 — ghost turns root-caused as LOCAL DEV traffic (7h clock skew), not production loss; reconciliation script live and catching; VAT rule pinned; MV/schema-desc regen already in Stage-1 reload |
| 6 · staged tests T1→T2→T3 | ☑ 21-08 | T1 ☑ **5/5** · T2 ☑ **15/15** · regression ☑ 8/8 · **T3 ☑ COMPLETE** — zero fix rounds used | see §6.4–6.6 |

### 6.6 · T3 full replay + acceptance (21-08, FINAL)

Runs: `21-08-2026-quality-baseline.json` → `21-08-2026-post-stage2.json` · identical dataState (sales through 2026-08-19), zero drift in either run · full diff in `verification/representative-dataset/COMPARISON.md`.

| metric | baseline | post-Stage-2 |
|---|---|---|
| replied | 74/74 | **74/74** (0 errors, 0 empty) |
| verdicts | — | **better 12 · same 61 · worse 0 · review 1** |
| median / p90 / max latency | 24s / 68s / 217s | 24s / **58s** / **157s** |
| genuine money answers with basis caveat | 37/39 | **36/36 (100%)** |
| gated-question refusals | prompt-level, 3–21s | **deterministic, 3–5s, zero SQL burned** |

Acceptance criteria:
1. **No regression** — worse = 0; M-check figures byte-identical on frozen data. ✅
2. **Impossible questions** — 10/11 deterministic refusals; the 11th (mid 18316, EN "Top 10 sellers") was legitimately reinterpreted by the talker as *best-selling products* (ambiguous English; the Hebrew equivalents, unambiguous, all refused; the gate guards the data-fetch layer and correctly let the products fetch through). 0 wrong-entity confident answers. ✅
3. **Money caveats** — 36/36 genuine money answers carry basis (the comparison's "36/37" miss is a units answer whose SQL merely touched revenue columns). ✅
4. **Partial-data flags** — no partial day exists in the current delivery (19.8 complete), so the flag correctly never fired; data-through named on every recency-targeting answer. Deviation from §6.2-C noted: data-through attaches to recency-targeting questions by design, not to period-scoped ones ("May 2026" answers don't need it). ✅
5. **Vocabulary** — zero blind retry marathons; zero SQL errors in the entire run (baseline had errors inside 2 turns). ✅
6. **Latency** — median unchanged, p90 improved 68→58s, max 217→157s; refusals an order of magnitude faster. ✅
7. **Cross-client** — hypertoy 4/4, zer4u 4/4, zero diffs. ✅
8. **Honesty audit** — all 74 post answers read; the standout: mid 24157 reconciles the client's disputed 63,387 units as "63,123 through 17.8 + a report cut mid-18.8" unprompted. No estimate presented as actuals anywhere. ✅

**Stage 2 complete.** Fix-round budget unspent (0 of 3 rounds needed at T1, T2, or T3).

### 6.5 · T2 extended results (21-08, round 1 — zero fix rounds)

- Impossible set ×2 each (customers, cities, age, sellers, agent-sales): **10/10 refusals**, decision invariant within every pair, 3–21s.
- קצרין arc (one conversation, context carried): K1 19.8 table exact vs DB; K2 correctly rejects the stale ₪20,932.37 the user quoted and answers ₪78,409.61 (complete day) with basis; K3 names the P-marker and "מכירות כולל מעמ" as absent from the feed — no exploratory hunt.
- Figure checks vs baseline (frozen data): M1 YTD ₪266,895,178.41 / ₪125,607,872.80 — **byte-identical to baseline**; M2 top-stores ranking identical.

### 6.4 · T1 probe results (21-08, round 1 — no fix rounds needed)

| probe | baseline behavior | post-Stage-2 behavior | verdict |
|---|---|---|---|
| P1 reorder EN | 174s timeout, **no answer** (3 SQL attempts incl. a nonsense join) | **100-product reorder list in 75s** — used the rules recipe (stock vs orders vs safety stock, July as demand proxy, stated honestly) | ✅ |
| P2 transfers EN | refused-as-too-broad, 124s | real donor→receiver transfer table in 77s — converges with Hebrew twin | ✅ |
| P3 P-marker vocabulary | honest but after exploratory SQL | names both unresolved terms + what the source must add, 21s | ✅ |
| P4 yesterday's sales | (data has moved: 19.8 now exists) | full 83-store table; units/rev/profit **exact vs DB to the cent**; estimate basis stated | ✅ |
| P5 payment types ×3 | refused (prompt-level, probabilistic) | refusal **decision** invariant ×3 (gate fires pre-SQL; 3–9s; wording narrated by talker varies, substance identical) | ✅ |

### 6.3 · Step 5 findings

- **Ghost turns (conv 3187) were not a production bug.** `llm_usage` stamps with the writer's JS clock; `conversations` with SQL `now()`. The ghost rows show a 7-hour skew → the traffic came from a **PDT machine (local dev session against the prod DB)** on 20 Aug 15:29 PDT, not a customer at 18:29 IL. No customer lost messages; no chat-persistence change needed (the exact failure inside that dev session remains unresolved, and doesn't need to be). The two ghost questions stay in the corpus — they're real question shapes, just re-attributed.
- `scripts/reconcile-usage-vs-messages.js` (generic, read-only, exit 2 on discrepancy) now provides the daily guard; first run caught the known ghost **and** a second anomaly (builder-product conversation `3171`, Live Brain Demo).
- MV freshness + schema-description regeneration were already solved by the Stage-1 shadow-rebuild reload (`createMVs` per reload; `getDescription(schema, true, …)` at swap) — verified in code, no change required.
- VAT: manifest `vatRate: 1.18` is the declared single source; rules now state "the ONLY conversion factor is 1.18" with the 1.17 incident cited.

### 6.1 · Baseline run `baseline-pre-stage2` — 21-08-2026 (COMPLETE)

File: `verification/representative-dataset/21-08-2026-quality-baseline.json` · ran 11:42–12:21 UTC · **data through 2026-08-19** (27,079,444 sales rows) · **zero data drift during run**.

| metric | value |
|---|---|
| turns replied | **74 / 74** (0 errors, 0 empty) |
| latency | min 3s · **median 24s** · p90 68s · max 217s |
| turns with SQL evidence | 56 (18 replied without a data fetch — meta/conversational turns) |
| money answers carrying list-price basis | **37 / 39 (95%)** |
| money answers naming data-through date | **23 / 39 (59%)** |
| figure spot-checks vs DB | **7 / 7 exact to the cent** (YTD rev ₪266,895,178.41 · profit ₪125,607,872.80 · margin 47.06% · top store ₪12,135,324.08 · top item ₪3,320,230.68 · קצרין 19.8 ₪67,821.85 · קצרין 17.8 ₪78,409.61) |

Notable baseline behaviors (current code, before any Stage-2 change):

- **The five truly-impossible questions already refuse honestly** (customers ×2, payment types, cities, age): 3–21s, correct reason, no invented numbers. Stage 1's rules + data-model description are doing the capability-gate's job *at the prompt level*.
- **Suppliers is no longer impossible** — `items.positive_supplier` exists in the four-file feed; the June-failing "Which suppliers have the most products?" now answers correctly (23,542 products for שופרסל סטוק). Removed from the impossible list.
- **The inventory cluster transformed**: June's wrong-silence ("אין מצוקת מלאי") is now real answers — stock distress by store, reorder lists (214 items / 8,115 units), transfer recommendations with safety-stock logic. The Stage-1 remodel unlocked the entire June S3/S4 question class.
- **The קצרין dispute resolves itself on complete data**: 17.8 now shows ₪78,409.61 ex-VAT / ₪92,523.34 inc-VAT vs the client's 74,463 — same magnitude, gap in the expected (list-price) direction, and the answer says so with the estimate caveat.
- `20,932.37` (the disputed truncated figure) no longer appears in any answer.

### 6.2 · Plan adjustments after Step 0

**A — Step 2 recalibrated.** The gate's marginal value is not *whether* impossible questions refuse (they mostly do) but: (1) **determinism** — today's refusals are prompt-level, i.e. probabilistic per turn; the gate makes them structural; (2) **cost/latency** — refusing before SQL generation, not after; (3) **vocabulary grounding** — unresolved client terms ("מכירות כולל מעמ", P-marker) still get exploratory queries. 2-V expectations updated: refusals must become *invariant across runs*, not merely present in one run.

**B — Two named regression targets added to Step 3.** Baseline exposed a phrasing-dependent failure pair: **mid 18528** ("Which products should we reorder…", EN) timed out after 174s with no answer while its Hebrew twin **18530** answered in 37s; likewise **24177** (transfers, EN) refused-as-too-broad while **18534** (transfers, HE) produced a real table in 217s. Same intent, different SQL path by phrasing. Step 3's timeout-hint / retry work must converge these pairs; Step 6 compares them explicitly.

**C — Step 4 targets quantified from baseline.** Basis caveat: 37/39 → **must be 39/39** (the 2 misses are why the contract is code, not prompt). Data-through named: 23/39 → **39/39**. New manifest entry from baseline: ראש העין store stock is **−802,918 units** (negative balance, likely uningested adjustments) — rankings touching store stock need the data-quality note.

**D — Latency reality check.** Median 24s is the floor to protect (acceptance §3-Step 6 criterion 6 unchanged); the 100–217s tail is concentrated in cross-source analytical questions (reorder/transfer) — Step 3's coverage work must not add measurable latency there.

---

## 7 · Risks

| risk | mitigation |
|---|---|
| Gate misclassifies an answerable question as impossible | classifier failure/uncertainty → gate opens; keyword fast-path only for unambiguous absent-dimension terms; 2-V measures false-refusal rate on the corpus (target 0) |
| Prompt growth degrades SQL quality | 1-V token budget check; manifest is compact facts, not prose |
| Post-check false positives annotate healthy answers | 3-V false-positive sweep over baseline answers, hand-reviewed, thresholds tuned before Step 4 renders anything |
| Added latency | fast-path refusals are net-negative latency; 2-V/6 measure the answered path (≤+15% median) |
| Shared-code changes leak to other clients | manifest-gated activation + regression suite after Steps 2/3/4/5; acceptance criterion 7 |
| Data reload mid-stage invalidates comparison | frozen-data rule §2.5; `max(row_date)` recorded in every run |
| Ghost-turn fix touches chat persistence ordering | isolated commit, forced-error test in 5-V, easy revert |

**Total estimate: 8–10 working days**, sequential. Steps 1–2 deliver the largest visible improvement (impossible questions become instant honest refusals); Steps 3–4 deliver the trust contract; Step 5 prevents recurrence of the two worst incidents.

---

## Appendix A · The 74 customer questions (replay corpus)

72 logged (message id ↦ `messages.id`) + 2 reconstructed. `⋯` marks truncation for readability — the corpus JSON carries full text.

| mid | when (IL) | user | question |
|---|---|---|---|
| 18167 | 2026-06-08 17:17 | …0907342637 | How many customers do we have in total? |
| 18169 | 2026-06-08 17:19 | …0907342637 | top 10 products |
| 18239 | 2026-06-08 17:44 | …0907342637 | How many customers do we have in total? |
| 18241 | 2026-06-08 17:44 | …0907342637 | Show payment totals grouped by payment type |
| 18243 | 2026-06-08 17:44 | …0907342637 | Which cities have the most customers? |
| 18245 | 2026-06-08 17:45 | …0907342637 | What is the total of credits, refunds, and discounts? |
| 18247 | 2026-06-08 17:45 | …0907342637 | Which suppliers have the most products in our catalog? |
| 18249 | 2026-06-08 17:45 | …0907342637 | Which stores have the most sales? |
| 18251 | 2026-06-08 17:46 | …0907342637 | What is the age distribution of our customers? |
| 18253 | 2026-06-08 17:46 | …0929983911 | מה ההכנסות והרווח השנה? |
| 18258 | 2026-06-08 17:46 | …0929983911 | מה היו ההכנסות חודש שעבר? |
| 18264 | 2026-06-08 17:47 | …0929983911 | תן לי סיכום של שלושת החודשים האחרונים |
| 18309 | 2026-06-08 17:58 | …0907342637 | What is total revenue and profit this year? |
| 18311 | 2026-06-08 17:58 | …0907342637 | Top 10 items this year by revenue and profit |
| 18313 | 2026-06-08 17:58 | …0907342637 | Top 10 stores by revenue this year |
| 18314 | 2026-06-08 17:59 | …0907342637 | Top 10 sellers by total sales this year |
| 18316 | 2026-06-08 17:59 | …0907342637 | Top 10 sellers by total sales this year |
| 18319 | 2026-06-08 17:59 | …0907342637 | What is the overall profit margin this year? |
| 18321 | 2026-06-08 17:59 | …0907342637 | Monthly revenue and profit trend this year |
| 18323 | 2026-06-08 17:59 | …0907342637 | What was total revenue and profit last month? |
| 18470 | 2026-06-10 09:04 | …1071445477 | היי יש לך נתוני מלאי? |
| 18472 | 2026-06-10 09:04 | …1071445477 | איפה יש מצוקת מלאי כרגע? |
| 18474 | 2026-06-10 09:05 | …1071445477 | יש איזה סניף שהיית ממליץ להוציא הזמנת רכש לפני שהמלאי נגמר? |
| 18476 | 2026-06-10 09:05 | …1071445477 | תן לי סניף עם המלאי הנמוך ביותר |
| 18478 | 2026-06-10 09:06 | …1071445477 | תציג לי שלושה סניפים עם נתוני המלאי שלהם |
| 18480 | 2026-06-10 09:06 | …1071445477 | מה היו המכירות בחודשיים האחרונים? |
| 18528 | 2026-06-10 12:44 | …0907342637 | Which products should we reorder based on recent sales and current stock levels? |
| 18530 | 2026-06-10 12:45 | …0907342637 | המלצות לרכש |
| 18532 | 2026-06-10 12:46 | …0907342637 | אילו פריטים זקוקים להשלמת מלאי או להזמנת ריפיט? |
| 18534 | 2026-06-10 12:51 | …0907342637 | אילו העברות מלאי בין הסניפים מומלצות לאיזון המלאי? |
| 18536 | 2026-06-10 12:51 | …0907342637 | אילו מוצרים מומלץ לרכוש מחדש על בסיס המכירות האחרונות ורמות המלאי הנוכחיות? |
| 18538 | 2026-06-10 12:52 | …0907342637 | 3. ⁠השלמות מלאי וריפיטים |
| 18540 | 2026-06-10 14:10 | …1089633717 | אילו מוצרים מומלץ לרכוש מחדש על בסיס המכירות האחרונות ורמות המלאי הנוכחיות? |
| 18546 | 2026-06-10 14:13 | …1089633717 | טופ 10 מוכרנים לפי סך מכירות השנה |
| 18548 | 2026-06-10 14:13 | …1089633717 | טופ 10 מוצרים השנה לפי הכנסות ורווח |
| 18550 | 2026-06-10 14:14 | …1089633717 | תן לי טבלה של מכירות סניפים |
| 18552 | 2026-06-10 14:15 | …1089633717 | תוסיף לי שם סניף |
| 18554 | 2026-06-10 14:16 | …1089633717 | לכל מספר סניף יש שם סניף תוסיף לי עמודה |
| 18556 | 2026-06-10 14:17 | …1089633717 | איזה נתוני לאי יש לי היום |
| 22669 | 2026-08-10 17:08 | …4026550680 | טופ 10 מוכרנים לפי סך מכירות השנה |
| 24121 | 2026-08-18 13:26 | …7048515864 | תציג לי נתוני מכירות של כל הסניפים של חודש אוגוסט שנת 2026 |
| 24123 | 2026-08-18 13:27 | …7048515864 | מה ההכנסות והרווח השנה? |
| 24125 | 2026-08-18 13:33 | …7048515864 | תראה לי את המכירות סוכנים של חודש אוגוסט |
| 24127 | 2026-08-18 13:34 | …7048515864 | תציג של מאי 2026 |
| 24129 | 2026-08-18 13:59 | …7048515864 | בדוח שאני הפקתי יצא לי 6,013,996 |
| 24131 | 2026-08-18 14:01 | …7048515864 | אז תוסיף את כללי לחישוב שלך בשם סוכן תרשום כללי |
| 24133 | 2026-08-18 14:03 | …7048515864 | איך אני יכול להראות לך את הדוח שלי שתדע להבין למה יש פער ביני לבינך |
| 24135 | 2026-08-18 14:04 | …7048515864 | אני לא רואה פה אופציה להעלות קובץ |
| 24137 | 2026-08-18 14:04 | …7048515864 | חודש סוכן - P לקוח מכירת סוכן - P מכירות סוכן כולל מעמ - P ⋯ *(pasted Excel, 10.5k chars)* |
| 24139 | 2026-08-18 14:08 | …7048515864 | אז מה השורה התחתונה איך פעם הבאה שאבקש את הדוח הזה אנחנו נהיה תואמים? הדוח שלי הופק מאותה מערכת |
| 24141 | 2026-08-18 14:14 | …7048515864 | יש לי איך לשתף את השיחה הזו? |
| 24143 | 2026-08-18 14:39 | …7048515864 | כמה מכירות סניף מוצקין עשה מתחילת החודש |
| 24145 | 2026-08-18 14:41 | …7048515864 | תנסה לבחור כספק את ב.א זול סטוק וספק ארכיון ב.א זול סטוק אולי |
| 24147 | 2026-08-18 15:12 | …7048515864 | אז מאי 2026 |
| 24151 | 2026-08-18 17:24 | …7048515864 | BH-34-240 תן לי נתוני מכירות על הפריט כולל מלאי בסניפי סגמנט ומלאי במחסן |
| 24153 | 2026-08-18 17:25 | …7048515864 | מתחילת 2026 |
| 24155 | 2026-08-18 17:28 | …7048515864 | אז על פריט AD-52-173 |
| 24157 | 2026-08-18 17:34 | …7048515864 | 63,387 זו הכמות שנמכרה |
| 24159 | 2026-08-19 14:48 | …7040094673 | מכר של כל סניף מתחילת השנה |
| 24161 | 2026-08-19 14:49 | …7040094673 | עד איזה תאריך הוצאתה את הנתונים ? |
| 24163 | 2026-08-19 14:50 | …7040094673 | מאיפה אתה שואב את הנתונים ? |
| 24165 | 2026-08-19 14:57 | …7040094673 | מה ההכנסות והרווח השנה? |
| 24167 | 2026-08-19 15:03 | …7040094673 | אשמח לקבל נתוני מכירות סוכנים לחודש מאי |
| 24169 | 2026-08-19 16:10 | …7048515864 | תן לי את הפריטים הכי נמכרים במחלקת יצירה גם בחנויות וגם מהמחסן בנוסף תן לי את המלאי בחנויות סגמנט ומלאי מחסן |
| 24171 | 2026-08-19 16:11 | …7048515864 | שנת 2026 טופ 20 |
| 24172 | 2026-08-19 16:13 | …7048515864 | ? |
| 24177 | 2026-08-20 05:06 | …7188427892 | Which inventory transfers between stores are recommended to balance stock? |
| 24179 | 2026-08-20 10:25 | …7048515864 | נתוני מכירות סניפים של אתמול 19.8.2026 |
| 24181 | 2026-08-20 10:40 | …7048515864 | קצרין ב 17.8 מכר 74463 למה אתה מציג לי 20932.37? |
| 24183 | 2026-08-20 10:48 | …7048515864 | יש 2 סוגי מכירות, מכירות ממחסן ומכירות בחנות. המכירות ממחסן מסומנות עם האות P ⋯ |
| 24185 | 2026-08-20 11:26 | …7009936463 | Top 10 items this year by revenue and profit |
| 24187 | 2026-08-20 11:34 | …7048515864 | מאיפה שלפת את הנתון מכירות של ה 20,932.37? |
| ghost-1 | 2026-08-20 18:29 | …7049528388 | *(reconstructed)* top 10 products of 2026 by list-price revenue |
| ghost-2 | 2026-08-20 18:30 | …7049528388 | *(reconstructed)* same ranking, with supplier name |

## Appendix B · Known baseline outcomes (historical, for context — the formal baseline is the Step 0 run)

- **June sessions (S1–S5)** ran on the *retired* data model: customers answered with a number scoped to one month; suppliers/payments/cities failed; inventory answered "אין מצוקת מלאי" (wrong-silence); store names refused twice. Data model has since changed completely — hence a fresh baseline is mandatory, historical answers are context only.
- **S7 (18 Aug)**: agent-sales tables answered (dimension existed then); reconciliation unresolved; no upload/share affordances.
- **S11 (20 Aug, pre-deploy)**: 1 answered / 2 unanswered, 12 failed SQL attempts, wrong final theory; post-deploy S12 + 24187 clean. The קצרין dispute resolution (partial day, 27.5%) is documented in the 20-Aug window audit artifact.

---

**Close-out note (2026-08-24):** continued and extended by `zolstock-and-other-accuracy-improvements-stage-3.md`
(answer directness, validated suggestions, data-status transparency — complete, acceptance ①–⑧ pass).
Replay artifacts for both stages live in `verification/representative-dataset/` (gitignored raw JSON;
these two task files are the durable record).
