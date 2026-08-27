# Verification — Aspect Modules / Smart Replenishment

Verification runs for the build described in
`tasks/pending/aspect-modules.md`. One section per step whose `Verify`
clause has been executed. Steps appear here in plan order as they complete.

**How to reproduce anything below:** every section names the exact command.
All of them run from the repo root of `aspect-agent-server` unless stated
otherwise.

---

## A0 — Fresh baseline (2026-08-27)

Establishes what already passes *before* any module code exists, so a later
failure can be attributed. Per the plan's A0 verify clause: "all pass, or
pre-existing failures are written down here."

### Result summary

| Battery | Command | Result |
|---|---|---|
| Insights unit | `node scripts/test-insights-unit.js` | **53/53 PASS** |
| Schema contract | `node scripts/test-schema-contract.js` | **19/19 PASS** |
| Stage 2 unit | `node scripts/test-stage2-unit.js` | **30/30 PASS** |
| Stage 3 unit | `node scripts/test-stage3-unit.js` | **35/35 PASS** |
| Client typecheck | `npx tsc -b` (in `aspect-agent-client-react`) | **PASS** (exit 0, no output) |
| Client lint | `npx eslint .` (in `aspect-agent-client-react`) | **FAIL — pre-existing**, 166 errors + 49 warnings across 113 files |

Four server batteries and the client typecheck are green. The client lint
failure is **pre-existing and unrelated to this build** — it is recorded
here as the baseline, not treated as something Phase A introduced or must
fix.

### Client lint baseline detail

Raw machine-readable output is written to `a0-client-eslint-baseline.json`
by `npx eslint . -f json` — **gitignored** (`verification/.gitignore` excludes
`*.json`, the repo-wide convention: raw run output is local, the README is the
durable record). Regenerate it any time with that command. The breakdown it
contained, which is the part that matters:

| Errors | Warnings | Rule |
|---|---|---|
| 42 | 0 | `react-hooks/set-state-in-effect` |
| 0 | 39 | `react-hooks/exhaustive-deps` |
| 36 | 0 | `react-refresh/only-export-components` |
| 23 | 0 | `@typescript-eslint/no-explicit-any` |
| 0 | 10 | (parse) |
| 10 | 0 | `react-hooks/refs` |
| 10 | 0 | `@typescript-eslint/no-unused-vars` |
| 8 | 0 | `react-hooks/preserve-manual-memoization` |
| 8 | 0 | `react-hooks/immutability` |
| 6 | 0 | `react-hooks/rules-of-hooks` |
| 6 | 0 | `react-hooks/static-components` |
| 5 | 0 | `prefer-const` |
| 3 | 0 | `no-useless-escape` |
| 3 | 0 | `react-hooks/purity` |
| 2 | 0 | `no-misleading-character-class` |
| 2 | 0 | `@typescript-eslint/no-unused-expressions` |
| 1 | 0 | `no-irregular-whitespace` |
| 1 | 0 | `no-empty` |

The bulk are React-19 lint rules (`react-hooks/*`, `react-refresh/*`) firing
across pre-existing components — the ruleset is stricter than the code it
was applied to. **Nothing here is in a file this build touches.**

**The bar for later steps:** new client code added by this build must not
add to these counts. A4 and D2 re-run `npx eslint .` and compare against
this baseline — the check is "no new problems", not "zero problems", since
zeroing the pre-existing 215 is out of scope for this work.

---

## A1 — Migrations: client_modules + module_runs + module_outbox (2026-08-27)

Creates the three framework tables in the **platform DB**
(`agents_platform_db`), per plan section 02.

### Reproduce

```bash
# Cloud SQL Proxy must be up (aspect-agents-db on :5432)
node db/migrations/run-040-add-client-modules.js   # apply — idempotent
node db/migrations/probe-040-client-modules.js     # verify — self-cleaning
```

### Result

| Check | Result |
|---|---|
| Runner executes | **PASS** — 9 statements, `Tables present: client_modules, module_outbox, module_runs` |
| Behaviour probe | **10/10 PASS** |
| Drizzle definitions load + export | **PASS** (`clientModules`, `moduleRuns`, `moduleOutbox`) |

Probe detail — this is the part that matters, since "the tables exist" was
never the real question:

| # | Check | Result |
|---|---|---|
| 1 | Column defaults on insert (`enabled=false`, `status='not_initialized'`, `binding=null`) | OK |
| 2 | Duplicate `(dataset_id, module_id)` rejected by UNIQUE | OK |
| 3 | `ON CONFLICT … DO UPDATE` upserts in place (1 row, values replaced) | OK |
| 4 | `client_modules.status` CHECK rejects a typo (`'redy'`) | OK |
| 5 | `module_runs` valid row (`kind='init'`, `status='running'`) accepted | OK |
| 6 | `module_runs.kind` CHECK rejects `'rebuild'` | OK |
| 7 | `module_runs.status` CHECK rejects `'done'` | OK |
| 8 | `module_outbox` row defaults to `provider='outbox'`, JSONB recipients intact | OK |
| 9 | Partial live-index predicate matches an `enabled+ready` row | OK |
| 10 | Toggling `enabled=false` removes it from the live set | OK |

### Notes / decisions taken here

- **Migration number 040** — 039 was taken by
  `run-039-backfill-message-feedback-agent-id.js` (this session, earlier).
  Plan section 10 flagged the ZS plan's "039" as probably stale; it was.
- **CHECK constraints on `status` / `kind` are deliberate.** The codebase
  uses CHECKs sparingly (2 prior migrations) and only for real invariants —
  this qualifies: `client_modules.status` is the gate deciding whether a
  module's recommendations reach a client, so a mistyped value must fail at
  write time rather than silently parking the module in a state that
  `= 'ready'` never matches. Accepted cost: adding a sixth status needs a
  migration.
- **A partial index `idx_client_modules_live`** encodes the
  `enabled AND status='ready'` gate directly, since that is the question
  asked on every request that might surface a module. Checks 9–10 confirm
  the predicate behaves.
- **`module_outbox.run_id` is not a foreign key** — outbox history should
  outlive run pruning rather than cascade away with it.
- **The probe is self-cleaning** and re-runnable: it works under a throwaway
  `__probe_dataset__` id and deletes its own rows (confirmed `0 remaining`),
  so it never leaves test cruft in the shared platform DB.

---

## A2 — Registry + module.service + router (2026-08-27)

The framework skeleton: a static module registry, the service that owns
state/settings/the live gate, and one router mounted with one line in
`server.js`.

### Reproduce

```bash
node scripts/test-modules-unit.js    # offline — no DB, no LLM, no network
npm start                            # then, against the running server:
node scripts/test-modules-api.js     # live — self-cleaning
```

### Result

| Battery | Result |
|---|---|
| `test-modules-unit.js` (offline) | **29/29 PASS** |
| `test-modules-api.js` (live, localhost:3000 + platform DB) | **23/23 PASS** |
| Regression: insights-unit / schema-contract / stage2 / stage3 / force-propagation | **53/53 · 19/19 · 30/30 · 35/35 · 3/3** — unchanged |

### What each verify clause of A2 maps to

| Plan clause | Evidence |
|---|---|
| "API lists registered modules for a known dataset" | live §2 — admin list returns `_stub` with its full descriptor |
| "unknown dataset ⇒ 404" | live §1 (public) and §2 (admin), plus unknown-module 404 |
| "enable/disable round-trips" | live §3 and §5 |
| "unit test asserts a dataset with no module rows produces zero behavioral hooks" | live §1 (`{modules: []}` for a real dataset with no rows) + §7 (sibling dataset unaffected) + offline stub assertions (no chat tools, no manifest fragment, empty DDL) |

### The assertion that matters most

Live check §3: **flipping `enabled` on a module that has never been
initialized does not make it live.** `enabled` and `status` are independent,
and only `enabled AND status='ready'` counts. If that ever regresses a client
gets a nav item backed by views that were never built. It is asserted three
ways — the admin payload's computed `live: false`, the public list staying
empty, and `isLive()` — because one of those could plausibly be fixed while
another stays broken.

Check §5 covers the mirror case: **disabling preserves `status`**, so turning
a module off and back on does not discard a converged binding.

### Decisions and deviations taken here

- **`services/super-admin.js` is new, and `server.js` now requires it.** The
  super-admin key was a file-local `const SUPER_ADMIN_KEY = '6724'` plus a
  helper inside `server.js`, not exported. The modules router needs the same
  gate, and copying the key into a second file would mean two places to
  rotate it. Moved to one shared module (now also reading
  `process.env.SUPER_ADMIN_KEY` with the same literal as fallback, so
  behaviour is identical); `server.js` lost 4 lines and gained a require.
  Verified no other reference to the constant remained.
- **The admin surface is a sub-router guarded at the mount**
  (`admin.use(requireSuperAdmin)`), not per-handler, so a route added later
  cannot ship unprotected by omission. It is mounted BEFORE the public
  `/:datasetId` route — otherwise "admin" is captured as a dataset id. Same
  ordering hazard the insights router documents.
- **The public payload is deliberately a different, smaller shape**
  (`{id, name}` only) than the admin one. It is fetched by a customer's
  browser to decide whether to render a nav item; settings, binding and model
  id have no business there. Asserted in live §4.
- **Settings tier naming deviates from the plan's wording.** The plan (A2)
  says "module override → dataset default → code constant". The middle tier
  is stored per MODULE and applies across datasets, so calling it "dataset"
  would mislead — it is named `platform` in code
  (`provider_config['module_defaults_<moduleId>']`). The chain, the
  precedence and the source tagging are exactly as specified; only the label
  differs, and the code says so at the definition.
- **The `_stub` module was written in A2 rather than A3.** A2's own verify
  clause requires listing a registered module, so something had to be
  registered. Its lifecycle hooks are complete (A3 needs no further module
  work), and it is registered only when `NODE_ENV !== 'production'` —
  confirmed `.env.production.aspect` sets `NODE_ENV=production`, so it can
  never appear in a client-facing admin panel.
- **`getLiveModules()` filters out rows whose descriptor no longer exists.**
  A `client_modules` row can outlive its module if a descriptor is removed
  while the row still says `ready`. Serving from a missing descriptor would
  throw deep inside a chat turn; dropping it degrades to "the module isn't
  there", which is the same as never having installed it.
- **Both batteries are self-cleaning.** The live one works under the `_stub`
  module on a real dataset and deletes its row at the end (asserted `0
  remaining`), so a run never leaves test state in the shared platform DB.

---

## A3 — Init-run orchestrator with a stub module (2026-08-27)

The pipeline that turns a configured module into a `ready` one:
audit → (propose binding → render + build in a scratch schema → verify) × ≤5
rounds, with each round's failures fed into the next proposal.

### Reproduce

```bash
node scripts/test-modules-init.js    # needs the platform DB; no LLM, no data-DB, no server
```

### Result

| Battery | Result |
|---|---|
| `test-modules-init.js` | **41/41 PASS** |
| `test-modules-unit.js` (re-run after route additions) | **29/29 PASS** |
| `test-modules-api.js` (re-run) | **23/23 PASS** |

### What each verify clause of A3 maps to

| Plan clause | Evidence |
|---|---|
| "Stub run reaches ready" | §1 — `status='ready'`, binding persisted, run `succeeded`, converged in 1 round |
| "forced-failure run exhausts 5 rounds, sets failed" | §2 — `roundsUsed=5`, `client_modules.status='failed'`, run row `failed` |
| "the report names the failing probe per round" | §2 — `report.failedProbesByRound` has 5 entries, each naming `join_rate`; each round also stores the probe's **detail with its numbers** (`61.9% < 95% threshold`), not just a boolean |
| "Progress stages are monotonic" | §0 (arithmetic: the full 16-step sequence strictly increases) **and** §5 (a real run polled live: observed percentages never decrease and end at 100%) |

Monotonicity is asserted twice on purpose. The arithmetic check proves it
*by construction*; the live poll proves the running pipeline actually walks
that sequence. Either could pass while the other fails.

### Beyond the required clauses

- §3 — a run that fails twice then converges uses exactly 3 rounds, and
  `status` recovers to `ready` after the earlier failures.
- §4 — a second `startInit` while one is running is refused with **409**.
  Two concurrent inits would race on the same binding and the same scratch
  schema.
- §5 — progress labels read `Round N · <stage>` while running.
- §6 — `init_completed` / `init_failed` events fire at the seam E2 will use,
  and the failure event carries the per-round probe detail.
- §7 — unknown dataset and unknown module both refuse with 404.
- Routes added and manually exercised against a running server:
  `POST …/init` → `{runId, status:'running'}`, `GET …/runs/latest` →
  `{run, progress}`; 404 on unknown dataset/module, 403 without the
  super-admin key.

### Decisions taken here

- **The orchestrator never builds into the live schema.** Rendered DDL goes
  into a scratch schema which is dropped in a `finally` regardless of
  outcome. The real build happens inside the nightly reload (E1), into the
  shadow schema, before the atomic swap — the same place every other MV is
  built. Leaving a scratch schema behind would also double storage on a
  shared data DB for no benefit.
- **Empty DDL means no schema is created at all.** That is what lets the
  whole lifecycle run offline: the stub renders `[]`, so the build step
  touches no database and needs no pool.
- **The scratch build sets `lock_timeout = '2min'` alongside
  `statement_timeout = 0`.** Long MV builds are legitimate; waiting forever
  on someone else's lock is not — that was the exact shape of the zer4u
  crash loop fixed earlier this session.
- **Progress is stored as `"<round>:<stage>"` in the existing
  `progress_stage` column** and the percentage is *computed*, not stored. It
  is monotonic by construction because `round` only increases and the stage
  offset only increases within a round — no extra column, no counter that
  could drift. `describeProgress()` is the single place that turns it into
  `{round, stage, label, percent}`.
- **Notifications are an injected `onEvent` callback (default no-op), not a
  direct call.** E2 wires the outbox provider into that seam without
  touching this file's control flow, and §6 already asserts both events fire
  with the right payload.
- **Every round stores the binding it tried, not just the final one.** When a
  run fails, "what did it attempt each time" is the entire diagnostic value;
  storing only the last attempt would throw that away.
- **A thrown hook still leaves a readable run.** The catch marks the module
  `failed` and finishes the run row — a run stuck at `running` forever is
  worse than a failed one, because the 409 concurrency guard would then
  block every retry.
- **Fire-and-forget is deliberate here** (the admin tab polls rather than
  holding a multi-minute request open), and unlike the reload-scheduler race
  fixed earlier this session there is no cross-entity serialization to
  defeat — the guard is a per-(dataset, module) running-row check.

---

## A4 — Admin Modules tab (2026-08-27)

A generic per-dataset admin tab that renders whatever the server's registry
returns: module cards with status + enable toggle, a settings form built from
`settingsSchema`, and an init-run modal with polled progress and the round
history.

### Reproduce

```bash
# server
npm start                                     # aspect-agent-server, :3000
# client
npm run dev                                   # aspect-agent-client-react, :5173
# then open, with the super-admin gate unlocked (localStorage super_admin_key=6724):
#   http://localhost:5173/zolstock/admin/modules
npx tsc -b && npx eslint .                    # in the client repo
```

### Result

| Check | Result |
|---|---|
| Client typecheck (`npx tsc -b`) | **PASS** (exit 0) |
| Client lint delta vs the A0 baseline | **0 new errors, 0 new warnings, 0 new files** (166/49/113 before and after) |
| Tab renders in a real browser | **PASS** — verified headless, screenshots below |
| Progress bar reflects a real run | **PASS** — 100% + `Failed` on the exhausted run, live polling asserted in A3 §5 |
| Failure report is readable | **PASS** — all 5 rounds listed with `join_rate — stub: 61.9% < 95% threshold` |
| Toggle state matches the API | **PASS** — `Enabled` checked, `Ready` + `Live for this client` only when both hold |

### Verified in a real browser, not just by compiling

Driven headless through the Chrome DevTools Protocol against the running dev
server and the real platform DB (a compile-clean React page can still render
nothing):

- **Failed state** — red status dot, `Failed` pill, the warning strip
  "Enabled, but not live yet — initialization has not completed
  successfully", and the run modal listing every round with its probe
  numbers.
- **Ready state** — green dot, `Ready` + `Live for this client` pills,
  `Binding stored · updated 27/08/2026, 15:10:25`, and `Re-init / run
  report`.
- **Settings modal** — the two-column form generated from the descriptor's
  `settingsSchema`, per-field hints, a `default` source tag on the field
  still resolving from the code default, the notice in its fixed-height slot,
  and Cancel / Save settings.

### Two real defects the browser check caught (and fixed)

Both would have shipped had this step stopped at "it typechecks":

1. **A failed module said "Configure settings, then run Init infrastructure to
   begin."** — the message keyed off `binding`, and a failed run stores none,
   so a module that *had* been initialized read as though nothing had been
   attempted. Now distinguishes "never run" from "ran and stored no binding",
   and the action button reads `Re-init / run report` in both cases.
2. **A failed run drew a full blue progress bar.** A failed run also ends at
   100%, so in the success colour it read as "done, fine". Failed runs now
   draw the bar red.

### Deviations from plan section 04, and why

- **The tab is English-only, and deliberately does not call `useLanguage()`.**
  `useLanguage()` **throws** outside a `LanguageProvider`, and the dashboard
  admin routes have none — the provider is mounted only inside
  `IntelligenceShell`. Calling it here would unmount the entire admin page:
  exactly the hazard `CLAUDE.md` documents for `useAgentContext()`. Zero of
  the ~28 existing dashboard components use it, so the admin dashboard has no
  i18n infrastructure to join. The plan's "bilingual labels via
  i18n/translations.ts" is therefore not implementable for this surface
  today **without first internationalising the whole dashboard**, which is
  not in scope for A4.
  What was done instead: the descriptor's bilingual `name` / `label` / `hint`
  are carried end-to-end (server → API → `LocalizedText` type → UI) and
  rendered through one `localized()` helper. When the dashboard does gain a
  provider, that helper is the single line that changes — no re-translation.
  **This is the one open item from A4 worth a decision** (see below).
- **Nav gating reuses `!!config.database?.schema`** — the same condition as
  Query Optimizer / Data Loader, since a module binds to a dataset — but is
  passed as its own `showModules` prop rather than reusing their flag, so the
  two can diverge later without a rename.

### House rules honoured

- Modal editing, never inline; a **custom confirm modal**, never browser
  `confirm()` (turning a *live* module off is confirmed; turning one on is
  not — an uninitialized module going on is harmless because it still is not
  live).
- Notices render into a **fixed-height slot** in both the page and the
  settings modal, so nothing shifts when a message appears.
- Every hook is declared above the component's early returns.
- Data loading is deduped by a ref key, not a per-closure `cancelled` flag —
  React 19 StrictMode double-invokes effects and the naive version leaves the
  UI stuck on a skeleton.
- Polling runs **only while a run is in flight** and stops the moment it is
  not.

### Cleanup

All `_stub` rows were deleted after the checks: `client_modules`,
`module_runs` and `module_outbox` are back to **0 rows each**. Nothing was
left enabled on `zolstock` — a `_stub` module left switched on in the shared
dev DB is exactly the kind of test cruft the next person would find and have
to reason about.

---

## B1 — Binding contract + templates + deterministic renderer (2026-08-27)

`binding → SQL`, as a pure function. The LLM picks which columns go in the
holes; it never writes the SQL.

### Reproduce

```bash
node scripts/test-replenishment-render.js    # offline — no DB, no LLM, no network
```

### Result

| Battery | Result |
|---|---|
| `test-replenishment-render.js` | **47/47 PASS** |

### What each verify clause of B1 maps to

| Plan clause | Evidence |
|---|---|
| "Golden-DDL unit test passes" | §6 — rendering the same binding twice is byte-identical, and the schema name is the ONLY thing that differs between two clients |
| "rendering the ZolStock-shaped fixture produces DDL equivalent to the hand-written views in ZS-2" | §3–§4 — statement set and order, plus every ZS-2 correctness rule asserted as present in the emitted SQL |

### The ZS-2 rules, each asserted in the emitted SQL

A golden string alone would happily freeze a bug in place, so each rule is
also checked for directly:

| Rule | Origin | Assertion |
|---|---|---|
| Dedupe the catalog before every join | duplicate item rows once inflated another client's revenue by 44.6% | `GROUP BY sku` + `MAX()` in the catalog CTE, `GROUP BY item_number` in the bridge, and **`DISTINCT ON` never appears** (an untied one picks an arbitrary duplicate, so the same question returns different answers depending on how the query was written) |
| Anchor to the demand max date | these feeds are periodic exports and can be months behind | a `data_through` CTE exists, all three windows measure back from it, and **`CURRENT_DATE` / `now()` appear nowhere** |
| Two item keys, bridged | joining sales on the replenishment key returns almost nothing, which reads as "this product never sold" when it sold 71,421 units | demand joins `bridge` on the SALES key, stock joins on the REPLENISHMENT key, and the two are never conflated |
| UNIQUE index on every view | required for `REFRESH … CONCURRENTLY`; without it a refresh takes ACCESS EXCLUSIVE and blocks live queries | asserted on both views |

### Decisions taken here

- **Identifier safety is enforced twice, deliberately.** `validateBinding()`
  refuses anything that is not a plain unquoted identifier, and
  `templates.js` refuses again at the point SQL is actually built. The second
  check removes "did validation run on this path?" as a question a reviewer
  has to answer. A binding needing an exotic identifier is treated as a
  signal the mapping is wrong, not a case to accommodate.
- **`rowFilter` is a SQL fragment and cannot be identifier-checked**, so it is
  constrained instead: no semicolons, no comment markers, no statement
  keywords, ≤300 chars. Asserted against four injection shapes in §2.
- **Absent optional sections render typed constants, not missing columns.**
  A view whose *shape* depended on the client's data completeness would make
  every downstream consumer defensive; `on_order_qty` is `0::numeric` when
  there is no purchase-order feed, and the column list is identical either
  way (§5).
- **`mv_suppliers` is built ON `mv_replenishment_base`**, not by re-scanning
  the fact table — asserted. Re-deriving the dedup/bridge/window rules there
  would be a second place for them to drift out of step.
- **`replenishmentKeyRate` threshold is 0.001, not something demanding.** On
  ZolStock only 4.9% of items carry a SKU at all; that is a documented
  property of the feed, not a mapping error. The probe exists to catch
  **zero** — a binding that mapped the wrong column entirely.

---

## B2 — The engine + unit battery (2026-08-27)

The ZS-4 pure function: velocity → net available → reorder point → order-by
date → carton-rounded quantity → status. `today` is a parameter; the stock
source is passed in and never hardcoded to "warehouse".

### Reproduce

```bash
node scripts/test-replenishment-unit.js      # offline — no DB, no LLM, no clock
```

### Result

| Battery | Result |
|---|---|
| `test-replenishment-unit.js` | **63/63 PASS** |

### It independently reproduces the design doc's worked example

The strongest evidence available short of live data. The engine was written
from the ZS-4 formula; the mockup in the Aspect Modules doc (§12.2) states a
fully worked example. Every figure matches:

| Mockup states | Engine computes |
|---|---|
| sales pace 60 / day | **60** |
| in stock 2,300 warehouse | **2,300** |
| on the way 1,000 | **1,000** |
| reserved 100 | **100** |
| safety buffer 840 (14 days of sales) | **840** |
| stock covers 53 days | **53.33** |
| you need 8,040 units | **8,040** |
| 3,200 are available | **3,200** |
| order 4,840 | **4,840** |
| rounded to full cartons of 24 → 4,848 | **4,848** |
| should have gone out on 19 Jul | **2026-07-19** |

The only difference is "37 days late" vs the engine's **38** — 19 Jul to
26 Aug is 38 days, so that is an arithmetic slip in an explicitly
illustrative mockup value, not an engine defect.

### The eight named edge cases (all asserted by name)

| # | Case | Behaviour verified |
|---|---|---|
| 1 | Zero velocity, stock on hand | `no_demand`, quantity 0, described as **idle stock** in words |
| 2 | Zero velocity, zero stock | **excluded from the list entirely** — there is no decision to make |
| 3 | Negative net available | **reported, never clamped** (one ZolStock store carries −802,918 units; a `max(0,…)` would present broken data as a healthy zero) |
| 4 | `unitsPerCarton` NULL or 0 | no rounding, `carton size unknown`, and a note saying so |
| 5 | SKU missing from the catalogue | included (the stock is real), flagged `unmatched`, **no invented cost** |
| 6 | New item, first sale inside the window | velocity over **days since first sale**, thin history flagged — dividing by the full window would understate a product that is actually selling |
| 7 | `lastSold` older than the window | `no_demand` even with a non-zero 365-day figure; the item is **dormant, not slow** |
| 8 | Lead time inherited | `leadTimeSource: 'dataset_default'` and stated in words **every time**; a supplier-set lead time is not nagged about |

### Other properties asserted

- **Omitting `today` throws.** The engine must never read a clock — the feed
  lags the calendar, so a relative window measured from "now" is silently
  wrong. §2.
- **A different `today` moves the status but not the arithmetic**, and the
  order-by date is unchanged, because it is anchored to the data date.
- **`stockSource: 'store'` works today** — proof the later per-branch phase is
  a new caller, not a second implementation (the spec page's explicit
  instruction).
- **A minimum order quantity raises a real order but never forces one** that
  is not needed.
- **A window the prepared views do not carry** (e.g. 60 days) falls back to
  the nearest and the row **admits which window it actually used** — an
  answer computed over 90 days must not claim to be a 60-day figure.
- **Determinism**: identical inputs produce byte-identical output. That
  invariance is the whole reason this is a function and not a prompt.

### Regression after B1 + B2

| Battery | Result |
|---|---|
| insights-unit · schema-contract · stage2 · stage3 · force-propagation | 53/53 · 19/19 · 30/30 · 35/35 · 3/3 |
| modules-unit | 29/29 |
| replenishment-render · replenishment-unit | 47/47 · 63/63 |

---

## B3 — Audit hook + Hebrew gap report (2026-08-27)

Read-only scan of the LIVE zolstock schema — no LLM, no writes, no DDL. It
runs before any binding exists, so it introspects rather than being driven by
one.

### Reproduce

```bash
node scripts/run-replenishment-audit.js zolstock            # readable report
node scripts/run-replenishment-audit.js zolstock --save     # + raw JSON
node scripts/run-replenishment-audit.js zolstock --format=hebrew
```

Raw output: `audit-zolstock-2026-08-27.json` (gitignored per repo convention;
regenerate with `--save`).

### Result — REAL numbers from the live database

| Measurement | Value |
|---|---|
| Fact table | `facts`, ~27.5M rows |
| Catalogue | `items`, 306,617 rows |
| Row kinds | sales 27,464,734 · store_inventory 3,090,504 · customer_order 11,488 · warehouse_inventory 8,924 · purchase_order 677 · **unknown 87** |
| Sales range | 2025-01-01 → 2026-08-26 |
| `positive_supplier` | **100% populated**, 446 distinct |
| `sku` (replenishment key) | **5.0%** — 15,180 of 306,617 |
| `safety_stock` | 5.0% — 15,180 |
| `units_per_carton` | 4.8% — 14,757 |
| Goods-receipt evidence | **NONE FOUND** |
| Data through | 2026-08-26, **last day partial** |

**How the chosen key behaves per row kind** (has a code / resolves to an item):

| kind | rows | has code | resolves |
|---|---|---|---|
| sales | 27,464,734 | 22.4% | 100.0% |
| store_inventory | 3,090,504 | 14.6% | 100.0% |
| customer_order | 11,488 | 100.0% | 99.7% |
| warehouse_inventory | 8,924 | 100.0% | 99.3% |
| purchase_order | 677 | 100.0% | 99.9% |

These independently reproduce the documented facts — "85% of store-inventory
rows carry no item key" (measured 85.4%) and "99 of 5,015 warehouse SKUs have
no matching item" (measured 99.3% resolving).

### THE GATE NUMBER

**Only 2 of 446 suppliers have catalogue coverage you could actually order
against** — `ב.א. זול סטוק והפצה בע"מ` (12,500 of 14,974 keyed, 83.5%) and
`ארכיון ב.א` (2,642 of 4,534, 58.3%). Thirteen more have a token handful
(often literally 1 item of 16,648). This is exactly the C1 re-scope question
arriving early, and it independently confirms the feasibility brief's
conclusion that the pilot is one supplier.

### Two real defects this step caught in its own first run

Both would have produced confident, wrong numbers:

1. **The replenishment key was being chosen by column name and population,
   so it picked `barcode_key`** — 100% populated and matching `/barcode/` —
   over the real key `sku` at 5%. Every per-supplier coverage figure then read
   **100%**, i.e. the single number the gate exists to judge was silently
   wrong in the reassuring direction. Fixed: the key is now chosen by
   **measured join rate against the stock rows**. `sku` scores 99.3%, the
   barcode columns score 0.0%. A key that does not join is not a key, however
   full the column is.
2. **The stock grain being measured against was `store_inventory`** (3M rows,
   85% unattributable by design) rather than `warehouse_inventory`, which
   understated a key that is actually fine. Fixed: the warehouse grain is
   preferred, and the join rate is now reported for **every** row kind, since
   "works for the warehouse, not for branches" is two different conversations
   with the client.

### The Hebrew report was rewritten after its first run was unusable

It is meant to be **forwarded to the client's BI developer**, and the first
version went out **half in English with two explanations attached to the
wrong findings**. Cause: translations were keyed by English title and by
A-code, but several distinct gaps legitimately share a code (three different
situations are all "A10") and titles interpolate a row-kind name so they never
match a fixed string.

Fixed: every gap now carries a **stable translation key** plus its measured
params, so the Hebrew renders the real numbers (`רק ל-15,180 פריטים מתוך
306,617`) and row kinds read as a person would say them (`מלאי הסניפים`, not
`store_inventory`). An unknown key renders a truthful generic line rather than
English text. A check asserts **all 15 emitted gap keys have a Hebrew entry**.

Also removed "schema" from the client-facing header — our word, not theirs.

### Verify clause

| Plan clause | Evidence |
|---|---|
| "Read-only run against live zolstock completes" | PASS — full run, no writes |
| "JSON + README land in verification/modules-replenishment/" | PASS |
| "Hebrew summary renders" | PASS — 10 gaps, all Hebrew, all with measured numbers |

---

## B4 — proposeBinding + verification probes (2026-08-27)

The LLM mapping call and the probe set that judges what it produced. Probes
run against views BUILT from the binding on the live dataset, in a scratch
schema.

### Reproduce

```bash
node scripts/test-replenishment-probes.js zolstock   # builds real views; ~20 min
```

### Result

| Battery | Result |
|---|---|
| `test-replenishment-probes.js` | **15/15 PASS** |
| Regression: insights-unit · schema-contract · stage2 · stage3 · modules-unit · replenishment-render · replenishment-unit | 53/53 · 19/19 · 30/30 · 35/35 · 29/29 · 47/47 · 63/63 |
| Leftover scratch schemas in the data DB | **none** |

### Probes on the correct ZolStock binding — measured on live data

| Probe | Measured |
|---|---|
| `views_exist` | 2/2 present and populated |
| `base_row_count` | **14,762 rows** |
| `grain_is_unique` | 14,762 rows, one per sku, 0 duplicates |
| `reconciles_with_audit` | 14,762 vs 14,762 distinct keys — 0.0% apart |
| `velocity_coverage` | **11,057 of 14,762 (74.9%)** have sales history |
| `demand_join_rate` | 6,142,352 of 27,464,734 demand rows resolve (22.4%) |
| `warehouse_reconciles` | view 4,827,900 of source 4,853,542 units (**99.5%**) |
| `on_order_reconciles` | view 818,382 of source 818,532 (**100.0%**) |
| `committed_reconciles` | view 222,803 of source 223,300 (**99.8%**) |
| `dedup_applied` | 15,180 catalogue rows → 14,762 distinct keys |
| `anchored_to_data_date` | 2026-08-26, one value for every row |
| `supplier_view_covers_base` | 13 suppliers covering all 14,762 rows |

### The verify clause — probes PROVEN able to fail

Five deliberately mis-mapped bindings, each a mistake a model could
plausibly make, each caught by the right probe:

| Mis-mapping | Caught by |
|---|---|
| demand keyed on the replenishment key | `demand_join_rate` — "NO demand row resolves to a keyed item — the demand item key (sku) does not match the catalogue key (item_number)" |
| warehouse stock keyed on the sales key | `warehouse_reconciles` — names the collapse |
| on-order keyed on the sales key | `on_order_reconciles` |
| demand filter pointing at inventory rows | caught |
| catalogue key and replenishment key swapped | caught |

### Four defects this step found in code that already passed every other test

The battery earned its keep; none were visible without building for real.

1. **The orchestrator dropped the scratch schema before verify ran.** A3's
   `buildInScratch` dropped it in its own `finally`, so probes for any real
   module would have queried a schema that no longer existed. Invisible on
   the `_stub`, which renders no DDL at all — exactly the gap a test double
   leaves behind. The schema now lives until after verify and is dropped in
   the round's `finally`.
2. **The renderer used one schema as both build target and data source.**
   Correct on the nightly path (the shadow schema holds a full fresh copy of
   the data) but fatal at init, where the scratch schema is empty: every init
   would have failed with `relation "..._scratch.facts" does not exist`.
   `renderInfra` now takes `{target, source}`; they are the same schema only
   at night, and one stored binding serves both paths.
3. **`reconciles_with_audit` compared rows-carrying-a-key against the view's
   distinct-key grain.** It failed the CORRECT binding at 14,762 vs 15,180
   (2.8%) — it would have blocked every dataset that repeats catalogue keys,
   which is precisely the `catalog_not_unique` quirk the dedup exists for,
   and so would have blocked C1. Now reconciles against distinct keys: 0.0%.
4. **A mis-mapped stock key was not caught at all — the most dangerous.**
   Point warehouse stock at the sales key and its rows all fail the
   `IS NOT NULL` filter, so `warehouse_qty` becomes `COALESCE(NULL,0)` = 0 on
   every row. The view builds, the grain is right, nothing errors, and the
   whole suite went green. In production that reads as *every product has no
   stock*, and the engine confidently recommends reordering the entire
   catalogue. The old probe only checked `view <= source`, and 0 <= 4,853,542
   passes. The check is now **two-directional — inflation AND collapse** —
   and applies to every declared section, since `on_order` and `committed`
   had the identical hole.

### Design notes

- **`proposeBinding` is the only LLM call in the module.** Temperature 0, via
  `services/llm.js` with context key `replenishment_propose_binding`, model
  from settings. Temperature matters most here: the same schema must map the
  same way every run, or a re-init would silently change a customer's numbers.
- **The model is given measurements, not schema text**, plus an explicit
  whitelist of columns that exist. Rule 1 of the prompt is "you do not write
  SQL, you choose column names"; rule 2 is "prefer measured evidence over
  column names" — the audit hands it the join rates, which is the whole basis
  for choosing a key.
- **The binding is structurally validated before any DDL is rendered**, so a
  malformed proposal costs one round with an actionable message rather than a
  database error.
- **On a failed round the model is shown the exact probe failures with their
  numbers**, which is what makes the next attempt a revision, not a re-roll.

---

## C1 — Run init on ZolStock; review the audit ⚠ GATE (2026-08-27)

The first real init: audit → LLM binding proposal → build → verify, against
live zolstock. Converged on **round 1 in 4–5 minutes**, all 12 probes green.

### Reproduce

```bash
node scripts/run-module-init.js zolstock replenishment
```

### Result

| | |
|---|---|
| Run outcome | **succeeded**, round 1 of 5 |
| `client_modules` | `status=ready`, `enabled=false`, binding stored, `init_model=claude-sonnet-4-6` |
| Probes | **12/12** |

Left deliberately at `enabled=false`: init is complete, and switching it on
is the gate decision, not something this step takes.

### The converged binding vs the hand-authored B4 reference

| Field | Reference | Converged | Verdict |
|---|---|---|---|
| `demand` | facts / qty_sold / row_date / item_number_sales / `record_type='sales'` | identical | ✅ |
| `stock.warehouse` | warehouse_qty / sku | identical | ✅ |
| `catalog` | items / item_number / sku / **positive_supplier** | identical | ✅ |
| `onOrder`, `committed` | purchase_order_qty / customer_order_qty on sku | identical | ✅ |
| `stock.store` | omitted in the reference | **included** | Better than the reference — the data exists, and it changes nothing today because `includeStoreStock` defaults false |
| `quirks` | 6 declared | **3 declared** | Missing `catalog_not_unique`, `vat_1_18`, `supplier_col_reversed_latin` — see below |

**The model chose `positive_supplier` over `supplier` on its own** — i.e. it
avoided the exact trap the existing sales MVs had been sitting in for months
(fixed separately in C2). It could do that because the audit hands it
*measured* facts rather than column names.

### The defect this step found: quirk-gated probes let the model shrink its own scrutiny

The model did not declare `catalog_not_unique`, and `dedup_applied` was gated
on that quirk — **so the probe silently did not run**. The dedup itself still
happened (the template applies it unconditionally) and `grain_is_unique`
covered the outcome, so nothing was wrong with the data. The problem is
structural: a binding could reduce the amount of verification applied to it,
by omission, with no signal.

Fixed: probes that check an invariant the template **always** enforces
(`dedup_applied`, `anchored_to_data_date`) now run unconditionally. A quirk is
a description of the data, never a switch for how hard we look. Re-run
confirms 12/12 with `dedup_applied` back:
`catalogue has 15,180 keyed rows over 14,762 distinct keys; view has 14,762 rows`.

### Two more defects found on the first real init

1. **The binding prompt's column whitelist was narrower than the roles it had
   to fill.** It was assembled from pattern-matched columns only, so the
   quantity columns (`qty_sold`, `warehouse_qty`, `purchase_order_qty`, …)
   were never in it — and the model duly returned a binding with no `qtyCol`
   anywhere, having been told to name no others. The audit now reports every
   column of the fact and catalogue tables with its type, and the whitelist
   uses that. A whitelist narrower than the roles it must fill is a trap, not
   a guard.
2. **A rejected proposal aborted the entire run instead of costing one
   round.** Structural validation catches a malformed binding in ~1s with
   errors naming exactly which fields are wrong — the most actionable
   feedback the loop can carry — and the first real init died on round 1 with
   a perfectly recoverable `demand.qtyCol is required`. A rejected proposal is
   now a round failure that feeds its errors forward.

### FOR THE GATE — what needs a human decision

1. **Scope.** Only **2 of 446 suppliers** have catalogue coverage you could
   order against (`ב.א. זול סטוק והפצה בע"מ` 83.5%, `ארכיון ב.א` 58.3%);
   13 more have a token handful, often 1 item of 16,648. The plan's own
   instruction is to re-scope rather than ship a screen that recommends
   nothing. This independently confirms the feasibility brief's
   one-supplier pilot.
2. **The missing quirks.** `vat_1_18` and `supplier_col_reversed_latin` only
   affect the wording of caveats, but their absence means some honest
   warnings would not appear. They are properties of the dataset rather than
   judgement calls, so the open question is whether the model should be
   declaring them at all, or whether they belong in the manifest.
3. **No goods-receipt data** (audit A6) remains the largest correctness
   threat: lead time can never be measured, and an order placed long ago
   still looks open, so supply is over-counted and the system under-orders.

---

## C2 — Sales-view supplier fix (2026-08-27)

### The bug

`ITEM_DIM` in `scripts/create-zolstock-mvs.js` selected `items.supplier` —
the **manufacturer/importer**, whose Latin values are stored
character-reversed in the export (`'GNIDART SBD'` is "DBS TRADING") — under
the name `supplier`. Every "sales by supplier" answer therefore grouped by
the wrong dimension **and** displayed reversed text.

### The fix

On the views, `supplier` is now `items.positive_supplier` (the supplying
company a buyer orders from); the old value remains available as
`manufacturer`. `sku` is propagated too, so a sku-based question can be
answered from the sales views without bridging through `items`.
`services/schema-rules/zolstock.rules.js` documents the changed semantics —
without it the SQL generator would keep treating `supplier` as the
manufacturer.

| Check | Result |
|---|---|
| `test-schema-contract.js` | **19/19** |

The date-literal scanner caught a hardcoded date in the new rules text and
was right to — a data-end claim rots on every reload — so the sentence states
the policy without one.

**OUTSTANDING:** the MV change only takes effect when the views are rebuilt,
i.e. on the next full reload. Not run here (Phase 1/2 are run by hand by
whoever owns the infra).

---

## C3 — supplier_settings + service (2026-08-27)

Migration 041 (platform DB), the Drizzle definition, and the resolution
service: **supplier override → dataset default → code constant**, every value
tagged with the level it came from.

### Reproduce

```bash
node db/migrations/run-041-add-supplier-settings.js
node scripts/test-supplier-settings.js
```

| Battery | Result |
|---|---|
| `test-supplier-settings.js` | **20/20 PASS** |

### Why the source tags exist

The client screen says "90 days — you set this" versus "90 days — default,
set it", and a buyer who cannot tell those apart cannot judge the
recommendation built on top of them. Every override column is nullable on
purpose: NULL means "not set" and falls back, which is how a buyer *un-sets*
a lead time — a copied-down default would be indistinguishable from a real
choice. A deliberate `0` is still a real value, and that is asserted.

### OUTSTANDING — the reload-survival confirmation

The plan's C3 clause is "upsert a lead time, run a full zolstock reload,
confirm it survived". Triggering the data loader is not this session's to do.
What is proven instead is the structural fact that check exists to confirm:
the row lives in `agents_platform_db`, which a dataset reload never touches,
and **nowhere inside a dataset schema** — both asserted directly (§3). The
live reload remains an outstanding confirmation for whoever runs Phase 1/2.

---

## E1 + E2 — Nightly build hook and the outbox provider (2026-08-27)

The reload's phase 2 gains one call: each live module re-renders its
infrastructure from its stored binding into the SHADOW schema, after the
dataset's own indexes and MVs and **before the atomic swap**, so a module's
views arrive with the swap as one unit.

### Reproduce

```bash
node scripts/test-modules-nightly.js
```

| Battery | Result |
|---|---|
| `test-modules-nightly.js` | **29/29 PASS** |
| Client typecheck / lint delta | PASS / **0 new errors, 0 new warnings** |
| Regression (8 batteries) | 29/29 · 41/41 · 47/47 · 63/63 · 19/19 · 53/53 · 30/30 · 35/35 |

### The three states the plan names, all asserted

| Plan clause | Evidence |
|---|---|
| "with the module disabled, the reload path is asserted byte-identical to today" | §1 — nothing built, **no log line emitted into the reload output**, and no schema created or touched |
| "builds module views in shadow and swaps clean" | §2 — `mv_replenishment_base` (14,762 rows) and `mv_suppliers` both land populated in the shadow schema, built in 29s |
| "a forced module-build failure degrades the module, notifies, and the reload still completes" | §3 — the hook does not throw, the module is marked `degraded` and stops being live, and a `nightly_build_failed` row lands in the outbox addressed to the configured emails |

Beyond those: §4 asserts a degraded module **recovers to ready** on the next
clean build — stale-but-correct beats gone, and the state has to clear itself
or a single bad night would need manual intervention forever.

### Why a module can never fail a reload

The reload is the platform's most important scheduled job and every dataset
depends on it. An optional module breaking it would be a catastrophic trade,
so a failed module build degrades the module and lets the swap proceed; the
module keeps serving its last good build. Even the *lookup* of module state is
wrapped — if the platform DB is unreachable mid-reload, the dataset's own
build is unaffected and must continue. Same log-and-surface philosophy as
`reload-freshness`.

### The defect this step found: a settings field that could not be set

`test-modules-nightly` §5 caught `notificationEvents` — the per-event on/off
map — being dropped on save with
`ignoring unknown settings keys: notificationEvents`. The descriptor declared
`notificationEvents` at the **module** level (the events it can emit) but
never as a **settings field**, so `saveSettings` correctly refused the unknown
key and the toggles in the admin mockup could never switch anything off. The
guard was doing its job; the feature simply did not exist. A guard working is
not the same as a feature working.

Fixed on both sides: the field is declared with a new `event_toggles` type,
and the admin tab renders a checkbox per event **the module itself declares**,
so the list cannot drift from what is actually sent. Absent means ON, matching
the server, because a UI that disagreed with the server about the default
would be worse than no UI.

### OUTSTANDING

A real end-to-end reload (Phase 1/2) is run by hand by whoever owns the infra
and remains the final confirmation for **E1** (views arrive through a genuine
swap), **C2** (the supplier-column fix only takes effect when the views are
rebuilt) and **C3** (a lead time survives a reload).

---

## D1 — Recommendations API (2026-08-27)

The read path: prepared view + settings chain + engine, behind module-scoped
routes.

### Reproduce

```bash
node scripts/test-replenishment-api.js
```

| Battery | Result |
|---|---|
| `test-replenishment-api.js` | **34/34 PASS** |

### The verify clause

| Plan clause | Evidence |
|---|---|
| "a supplier with no settings answers with `leadTimeSource: 'dataset_default'`" | §2 — and it inherits the 90-day value |
| "module disabled ⇒ 404 on recommendation routes" | §0 — and enabled-but-not-ready 404s **separately**, with a different message, because "never initialized" and "switched off" are different problems for whoever has to fix them |

### First real recommendations, on live zolstock data

| | |
|---|---|
| Rows | **9,275** |
| Order now (overdue) | **4,568** |
| Due within 14 days | 131 |
| Stocked OK | 4,039 |
| No recent sales | 537 |
| Estimated total ex-VAT | **₪4,601,165** |
| Suppliers | 13 (top: ב.א. זול סטוק והפצה בע"מ — 12,101 skus, 8.4M units/yr) |

### WORTH A DECISION: 49% of the catalogue reads as overdue

That is not an engine fault — it follows directly from the **90-day default
lead time**. At 90 days you must order three months before running out, so
almost anything not sitting on a large buffer is already late. It is the
feasibility brief's **R2 (alert fatigue)** risk with a number attached: a
list of 4,568 items is one a buyer opens once.

Two things follow, and both were already in the brief:
1. Real per-supplier lead times are not a nicety — they are the condition
   under which the list means anything.
2. The eventual push phase must cap the digest and apply a confidence
   threshold. "Nothing needs ordering today" is a valid and trust-building
   output; 4,568 rows is not.

### Design notes

- **Aggregate nightly, compute on read.** The 27M-row scan happens once a
  night inside the reload; request time reads ~15k prepared rows and does
  simple arithmetic. Freezing the *result* into a daily snapshot instead
  would mean a buyer editing a supplier's lead time sees no change until
  tomorrow — and the lead time is the one input they own. §3 asserts an
  override changes the answer immediately.
- **Summaries describe the whole set, never the filtered page.** A tile that
  counted only visible rows would be a different, wrong number — asserted in
  §6 for both `onlyDue` and `limit`.
- **Every row carries its working**: inputs, the source of each parameter,
  and `notes[]` in words (§5).
- **Writing a lead time is gated by the module's own `clientCanEditLeadTimes`
  setting**, defaulting to editable — the buyer owns lead times and is the
  person who knows them. Dataset-level defaults stay super-admin only.

---

## D2 — Client situation page + nav links (2026-08-27)

`/intelligence/:datasetId/purchasing` — three tabs sharing one anatomy:
summary tiles → a master table whose parent rows (suppliers) expand into
child rows (items) → a "How we calculated this" trust panel on every leaf.

### Reproduce

```bash
# server + client dev servers, then:
#   http://localhost:5173/intelligence/zolstock/purchasing
npx tsc -b && npx eslint .    # in the client repo
```

| Check | Result |
|---|---|
| Client typecheck | **PASS** |
| Lint delta vs the A0 baseline | **0 new errors, 0 new warnings** |
| i18n coverage | **54 keys, every one present in BOTH locales** (asserted) |
| English render | verified headless against live data |
| Hebrew + RTL render | verified headless — full mirrored layout, `direction: rtl` |
| Trust panel | verified — inputs with sources, derivation, 4 caveats in words |

### Verified against live data in a real browser

Screenshots taken headless through CDP against the running dev servers, with
the module's views built into the live schema (what the E1 hook does on every
reload). Real numbers: 13 suppliers, 5,142 order-now, 104 due soon, 3,492 ok,
537 no demand.

- **Purchasing tab** — banner naming how many suppliers have a real delivery
  time, four tiles, supplier rows with the `default — set it` badge and Edit,
  expanding into urgency-sorted item rows each carrying one plain-language
  sentence and a `Why?`.
- **Trust panel** — sales pace / in stock / on the way (flagged *may already
  have been delivered*) / reserved / delivery time (*assumed default*) /
  safety buffer (*computed from sales pace*), the derivation sentence, and
  every caveat quoted from the server's `notes[]` rather than re-worded here.
- **Hebrew** — whole layout mirrors, all 54 strings translated, `dir=rtl`
  confirmed on the document.

### Two defects the real screen exposed that no test had

Both are the reason the plan says to look at it rather than trust a green
suite.

1. **"stock covers −5,400 days, this order should have gone out on
   2011-08-15."** A negative availability divided by a slow-moving item's
   velocity produces a hugely negative cover and an order-by date a decade
   in the past. Arithmetically implied by the formula; useless as a
   statement — nobody can act on "you should have ordered in 2011", and it
   made the whole screen look broken.
   **Fixed in the engine:** *quantity* may still be negative and is reported
   as such (edge case 3 is unchanged), but *time* is clamped — cover is 0,
   the order-by date is one lead time ago, lateness reads **91 days** instead
   of 5,491, and a new note says "Nothing is available to sell right now —
   this order is already overdue by the full delivery time." Asserted by four
   new checks in the engine battery (now 67/67).
2. **"SALES PACE 0 / day"** next to "Order 10 units." Most of this catalogue
   moves slowly — 4 units in 90 days is 0.044/day, which one decimal renders
   as zero. "It sells zero per day, order ten" is not a sentence a buyer can
   trust. Small rates now keep enough digits: the same row reads **0.022 /
   day**.

### Design notes

- The nav item renders **only when the module is enabled AND ready**, resolved
  from the public module-status endpoint. Switching the module off removes the
  page from the navigation with no separate config to keep in step. The route
  always resolves, so a stale bookmark lands on the shell rather than a broken
  page.
- Caveats are **quoted from the server**, never re-worded on the client — the
  screen, the chat tool and the report must not phrase the same caveat three
  slightly different ways.
- Editing a lead time is a **modal**, and an empty value CLEARS the override
  rather than storing 0 — that is how a buyer un-sets it. On save the page
  re-fetches rather than patching locally, because changing a lead time moves
  every date and status for that supplier and recomputing here would be a
  second implementation of the engine.
- **Warehouse and Branches ship visible but phase-gated**, each explaining in
  plain words what it will show and what is missing — the Branches copy names
  the real blocker (branch stock arrives without item codes) rather than
  showing invented numbers.
- CSV export carries the sources and caveats, not just the numbers: a buyer
  takes it into a purchase order, and a figure without its basis is not usable
  there. A BOM is prepended so Excel opens the Hebrew item names correctly.

### State left behind

`mv_replenishment_base` and `mv_suppliers` now exist in the **live** zolstock
schema — built by hand here because triggering the loader is not this
session's to do; the E1 hook rebuilds them on every reload from the same
stored binding. The module is left `status=ready, enabled=false`: init is
done, and enabling a client-facing surface is a decision, not a side effect
of testing. No supplier_settings rows remain.

---

## D3 — Chat tool + schema rules + manifest fragment (2026-08-27)

### Reproduce

```bash
node scripts/test-replenishment-chat.js
```

| Battery | Result |
|---|---|
| `test-replenishment-chat.js` | **43/43 PASS** |
| Regression (8 batteries, after touching the dispatcher, manifest and rules) | 19/19 · 30/30 · 35/35 · 53/53 · 29/29 · 41/41 · 47/47 · 67/67 |

### The assertion that matters

**The same question asked five different ways returns identical numbers.**
Five argument shapes a model could plausibly produce for "what should we
order" all land on the same computation — same counts, same total, the
identical most-urgent row, anchored to the same data date — and repeating a
call is byte-identical. That invariance is the entire reason this is a
structured tool and not a prompt: a model writing SQL for a reorder question
produces a slightly different query, and therefore slightly different
numbers, every time.

### Tool registration follows the live gate

| Check | Result |
|---|---|
| Module off ⇒ no tool attached, crew keeps exactly what it had | OK |
| Module live ⇒ `fetch_replenishment` attached **alongside** the crew's own tool | OK |
| …carrying a working handler | OK |
| Switching the module off removes the tool on the **next turn** | OK |
| A crew with no `datasetSchema` is untouched | OK |
| A name collision is refused, never silently overridden | OK |

The attach point is in the dispatcher, deliberately **before** the tool
handler map is built — attaching after it would hand the model a tool schema
with no handler behind it. It is idempotent and reversible, so a module
switched off between turns leaves nothing behind rather than lingering until
a restart.

### The honesty layer, and where each piece belongs

A judgement worth recording: **the goods-receipt absence went into the
DATASET manifest, not the module's fragment.** That absence is a property of
the client's feed and stays true whether or not any module is switched on — a
refusal that only appears when a module happens to be enabled is not an
honesty layer. The module's fragment carries only what exists *because* the
module exists: the two derived measures, the new `configured` dimension
status for a lead time a human supplied, and the Hebrew/English vocabulary.

Refusals verified in both languages, with precision preserved:

| Refused | Still answerable |
|---|---|
| "when did purchase order 4471 arrive" | "when did we order sku BH-34-240" |
| "מתי הגיעה ההזמנה" | "מתי הזמנו את הפריט הזה" |
| "what is the goods receipt date for sku …" | "how many open purchase orders are there" |
| "מתי התקבלה הסחורה" | "כמה הזמנות רכש פתוחות יש" |

The refusal names the missing data and offers what *is* answerable instead.

### A trigger that missed by one character

`when did purchase order 4471 arrive` sailed straight through to SQL
generation. The trigger allowed `.{0,20}` between the verb and the arrival
word; that phrase has **21**. Sized for a word rather than a phrase, it let
exactly the question it existed for through. Widened to `.{0,40}?` and
asserted. The Hebrew triggers were correct throughout.

Three of the four "failures" in the first run were my own assertion being
wrong — the gate returns `{action:'refuse', refusal:{…}}`, not a `refuse`
flag — but the fourth was real, and a suite written to the wrong shape would
have hidden it.

### Schema rules

The hand-written "compute need from stock vs open orders vs safety stock"
recipe is **removed**. Generated SQL must not attempt the reorder arithmetic:
it depends on a supplier delivery time that is not in the database at all
(a human configures it), on carton rounding, on a safety-stock fallback, and
on windows anchored to the data's last date. A query cannot reach the first
of those, so any SQL answer to a reorder question is wrong in a way that
looks right — worse than refusing. The rules now name the tool and say why.
The item-grain fact-scan ban survives unchanged.
