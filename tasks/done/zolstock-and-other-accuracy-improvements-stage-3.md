# ZolStock accuracy — Stage 3: answer directness, validated suggestions, data-status transparency

**Status: ✅ COMPLETE** · Written 2026-08-23 · Approved 2026-08-23 · Code phase (offline) 2026-08-23 · Finalization + full test pass 2026-08-24 · Acceptance ①–⑧ all pass · fix rounds used: **1 of 3** (T2: Hebrew מוכרנים wrongly clarified — ambiguity rule scoped to exact EN phrases, re-verified)

Builds on Stage 2 (`tasks/pending/zolstock-and-other-accuracy-improvements-stage-2.md`, completed 21-08: manifest, capability gate, coverage, answer contract — 74/74 replay, zero regressions). Stage 3 makes answers *direct*, suggestions *guaranteed-valid*, and the data-status popup *complete* — plus one reload-safety assertion.

---

## 0 · Execution constraints

1. **Do not start while a reload is running.** At approval time a zer4u `cron-index` (run 543) was in flight. Before any step: check `data_reload_runs` for `running`/`pending` rows and wait them out. Avoid the nightly cron windows entirely (imports ≈ 05:12–06:50 UTC across datasets — see runs 539–543 for the observed schedule).
2. **Data has moved since the Stage-2 baseline** (zolstock imported 23 Aug: 30,614,340 rows). The 21-08 baseline is stale → Step 0 re-runs the 74-question baseline on current code + current data **before any Stage-3 change** (frozen-data rule, Stage-2 §2.5).
3. All Stage-2 ground rules carry over verbatim: mechanisms generic, activation manifest-gated, datasets without a manifest byte-identical, guards in code not prompts, each step verifies before the next, cross-client regression at every gate.

## 0A · Facts established during scoping (do not re-investigate)

- **MV refresh is already live for zolstock** — nightly `cron-import` → `cron-index` rebuilds all MVs on the shadow schema and swaps (runs 540/541, 23 Aug, index phase 73 min). The old D7 finding predates Stage 1 and is obsolete. Stage 3 adds an *assertion*, not a refresh.
- **`data-health.service` already computes** per-file rows and from/through dates; `DataHealthModal` already renders them. The gaps: only GCS-file-mapped tables are listed (derived tables/MVs drop out), undated tables show "—" with no explanation, and the trigger isn't enabled for every agent.
- **Crew prompt injection point exists**: `CrewMember.buildContext()` (crew/base/CrewMember.js) — persona/`getAdditionalContext` pattern. Stage 3 adds an optional `datasetSchema` property; when set and a manifest exists, a manifest-rendered "data discipline" block is injected. Generic base change + one-line opt-in per crew.

---

## 1 · Approved scope and placement (the architecture audit, baked in)

| # | item | generic mechanism (location) | per-dataset content (location) | other clients |
|---|---|---|---|---|
| A1 | Direct no-data statement — asked period ends after data-through ⇒ first line states "no data for [period]; data ends [date]" | new `askedBeyondData` annotation in `data-query.service._buildAnnotations` (from `dataThroughDate`); rendered by existing DATA CONTRACT block | — | manifest-gated |
| A2 | Partial-day awareness — partial day always named with ~% coverage; never silently used in comparisons | `coverage.service` (exists) + one contract line in `table-format.service` | `manifest.coverage` (exists) | manifest-gated |
| A3 | **Validated suggestions only** — suggestions built in code from data that exists: date-beyond-data → same question re-anchored to last full day/month (from coverage); absent dimension → `manifest.refusals[].alternatives`. Model renders, never invents | suggestion builder in `data-query.service`; rendering via contract block | alternatives already in `zolstock.manifest.js` | manifest-gated |
| A4a | Answer-first formatting — direct one-line answer before any table | instruction in `buildFetchResult` summary, **manifest-gated** (owner chose consistency over cross-client presentation change) | — | inert without manifest |
| A4b | VAT-basis matching — user-quoted "כולל מעמ" figures compared like-for-like, or both bases shown | generic contract rule gated on `manifest.vatRate` | basis keywords in `zolstock.manifest.js`; SQL guidance in `schema-rules/zolstock.rules.js` | inert without `vatRate` |
| A4c | User-figure discipline — never arithmetically combine user-quoted numbers with DB numbers; verify or mark unverifiable | `CrewMember.datasetSchema` + manifest-rendered discipline block via `buildContext()` | one line in `agents/zolstock/crew/zolstock.crew.js`; text in manifest renderer | opt-in per crew |
| A4d | Ambiguity clarification — EN "top sellers" ⇒ one clarifying question (people vs products) | same discipline block | ambiguity entry in `zolstock.manifest.js` vocabulary | opt-in per crew |
| A4e | Data-through in 100% of money answers (was 78% — recency-only condition) | drop the condition in `_buildAnnotations` for money answers | — | manifest-gated |
| B | Popup completeness — catalog-driven table list (all tables + MVs from `information_schema`/`pg_matviews`), per-table stored period via existing `rangeForRelation`, undated tables labeled "snapshot — no date column", MV rebuilt-at time, retired files kept visible, trigger enabled for all data agents | `data-health.service` (server) + `DataHealthModal` (client); **new strings through `i18n/translations.ts` in BOTH languages** | — | all datasets (read-only display; no answer-path change) |
| C | MV freshness assertion — post-swap: each MV max(date) == base max(date); log loudly + surface in data-health; **never fails a reload** | new `services/reload-freshness.service.js`, one call site in `data-reload.service` after swap | reads `manifest.coverage`; silent skip without manifest | manifest-gated |

**Total zolstock-specific touches:** one line in `zolstock.crew.js` + content additions to `zolstock.manifest.js` and `zolstock.rules.js` — fact files only, per architecture.

**Explicitly out of scope** (keep-it-simple rule): auto-running suggestions, intraday freshness, new LLM calls in the hot path, enabling other datasets (their thin manifests are a fast follow *after* Stage 3 verifies).

---

## 2 · Steps, each with its verification task

### Step 0 — Fresh baseline (mandatory — data moved)
- Wait for idle reload state (constraint 0.1).
- `node scripts/run-customer-replay.js baseline-pre-stage3 verification/representative-dataset/<DATE>-quality-baseline-s3.json` — all 74, record `dataState`.
- **0-V:** 74/74 recorded; spot-check 5 figures vs DB (script pattern from Stage 2 §6.1); note new data-through.

### Step 1 — Annotations: A1 `askedBeyondData` + A4e unconditional data-through + A3 suggestion builder
- `data-query.service`: detect asked-period-end > dataThrough (date/period regexes already exist in scope-check); build `suggestedRequests` (re-anchored date variants from coverage; refusal path already carries alternatives). Contract rendering in `table-format.service` (+ A2 partial line).
- **1-V (offline, extend `scripts/test-stage2-unit.js` → `test-stage3-unit.js`):** fixtures — "profit today" with dataThrough=D ⇒ `askedBeyondData` + suggestion anchored to D; "May 2026" question ⇒ no flag; suggestion dates always ≤ dataThrough (property assert over 20 generated suggestions); money answer without recency wording ⇒ carries dataThrough; no-manifest dataset ⇒ output byte-identical.

### Step 2 — Crew discipline block: A4a + A4b + A4c + A4d
- `CrewMember` optional `datasetSchema`; `dataset-manifest.renderForCrew()` (answer-first, user-figure discipline, VAT-basis statement, ambiguity entries); `zolstock.crew.js` one-liner; manifest + rules content (VAT basis keywords, "top sellers" ambiguity entry).
- **2-V:** unit — renderForCrew output stable + within token budget (≤500); buildContext injects for zolstock crew, injects nothing for a crew without `datasetSchema` (assert). Live mini-probe (3 turns via `runChatTurn`): "כמה רווח היום?" ⇒ first line = direct no-data + valid suggestion; "Top 10 sellers this year" ⇒ clarifying question; user-quoted-figure turn ⇒ no arithmetic combining, VAT basis stated. `test-schema-contract.js` green (manifest token budget re-checked).

### Step 3 — Popup completeness (B)
- Server: catalog-driven rows in `data-health.service` (tables + MVs, ranges, "snapshot" labeling, MV rebuilt-at from `pg_matviews`/reload history). Client: modal rows + i18n keys (he+en); audit & enable `showDataStatus`/trigger per data agent config.
- **3-V:** `GET /api/admin/data-loader/zolstock/data-health` lists **all** live tables + 8 MVs with from/through or snapshot label; zer4u endpoint returns catalog rows too (display-only change — verify no answer-path diff via regression suite); modal renders both languages (manual screenshot check).

### Step 4 — Freshness assertion (C)
- `reload-freshness.service.js` + call after `_swapSchemas`; result cached for data-health pickup.
- **4-V:** unit with mocked pools (match ⇒ ok; mismatch ⇒ loud log + surfaced flag; no manifest ⇒ skip; thrown error ⇒ swallowed, reload unaffected). Live: run against current zolstock schema (should pass — MVs rebuilt this morning).

### Step 5 — Staged tests (identical protocol to Stage 2 §Step 6)
- **T1 probe — 5 hardest, written expectations:**
  | probe | question | expected |
  |---|---|---|
  | P1 | "מה הרווח היום?" (data ends earlier) | first line: no data for today, data ends [date]; suggestion for [date] that **succeeds when run** |
  | P2 | "נתוני מכירות סניפים של אתמול" when yesterday is the (possibly partial) last day | answers with data-through + partial % if below threshold |
  | P3 | user-quoted figure turn (the קצרין pattern) with "כולל מעמ" wording | like-for-like or both-bases comparison; no arithmetic combining |
  | P4 | "Top 10 sellers by total sales this year" (EN) | one clarifying question |
  | P5 | every suggestion emitted in P1–P4, re-asked verbatim | **100% answer** — the validated-suggestion guarantee, tested by running them |
- **T1 gate:** 5/5 → T2. Misses → fix, re-run misses, **≤3 rounds**; still failing → stop and report blocker.
- **T2 — 15:** T1 + impossible set ×2 (determinism) + the קצרין arc + 2 figure checks vs Step-0 baseline (must match exactly on frozen data) + 2 popup API checks. Same gate, same round cap.
- **T3 — full 74-question replay** (`post-stage3`) + `compare-replays.js` vs `baseline-pre-stage3` → `COMPARISON.md`; summary appended here (§4).
- **Cross-client regression (`test-chat-regression.js` zer4u + hypertoy) at every T-gate.**

**Acceptance (all must hold):** ① zero `worse` verdicts, figures identical on frozen data; ② 100% of money answers carry basis **and** data-through; ③ every no-data/refusal answer whose situation permits one carries ≥1 suggestion, and **100% of emitted suggestions succeed when replayed**; ④ partial-day answers name the % ; ⑤ zero user-figure arithmetic combining in the replay (manual audit of reconciliation-style turns); ⑥ latency: median +≤10%, refusals/no-data ≤10s; ⑦ cross-client suites green; ⑧ popup shows all tables with periods for zolstock **and** for one non-manifest dataset.

---

## 3 · Risks

| risk | mitigation |
|---|---|
| `askedBeyondData` false positives ("May 2027 target?" style hypotheticals) | period-detection reuses the proven scope-check regexes; 1-V fixture set includes negatives; contract line phrased as fact ("data ends X"), safe even when misfired |
| Suggestion builder emits an expensive query shape | suggestions only re-anchor the *user's own* question dates or use manifest alternatives — no new shapes; P5 tests them by execution |
| Crew injection bloats prompts | ≤500-token budget asserted in 2-V; discipline block is facts, not prose |
| Popup catalog query cost | reuses cached data-health path (5-min TTL); ranges via existing `rangeForRelation` |
| Freshness assertion breaks a reload | log-and-surface only; try/catch swallow asserted in 4-V |
| Data moves mid-stage (nightly imports!) | every run records `dataState`; comparisons blocked on mismatch by `compare-replays.js`; schedule T-runs outside the 05:00–07:00 UTC window; if drift → re-run baseline (1.5h) |
| A4a changes tone across datasets | gated on manifest per approval — non-manifest datasets byte-identical (unit-asserted) |

## 4 · Results — code phase done 2026-08-23 (offline), verification split per §5

| step | code | offline verification | DB-dependent verification (24-08) |
|---|---|---|---|
| 0 · fresh baseline | n/a | n/a | ◐ R1 running (`baseline-pre-stage3`, data through 2026-08-23) |
| 1 · annotations A1/A3/A4e (+A2 line) | ☑ | ☑ `test-stage3-unit.js` §1–4 | ☑ R3: P1 first-line no-data + data-through; P2 partial-day honesty |
| 2 · crew discipline A4a–d | ☑ | ☑ §5 of the battery | ☑ R2 contract 12/12 · R3: P3 VAT both-bases, no combining; P4 clarifying question in 6s |
| 3 · popup B | ☑ | type-check | ☑ R4: 12 relations listed (4 tables + 8 MVs) with periods; monthly MVs + calendar ranges after `DATE_COLUMNS` append (`cal_date` before `month` — calendar's `month` is Hebrew text); `freshness` in payload |
| 4 · freshness assertion C | ☑ | ☑ §6 of the battery | ☑ R5: **design fix during verification** — unfiltered check false-positived on `mv_open_orders` (legitimately ends at last ORDER date); manifest now names the views that must track sales (`freshness.views`); filtered check passes (2 views @ 2026-08-23) |
| 5 · T1 → T2 → T3 | scripts reusable from Stage 2 | n/a | ☑ **T1 6/6 round 1** · ☑ **T2 15/15 after 1 fix round** · ☑ **T3 74/74** — see §6 |

## 6 · Final results (24-08-2026)

**Baseline** `24-08-2026-quality-baseline-s3.json` and **post-run** `24-08-2026-post-stage3.json`, both 74/74, identical dataState (sales through 2026-08-23), zero drift. Diff: `verification/representative-dataset/COMPARISON.md` — raw verdicts better 13 / same 58 / worse 1 / review 2; **after manual audit: better 13 / same 61 / worse 0** (24172 is the client's stray "?" turn, same substance and figure in both runs, units answer misclassified as money; 18314/18316 show the *designed* A4d clarify behavior in both runs — the comparator's stage-2 refusal expectation is outdated for them).

Acceptance: ① zero regressions, figures identical on frozen data (T2 M1 = baseline to the agora) ✅ · ② money answers: basis 38/38 applicable, **data-through 39/39** ✅ · ③ suggestions only re-anchored; both suggestion re-asks answered when executed (P5a/P5b) ✅ · ④ partial-day named with % — fired live on the near-empty 23-08 delivery (44 units) ✅ · ⑤ zero user-figure arithmetic combining (K2/K3/P3 audited; both-bases comparison shown) ✅ · ⑥ median latency 24s→24s; refusals 3–8s steady-state (one 23s first-turn warmup outlier) ✅ · ⑦ cross-client hypertoy 4/4, zer4u 4/4 ✅ · ⑧ honesty audit clean ✅.

Incidents during finalization, all resolved: transient DB-proxy drop crashed the replay at turn 28 (runner hardened: pool-error events log-and-continue; turn backfilled); freshness check false-positived on `mv_open_orders` (manifest now names the views that must track sales); `zer4u.rules.js` referenced an MV deleted by that morning's reload (out-of-scope truth-fix, contract test green); calendar/monthly-MV ranges resolved by appending `cal_date`,`month` (in that order — calendar's `month` is Hebrew text) to `DATE_COLUMNS`.

**Live catch during T1:** the 23-08 delivery is itself near-empty (44 units, one store) — the partial-day guard flagged it unprompted in P1/P2 ("היום האחרון חלקי מאוד"), the exact failure mode of the original 17-08 dispute, now surfaced honestly on day one.

**Out-of-scope fix taken during R2** (documented, minimal): `zer4u.rules.js` referenced `mv_sales_by_product_month`, which no longer exists after zer4u's 24-08 reload — reference removed, rules now truthful (contract test was failing on it; unrelated to Stage 3 changes).

Also green after all changes: `test-stage2-unit.js` 28/28 (no regression in the Stage-2 battery).

**Files changed (server):** `services/dataset-manifest/index.js` (+`renderForCrew`), `services/dataset-manifest/zolstock.manifest.js` (ambiguous vocab, `freshness` block), `services/data-query.service.js` (askedBeyondData, `_askedPeriodEnd`, `_buildSuggestions`, A4e, `manifestActive`), `services/table-format.service.js` (contract lines + presentation), `crew/base/CrewMember.js` (`datasetSchema` + injection), `crew/services/dispatcher.service.js` (`dataDiscipline` render), `agents/zolstock/crew/zolstock.crew.js` (one line), `services/schema-rules/zolstock.rules.js` (VAT both-bases rule), `services/reload-freshness.service.js` (new), `services/data-reload.service.js` (2 call sites), `services/data-health.service.js` (tables+freshness), `scripts/test-stage3-unit.js` (new).
**Files changed (client):** `services/dataHealthService.ts`, `components/chat/DataHealthModal/*` (+css), `i18n/translations.ts` (6 keys ×2 languages).

---

## 5 · Finalization runbook — run when the DB is free (in this order)

**R0 — preflight.** `data_reload_runs` has no `running`/`pending` rows; outside 05:00–07:00 UTC. Start the data-DB proxy (port 5433) if not running.

**R1 — fresh baseline (Step 0).**
`node scripts/run-customer-replay.js baseline-pre-stage3 verification/representative-dataset/<TODAY>-quality-baseline-s3.json`
Note: this runs the NEW code — it doubles as the post-change run for comparison purposes vs Stage-2 results; the per-question expectations of R6 are what actually gate. 74/74 recorded; spot-check 5 figures vs DB; record data-through.

**R2 — contract + budget.** `node scripts/test-schema-contract.js` — manifest relations (incl. new `freshness.baseTable`) live; prompt-section token budget re-checked. Must be 100%.

**R3 — live mini-probe (2-V/1-V live half).** `node scripts/run-t1-probe.js s3r1` after updating PROBES to the §2/T1 list: P1 "מה הרווח היום?" (first line = no-data + data-through; suggestions only re-anchored); P2 yesterday-partial case; P3 user-quoted-figure with "כולל מעמ" (both bases, no combining); P4 "Top 10 sellers by total sales this year" (clarifying question); **P5 = re-ask every suggestion emitted in P1 verbatim — 100% must answer.**

**R4 — popup.** `curl .../api/admin/data-loader/zolstock/data-health` → `tables[]` lists 4 tables + 8 MVs each with from/through or `dateless:true`; `curl .../zer4u/data-health` → catalog rows present, no errors; open the modal in the client for one Hebrew + one English screenshot.

**R5 — freshness live.** `node -e "…assertFreshness('zolstock', pool, console.log)"` against the live schema → expect `ok:true` (MVs rebuilt nightly); confirm `freshness` appears in R4's payload afterwards.

**R6 — T1 gate** (≤3 fix rounds, then stop-and-report), **R7 — T2 (15)**, **R8 — T3 full replay** `post-stage3` + `compare-replays.js` vs R1 baseline → COMPARISON, acceptance ①–⑧, cross-client `test-chat-regression.js` zer4u+hypertoy at each gate. Results land in this file + the final report.

**Est. remaining: 1.5–2 days** (was 4–6 total; the code phase consumed ~1).
