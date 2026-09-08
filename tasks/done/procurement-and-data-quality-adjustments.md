# Procurement module & data-chat quality — the full branch record

Branch: `vl_us_procurement_module_groups_and_smart_tune` (both repos).
Period: 2026-09-05 → 2026-09-09. Dataset: zolstock (binding #1 of the
Smart Replenishment module). Everything below is committed and battery-green;
nothing is deployed or merged — the branch awaits review.

DB changes across the entire branch are strictly additive: one migration
(048 — verdicts, proposals, bulk operations, all platform-DB, dataset-namespaced)
and zero changes to any existing table or customer-data schema.

---

## 1 · What was built, in order

### Chat protocol refit — never refuse on vocabulary (033cfb0, client 78aebda)
The client-screenshot incident (refusals on "מחלקת יצירה - מוצרי עץ" and
"עץ in the name") became decision D9: modules ENRICH answers, never gate them.
Every replenishment question decomposes as RESOLVE (vocabulary → scope; the
model's job, unbounded) × COMPUTE (arithmetic; the engine's job, exclusively).
`scope.js` gives the tool a universal scope surface — `skus[]` (cap 500),
`search`, `category`, `subcategory` — and the crew guidance teaches the
decomposition with the incident question as its worked example.

### Procurement Groups + buyer verdicts (684f9be, 78aebda, migration 048)
Read-time classifier (doubt → season → trend → history → confidence) splits
the due list into `order_now / suspicious("Needs checking") / out_of_season /
fading / new`, each row carrying reason codes rendered bilingually. Buyer
verdicts (Move-to… / Reject → Needs checking) are stored per SKU and win over
the classifier; a recompute that disagrees flags for review, never silently
reverts. Group chips + per-row controls on the Procurement page.

### Pace model v2 — weighted + per-item seasonality (684f9be; enabled live)
`v = (2·q60 + (q365−q60))/425 × clamp((pyNext90/pyYear)/(90/365), .25, 4)`
when the prior year has ≥ `seasonalMinUnits`. Hand-checked to 4 decimals
against raw view fields. Page 1 became autumn/winter goods; pools parked.
The basis code always states the model that actually ran.

### Smart Tune in the REAL chat (6d48b04, 1944f4a; client 98e2203, eedfe52)
Server-side the tune scope always was the same chat (same crew, dispatcher,
conversation store — scoped turns swap the tool set to `fetch_replenishment` +
`propose_group_change` ONLY). The bespoke client panel was deleted and replaced
with the platform chat itself: `moduleScope` rides the normal stream body;
scoped conversations are stamped server-side, labeled in history, and open on
a scope-specific welcome; proposal cards are a generic `_chatAction` envelope →
persisted `chat_action` thinking step → kind→renderer registry in the real
Message renderer. Cards re-sync their proposal's CURRENT status on mount, so
history re-renders honestly. Executed moves reach the Procurement page over
the app's first postMessage bridge. Strict show rule holds by construction:
only scope tools emit envelopes; scope tools attach only on validated scoped
turns; main chat can never grow a Process button.

### Proposal lifecycle hardening (f55df05)
Preview→Process (D5 snapshot semantics) hardened for parallel sessions:
a new proposal supersedes the conversation's previous open one (the 28-vs-14
double-card incident); execute and revert claim their row with one conditional
UPDATE (two clicks race, exactly one wins); revert is ownership-guarded (a SKU
whose verdict changed since the operation is skipped and counted, never
clobbered); verdict timestamps use the DB clock (app-clock skew made ownership
checks unreliable); stale previews sweep to `expired` opportunistically.

### Determinism — the model no longer chooses the numbers (0165a68, 30f3e32, 5ec861f)
The incident class: same near-deterministic question, different answers
(invented 0-day and 25-day horizons; a 448-row fuzzy SQL leg beside the
module's 383-item universe; stem "מטרי" sweeping geometric planters into an
umbrella move; 5-of-14 SKU lists hand-built from a paged read). Fixes, all
mechanical where possible:
- `horizonDays` takes effect only with `windowFromUser` (the user's quoted
  words); alone it is ignored and the contract says so.
- One universe per answer: module-expressible scope goes straight to the tool
  (the crew's stale worked example taught the old SQL-resolve recipe); the
  contract carries the stock-file-universe sentence and LABELED money
  sentences (due-set total vs whole-scope total).
- Name search matches at WORD STARTS (גיאומטרי can no longer match מטרי);
  shortest-stem rule for spelling variants; skus[] only for complete sets.
- Chat scopes can pin turn temperature (Smart Tune pins 0; providers that
  reject sampling params — gpt-5.x — are stripped-and-retried generically).
- Scope prompt rules: groups ≠ catalogue categories (clarify, don't map);
  module-universe boundary (sales detail → honest pointer to Data Chat).

### The actionable calendar + forward-looking sort (fd93c90; client c2c1915)
The client read "Order by 2026-06-06" as an instruction; it was a diagnosis
(= data-through − 90-day default lead; 86% of the due list collapsed onto that
one date). Two-date model, computed in the engine:
- `placeOrderBy` — WHEN TO ORDER, today at the earliest, never past
- `runoutDate` — when current stock is projected to hit zero
- `arrivesIfOrderedToday`, `stockoutGapDays` — the exposure picture
- `orderByDate` + `daysLate` remain as the diagnosis
One shared ordering (`engine.compareUrgency`): soonest projected runout first,
ties by money-bleed (velocity × unit cost), then value, then a stable key.
On screen: PLACE ORDER column (red "Today" when now), Why-panel gains
"Stock runs out" (with gap) and "Would arrive"; the CSV carries all fields.
The chat tool exposes them and its contract spells the semantics out.

### Around the module
- Procurement page restructured to the updated design; accent generically from
  each client's brand tokens (ecdbbea, ac87ad7).
- `viewCapabilities` reads matview columns from `pg_attribute`
  (information_schema excludes matviews) (54bd8b0).
- superhist registered in the insights-suite reloader (7bde247).
- Chat-scope authoring checklist added to `docs/features/modules.md` (667137e)
  — the incident-derived rules, framework-side, with the lift triggers named
  (proposals lifecycle → `modules/services/` on module #2; `ChatActionCard`
  grows a branch per action kind).

## 2 · Verification record

- Offline batteries: replenishment unit 125/125 (incl. calendar + ordering
  invariants), render 52/52, modules unit 52/52, scope 16/16 (+20/20 chat
  incl. the exact screenshot phrasings), API 34/34.
- Hard-10 dev set: 10/10, every recomputable figure exact (report delivered
  2026-09-07; caught + fixed the horizonDays disclosure bug).
- Determinism: "move the umbrellas" 3× → 19 items every run; wood-products
  5× across two rounds → single tool, single universe, 128 due / ₪89,114
  every time; two separate conversations → byte-consistent counts.
- REAL-client replay (10 hardest corpus questions, with conversational
  context, 26 live turns): 12 of 13 evaluated turns good-to-excellent.
  Katzrin discrepancy corrected to the exact independently-computed figure;
  agent-sales reconciliation honest end-to-end; the one FAIL — BH-34-240
  "not in catalogue" — is a contextual SQL flake (2 of 3 attempts correct;
  see recommendation Q1). Transcripts in the session scratchpad.
- Live DB tests for the concurrency layer (supersede / execute race /
  guarded revert / double-undo): 14/14, self-cleaning.

## 3 · Recommendations

### Quick + safe (approved direction, not yet built)
- **Q1 — mechanical existence check**: when generated SQL contains a
  SKU-shaped literal and returns zero rows, trigger the existing
  self-correcting retry with an items-bridge existence probe as the hint —
  "not found" becomes unreachable until the bridge was checked. Kills the
  one observed failure class.
- **Q2 — bilingual header dictionary**: extend the display-column token map
  so table headers stop mixing languages ("סה"כ units שנמכרה").
- **Q3 — canary tripwire**: nightly 5-question replay comparing counts
  against the engine; alarm on drift. Makes the determinism claim
  self-checking.

### The biggest lever is not code
**Supplier lead times: 0 of 9 configured.** Every date runs through the
90-day default; that alone collapses 86% of the due list onto one "Today +
94-day gap" wall. Real leads (even rough ones from the client meeting)
un-collapse the calendar the same day. Ten minutes of buyer work.

### Data gaps (for the Reut conversation — these bound the ceiling)
- Goods receipts → measured lead times + on-order freshness.
- Historical stock levels → censored-demand correction (dead vs starved),
  fill-rate measurement.
- Actual sales money + agent/seller fields → real reconciliation instead of
  list-price estimates (known +2.3–7% band, 8.1% of units unpriced).
- Stock-file coverage: 9,917 of 14,810 SKUs absent — absence-vs-zero question
  still open with Reut.

### Deferred with named triggers
- Transfers/branch balancing = the last recommendation class on free SQL →
  candidate module capability #2.
- Framework orchestration prompt rule → 2nd module with chat tools.
- `sqlRulesFragment` hook + dead `manifestFragment` (finding S1) → dataset #2
  onboarding.
- Proposals lifecycle lift to `modules/services/` → 2nd action-capable module.

## 4 · Operational notes
- The local dev server must be RESTARTED to serve server.js/route changes
  (module files hot-load; the stream handler and routes do not).
- Branch not merged; client deploy pending user decision.
- Fiveways money whitelist is engine-derived now — do not reintroduce
  hardcoded totals (a git pull reverted it once already).
