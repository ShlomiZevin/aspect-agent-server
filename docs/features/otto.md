# Otto — client-built custom screens

Otto lets a client's own users build operational screens on their real data
by talking: chat → structured plan → approval → build. Built 2026-09-14 on
`vl_us_otto_intelligence_integration` (both repos); full decision record in
`tasks/pending/otto-intelligence-integration.md`, mockups in
`docs/design/otto-v2/`.

v1 (the standalone demo-data page that generated raw HTML into an iframe,
commits `32f8bcc`/`1f08e90`) is fully replaced. Its `provider_config` blobs
(`otto_apps_*` keys) are obsolete demo artifacts — discarded, not migrated.

## The three ideas everything rests on

1. **The model never writes UI code and never writes SQL.** The build emits
   a JSON **screen spec** (result sets + catalog blocks) validated against a
   whitelist; the server compiles the SQL; the client's own React components
   render the blocks. A screen is native UI — client branding, EN/HE, RTL,
   no iframe — and a block bug fixed once is fixed in every screen ever
   built.
2. **The brief is Otto's whole world.** Enabling the module runs the
   standard init pipeline; its LLM pass writes the *dataset brief* (sources,
   whitelisted fields with bilingual labels, manifest caveats, starter
   suggestions) into the module's `binding`. Conversations, plans, specs and
   compiled queries can reference nothing outside it.
3. **Verified before visible.** Every build ends in probes ("Validating
   totals"): non-empty result sets, no all-NULL numeric columns (the
   silent-zero class), and a KPI cross-check — the SQL aggregate over the
   full set vs a JS re-computation over the delivered rows, two genuinely
   different computations of the same number. A failed probe feeds back into
   one more compose round; a failed build leaves the previous spec
   untouched.

## Where the code lives

| Path | Responsibility |
|---|---|
| `modules/otto/module.js` | the module descriptor (registry #5); enablement = the per-client "can build screens" switch |
| `otto/services/brief.service.js` | audit (schema scan), knowledge pass (LLM → brief), structural validation, verify probes, prompt rendering |
| `otto/services/spec.contract.js` | THE contract: plan + spec validation, block kinds, enums. The client mirrors its shapes in `src/types/otto.ts` |
| `otto/services/expressions.js` | the tiny grammar (arithmetic + one comparison) — parsed once, rendered to SQL *and* evaluated in JS |
| `otto/services/compiler.service.js` | result-set/KPI declarations → schema-qualified, quoted, LIMIT-capped SQL |
| `otto/services/data.service.js` | execution under `statement_timeout` + per-reload cache; the ONLY data path a screen has |
| `otto/services/probes.service.js` | build verification |
| `otto/services/build-job.service.js` | the build as a polled DB-backed job (`custom_module_builds`) |
| `otto/services/brainstorm.service.js` / `plan.service.js` / `spec.service.js` | the three calls: Sonnet talks and plans, **Opus 5 builds** (owner decision) |
| `otto/services/screens.store.js` | CRUD over `custom_modules`; status flow draft → ready → active |
| `otto/services/doc-store.service.js` | generic JSONB doc store for future user-typed data (schema ships, no v1 block writes) |
| `otto/services/gate.middleware.js` | every route 403s unless module `otto` is live for the dataset |
| `db/migrations/054_custom_screens.sql` | `custom_modules`, `custom_module_builds`, `custom_module_data` (platform DB) |

Client: `src/components/intelligence/Apps/custom/` — `OttoBuilder` (the
three-panel page: chat rail / status panel with the animated `OttoFigure`
Orb / canvas), `ScreenRenderer` + the block catalog (kpiCards, filterBar,
dataTable, chart via `InsightChart`, actionsBar, noteLine),
`CustomScreenPage` (published screens), `CustomScreenRouter` (status →
surface). `src/services/ottoService.ts`, `src/types/otto.ts`, `otto.*` keys
in `translations.ts` (both locales).

## Surfaces and flow

- **Apps shelf**: with the module live, `apps.service.js` adds
  `canCreate: true` + `custom[]` to the payload — the dashed "New screen —
  with OTTO" tile and the client's screens (drafts carry an amber dot,
  visible to everyone in the client, decision D5). With the module off and
  zero screens the payload is **byte-identical** to the pre-Otto shelf
  (unit-asserted).
- **Builder** at `/intelligence/:datasetId/apps/new`; the draft row exists
  from the first exchange and the URL swaps to `/apps/<id>`, so a closed tab
  loses nothing. Clicking a draft tile reopens the conversation mid-thought.
- **Build** runs server-side; the page polls and registers a shell task, so
  the header pill shows the same progress and survives in-app navigation.
- **Save to Apps** → confirm dialog ("visible to everyone in your
  organization") → `status: active` → the same URL now renders the published
  page. Published screens are frozen: no edit, no client delete (super-admin
  removal only). Draft delete is hard.

## Guard rails (structural, not policed)

- The browser has **no query surface** — screens receive rows from
  `GET /screens/:id/data`, which executes the STORED spec only.
- Compiled SQL: schema-qualified, identifier-quoted, `LIMIT` ≤ 2000,
  divisions NULLIF-guarded, 15s `SET LOCAL statement_timeout`.
- Heavy relations (> 5M rows — ZolStock's facts) can never be a source
  unless they are a view/matview; the flag is **measured**, never proposed.
- Result payloads are cached per (screen × completed import) — a screen
  opened 200 times costs one query run per nightly reload.
- Caveats are QUOTED from the brief (which quotes the manifest) — the
  noteLine block cannot carry text the brief doesn't.

## Verification

- `node scripts/test-otto-unit.js` — offline battery (80 checks): grammar,
  brief/plan/spec validation, compiler SQL, probes, progress monotonicity,
  descriptor, shelf byte-identity.
- `node scripts/test-otto-knowledge.js <ds> [--propose]` — audit + brief
  re-validation against the live schema (the stale-names check); `--propose`
  runs the full LLM pass.
- `verification/otto-integration/` — the run records.

## Known limitations & leftovers (v1)

- Filters are client-side over delivered rows; a result set capped at its
  LIMIT states so in the table foot, and KPIs are full-set SQL values
  regardless.
- KPI cards do not react to filter selections (deliberate: verified totals
  don't quietly shrink); a per-filter KPI needs an aggregate result set.
- `chart` renders line/bar only; `exportCsv` and `stub` are the only
  actions. Extending = one block/action type in `spec.contract.js` + one
  renderer branch.
- The shelf's `custom` section and gate mean Otto-off datasets are
  untouched, but `hasApps()` now also returns true when only `canCreate` is
  set — the Apps tab appears for a client with Otto and no other app module.
- ProcurementPage was NOT refactored onto the shared blocks (assessed too
  entangled for a safe extraction this round — see the task file §12 Q1
  resolution and verification README); the catalog components are new,
  styled to match it.
