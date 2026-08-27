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
