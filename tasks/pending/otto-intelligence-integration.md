# Otto → Intelligence integration — custom screens as a first-class, per-client feature

> **Source of truth:** the working session of 2026-09-13/14 (analysis of Otto v1
> on both repos + architecture discussion) and the five UI mockups in
> `C:\Users\vlyah\Downloads\Purchase feature redesign\Ottos` (referenced below
> as M1–M5; copy them into `docs/design/otto-v2/` as step 0 of implementation
> so the spec is reproducible after the Downloads folder is gone).
>
> Status: **awaiting approval — do not implement until the owner signs off.**
> Open questions are in §12; everything else is proposed as decided.
>
> Branches: `vl_us_otto_intelligence_integration` on both repos.

## How to use this document

**Human:** §01 is the decision list — read that first. §02–§07 are the design.
§10 is the phased plan with verify gates. §12 is what still needs your answer.

**Claude Code session:** read first — server `CLAUDE.md`, client `CLAUDE.md`,
`docs/features/modules.md`, `docs/features/replenishment.md` §chat-scope,
`otto/` (all of it), `src/pages/OttoBuilderPage.tsx`,
`src/components/intelligence/Apps/*`, `modules/services/apps.service.js`,
`services/dataset-manifest/zolstock.manifest.js`. Then execute §10 one phase at
a time; do not start phase N+1 until phase N's verify clause passes. Record
results in `verification/otto-integration/` with a README.

---

## 00 · Context — what exists and why it changes

Otto v1 (`otto v1`, commit `32f8bcc` + fix `1f08e90`) is a working prototype of
"describe a screen in chat → approve a plan → get a built screen":

- Server `otto/`: brainstorm (Sonnet 5) → plan (Sonnet 5) → build (Opus 5
  writes ~13KB of free-form HTML), SSE build progress, saved screens as one
  JSON blob per dataset in `provider_config`.
- Client: one 900-line `OttoBuilderPage.tsx` on a hidden, unlinked route
  outside `IntelligenceShell`.

What is wrong with it as a product surface — each item below is a work item in
this spec:

| # | Defect | Fixed by |
|---|---|---|
| 1 | Saved screens go nowhere — the Apps shelf never reads them; the save dialog's promise is false | §03 storage + §05 shelf |
| 2 | Zero auth on `/api/otto/*` — anyone can burn Opus tokens or read/write any dataset's screens | §04 gating |
| 3 | Page unreachable (no link), outside the shell — no nav, no branding, no language toggle | §05 |
| 4 | Screens built on a hard-coded **fake demo dataset**, whatever the `:datasetId` | §02 knowledge pass + data layer |
| 5 | Hebrew hard-coded everywhere: prompts, server error strings, all client strings | §06 |
| 6 | Client conventions bypassed (raw `fetch`, no service module, own font injection) | §05 |
| 7 | Free-form generated HTML = unverifiable UI, new bugs per build, iframe sandbox required | §02 spec + catalog |
| 8 | Prototype storage: `provider_config` blob, 50-cap, `createdBy: 'demo'` | §03 |
| 9 | Repo litter: `otto-models.py`, `otto-out.html` in server root; unused character renders in client `public/otto/` | §08 |
| 10 | `IntelligenceShell` hard-codes `appId === 'replenishment'` — no other app id can render | §05 |

What is RIGHT about v1 and is kept unchanged in spirit: the three-call machine
(brainstorm / plan / build as separate calls, per BUILDER_V2 decisions 51–52),
the plan as the human approval gate, revision-not-redraw on changes, honest
streamed progress, and Otto the character (deliberate owner override —
`scripts/generate-otto-figure.js` header; the figure survives, in the new form
shown in the mockups).

---

## 01 · Locked decisions (from the working session + mockups)

- **D1 — Otto is registry module #2** (`id: 'otto'`, group **not** `'apps'` —
  it is a builder, not a shelf tile of its own). Per-client on/off = the
  existing `client_modules` machinery and the existing super-admin Modules tab.
  No new toggle infrastructure. "Client can create custom screens" ≡ module
  `otto` is live (`enabled AND status='ready'`) for that dataset.
- **D2 — The model never writes UI code and never writes SQL.** The build
  emits a validated **screen spec** (JSON); a hand-written React renderer +
  block catalog draws it; a server-side compiler turns declared result sets
  into SQL through the existing whitelisted machinery. This supersedes the
  free-HTML path (see §12 Q1 — it deviates from the `html` column in the
  approved DDL, deliberately).
- **D3 — Real client data from day one.** Enabling Otto for a client runs an
  **init pipeline** (existing module-init orchestrator) whose LLM pass builds
  Otto's *dataset brief*: what the client's schemas/views/manifest expose, in
  the vocabulary Otto's brainstorm and plan prompts consume. M5 shows real
  ZolStock rows; M4 shows "Querying the data" and "Validating totals" as build
  stages.
- **D4 — Draft lifecycle** (owner's flow, confirmed by M1–M5):
  created-as-draft after the first exchange → visible on the Apps shelf as a
  draft tile to everyone in the client → clicking a draft opens the edit
  (builder) screen → "Save to Apps" publishes → redirect to the app's own
  page → published apps are **not editable for now**. Edit screen offers:
  delete, stay-as-draft (implicit — drafts autosave), Save to Apps.
- **D5 — Client-level visibility, no per-user scoping.** Everyone in a client
  sees all of that client's drafts and apps. `created_by` is stored for later.
- **D6 — Native rendering, no iframe.** Published screens are pages inside the
  shell exactly like Procurement: client branding (`--ai-*` via `data-brand`),
  RTL/LTR, both locales, mobile behavior — inherited by construction.
- **D7 — i18n everywhere**: Otto UI strings via `i18n/translations.ts` (both
  locales), chat mirrors the user's language (the CLAUDE.md "mirror the
  prompt" rule, verbatim — both failure directions are documented), and every
  generated label in a screen spec is bilingual `{en, he}` so one screen
  renders in both languages.
- **D8 — Storage as agreed in the session** (§03): platform DB, two tables;
  plan + spec are the durable source, rendered data is disposable/cacheable;
  user-typed data (future) goes to the generic document store, never a dataset
  schema.
- **D9 — Guard rails are structural, not policed** (§07): the screen has no
  query power; heavy work is precomputed/cached; every build is verified by
  probes before it reaches "Ready for review".

---

## 02 · Architecture

### 02.1 Otto as a module

`modules/otto/module.js` — a standard descriptor (both locales, all hooks; the
registry refuses less at boot):

- `audit(ctx)` — read-only scan: schemas, views/MVs + row counts, manifest
  presence, sample values for key dimensions. No LLM.
- `proposeBinding(ctx)` — the **knowledge pass** (LLM): from the audit +
  manifest, produce Otto's *dataset brief*, stored as the module's `binding`
  (the framework's durable per-dataset state — same slot replenishment uses):
  - `sources[]` — human-named data sources ("Stock file (warehouse +
    branches)", "Safety levels" — M3's SOURCES chips), each mapped to the
    real relations/views it reads, with row-count scale flags (a 30M-row
    relation is marked `heavy: true` → §07).
  - `fields[]` — the whitelisted field vocabulary: id, `{en,he}` label, type,
    source, aggregation defaults, join keys incl. `dedupeOn` where the
    manifest/rules say so.
  - `caveats[]` — quoted from the manifest, never re-worded (the client rule:
    screen, chat tool and report must not phrase one caveat three ways). M5's
    "Snapshot only — no history and no receipt dates…" line is one of these.
  - `starters[]` — 3 dataset-relevant example screens, bilingual (M1/M2's
    quick-start chips).
- `renderInfra` — no-op in v1 (no per-module views yet; precompute lives in
  §07.3's cache). Returns empty DDL.
- `verify(ctx)` — probes the brief: every relation/field it names must exist
  (same class of check as `test-schema-contract.js`); a broken mapping fails
  the init round and feeds back, ≤5 rounds as usual.
- `nightlyBuild(ctx)` — refreshes the screen-data cache (§07.3) after the
  swap; wrapped, can only mark `degraded`, never fails the reload.
- `chatTools` / `manifestFragment` — none in v1.

Init runs from the existing admin tab with its existing progress polling. This
is the "extra LLM pass at the moment Otto is turned on" the owner asked for.

### 02.2 The screen spec (replaces generated HTML)

One JSON document, versioned (`specVersion: 1`), validated server-side against
a strict schema before it is ever stored or rendered. Shape (abridged):

```jsonc
{
  "specVersion": 1,
  "title": { "en": "Safety Stock", "he": "מלאי ביטחון" },
  "summary": { "en": "…", "he": "…" },
  "icon": "box",
  "note": { "caveatIds": ["snapshot_only"] },      // rendered from binding.caveats, quoted
  "resultSets": [                                   // declared, compiled server-side
    { "id": "rows", "source": "stock", "fields": ["store","item","category","supplier","qty","safety"],
      "computed": [{ "id": "shortfall", "expr": "safety - qty - on_order", "label": {"en":"Shortfall","he":"חוסר"} }],
      "filterBy": ["category","supplier"], "orderBy": "shortfall desc", "limit": 500 }
  ],
  "blocks": [                                       // catalog only — unknown kind = validation error
    { "kind": "kpiCards", "cards": [ { "id":"belowSafety", "label":{"en":"Rows below safety","he":"…"},
        "from":"rows", "agg":"countWhere", "where":"shortfall > 0", "sub":{"en":"store × item combinations","he":"…"} } ] },
    { "kind": "filterBar", "from": "rows", "filters": ["category","supplier"] },
    { "kind": "dataTable", "from": "rows", "columns": [...], "sortable": true, "pageSize": 50 },
    { "kind": "actionsBar", "actions": [ { "id":"export", "type":"exportCsv", "from":"rows", "label":{...} },
        { "id":"po", "type":"stub", "label":{...} } ] }
  ]
}
```

**Block catalog v1** — built by REUSE, not from scratch (owner directive
2026-09-14: the system's existing UI components should be enough; make them
reusable and stable). The inventory, verified in the codebase:

| Block | Source | Work |
|---|---|---|
| `dataTable` | ProcurementPage's sortable/filterable table (1.2k-line page) | **extract** into a shared component; ProcurementPage switches to it (so the one implementation stays battle-tested by the live module) |
| `kpiCards` | ProcurementPage summary cards / M5's cards | **extract** same way |
| `filterBar` | ProcurementPage's selects | **extract** same way |
| `chart` | `Insights/InsightChart.tsx` + `MiniChart.tsx` (proven) | **wrap** — promoted into v1 since it already exists |
| `rankedList`, `statCallout`, `comparison` | `Insights/Blocks.tsx` — the platform's EXISTING spec-driven `BlockRenderer` (model-chosen blocks, our components — the exact pattern Otto needs, already in production) | **adopt**, spec field names aligned |
| `actionsBar`, `noteLine` | — | **new**, trivial |

This covers M3–M5 exactly (SOURCES/FILTERS/COLUMNS/KPIS/ACTIONS map 1:1) and
more. The extraction is a refactor with a hard gate: ProcurementPage must be
pixel-identical after it (its module.css stays the styling source). A request
the catalog cannot express gets an honest "beyond what I can build safely" in
the chat — capability-gate discipline, not silent approximation; §09 adds a
scenario-coverage check so gaps are found before a client finds them.

**KPI/computed expressions are not free code.** `agg` is an enum
(`sum|count|countWhere|distinct|min|max`), `where`/`expr` are parsed by a tiny
expression grammar over declared field ids (comparison + arithmetic only),
evaluated by our renderer/compiler — never `eval`, never model-written JS.

### 02.3 The three calls, re-pointed

- **Brainstorm** (Sonnet): same conversational contract as v1 (1–2 questions
  per turn, concrete phrasings, refuse impossible asks immediately) but its
  system prompt is built from the dataset brief instead of the demo schema,
  and the language rule is the mirror rule (D7). Returns `reply`,
  `readyToPlan`, `state` as today.
- **Plan** (Sonnet): consolidates the conversation into the **structured plan**
  M3 shows: `screen`, `sources[]` (chosen from `binding.sources`), `filters[]`,
  `columns[]`, `kpis[]`, `actions[]`, `notes[]` — every entry bilingual, every
  field id from the whitelist. Revisions produce `changes[]` deltas as v1 did.
  This plan is what the user approves and what is stored as the durable source.
- **Build** (**Opus 5** — owner's call, §12 Q5; chat/plan stay Sonnet 5):
  plan → screen spec. The model chooses composition and labels from enumerable
  sets; a schema-validation failure retries with the error named (structured
  output pattern). This is a small JSON task, seconds not a minute.

### 02.4 Build as a server-side job

M4 shows a global "BUILDING SCREEN 24%" pill in the top nav — the build
survives navigation. Therefore the build is a **server-side job** with polled
progress (the insights-jobs / module-runs pattern), not a page-held SSE:

- `otto_builds` job rows (or reuse of `module_runs` shape — implementer's
  choice, but progress must be stored as stage strings and the percentage
  computed, monotonic by construction, per the modules doc).
- Stages, honest per M4: `reading_plan` → `querying_data` (compile + execute
  each result set) → `composing_screen` (LLM spec build; per-block ticks:
  KPI cards ✓, Filters, Items table, Actions) → `validating_totals` (§07.2
  probes) → `done | failed`.
- The builder page polls; the shell shows the pill from a small React context
  while a build is active for this dataset. Page reload re-attaches by polling
  the latest running build for the draft.

The v1 SSE `/build/stream` machinery is retired with the free-HTML path.

---

## 03 · Storage (platform DB — `agents_platform_db`)

Migration `NNN_custom_screens.sql` + paired `run-NNN-….js` runner, per
convention. Two tables as agreed in the session, with the deviations called
out in §12 Q1:

```sql
CREATE TABLE custom_modules (
  id           TEXT PRIMARY KEY,                  -- 'cm-<random>'
  dataset_id   TEXT NOT NULL,                     -- client scoping
  title        JSONB NOT NULL,                    -- {en, he} — deviation: bilingual, not TEXT
  summary      JSONB,                             -- {en, he}
  icon         TEXT,
  plan         JSONB NOT NULL,                    -- SOURCE of truth (approved structured plan)
  screen_spec  JSONB,                             -- ARTIFACT (deviation: replaces `html`; null until first build)
  conversation JSONB NOT NULL DEFAULT '[]',       -- the chat transcript, so drafts reopen mid-thought
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','ready','active','archived')),
               -- draft: being talked into existence; ready: built, reviewable, still a draft tile
               -- active: published to Apps; archived: soft-deleted published app (future)
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON custom_modules (dataset_id);

CREATE TABLE custom_module_data (                 -- generic doc store for user-typed data (see note)
  dataset_id  TEXT NOT NULL,
  module_id   TEXT NOT NULL,
  collection  TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, module_id, collection, doc_id)
);
```

- The CHECK on `status` for the same reason `client_modules.status` has one:
  it gates what a client sees; a typo must fail at write time.
- `custom_module_data` ships **as schema + a minimal scoped GET/PUT API**, but
  no v1 block writes to it (v1 actions are export-CSV, which is client-side,
  and stubs). It exists now so the first "editable column" request is an API
  call away, not a migration away. The server enforces the
  (dataset, module) scope on every call — one client's screen physically
  cannot touch another's rows.
- The v1 `provider_config` blob (`otto_apps_*` keys) is **discarded, not
  migrated** — it holds demo-data screens whose HTML artifact is obsolete by
  design (§12 Q3 to confirm).
- Rendered result-set data is **not** stored here — it is a cache (§07.3),
  disposable by definition. Nothing user-typed ever goes in a dataset schema
  (drop-and-swap would eat it).

---

## 04 · Server work

New layout — `otto/` stays the feature folder, restructured:

```
otto/
├── module.js                  # the module descriptor (registered in modules/registry.js)
├── routes/otto.routes.js      # rewritten surface, mounted at /api/otto (one line in server.js, as now)
├── services/
│   ├── brief.service.js       # audit + knowledge pass + brief rendering for prompts
│   ├── brainstorm.service.js  # call 1  (from otto.service.js, re-pointed at the brief)
│   ├── plan.service.js        # call 2  (structured plan)
│   ├── spec.service.js        # call 3 + spec JSON-schema validation
│   ├── compiler.service.js    # resultSet declaration → SQL via whitelisted fields; timeouts, caps
│   ├── probes.service.js      # §07.2 verification probes
│   ├── build-job.service.js   # the job runner + progress
│   ├── screens.store.js       # custom_modules CRUD (drizzle; replaces otto-apps.store.js)
│   └── data.service.js        # execute-with-cache for a published/draft screen's result sets
```

Routes (all under `/api/otto`, all behind the **gate middleware**: module
`otto` live for `:datasetId`, else 403 — the one exception is nothing; even
reads are gated, the shelf simply omits the section when the module is off):

| Method | Path | Purpose |
|---|---|---|
| GET | `/:datasetId/screens` | shelf payload: drafts + active, summaries only |
| POST | `/:datasetId/screens` | create draft (first exchange) |
| GET | `/:datasetId/screens/:id` | full record for the builder / renderer |
| PATCH | `/:datasetId/screens/:id` | title/icon edits, conversation append, publish (`status→active`), delete (`archived`/hard — Q4) |
| POST | `/:datasetId/screens/:id/chat` | brainstorm turn (persists transcript) |
| POST | `/:datasetId/screens/:id/plan` | draft/revise the structured plan |
| POST | `/:datasetId/screens/:id/build` | start build job → `{jobId}` |
| GET | `/:datasetId/screens/:id/build/latest` | polled job progress |
| GET | `/:datasetId/screens/:id/data` | executed result sets (cached; the ONLY data path a screen has) |
| GET/PUT | `/:datasetId/:moduleId/data/...` | the generic doc store (minimal, scoped) |

Also: `modules/services/apps.service.js` gains the custom section —
`listApps` returns `{ apps, planned, custom, canCreate }` where `custom` =
this dataset's `custom_modules` rows (summaries) and `canCreate` = otto live.
With otto off and zero rows this payload is **byte-identical to today's** —
the framework's no-module guarantee extended to this feature, and unit-asserted
the same way.

LLM calls: all through `services/llm.js` with `context:
'otto_brainstorm' | 'otto_plan' | 'otto_spec' | 'otto_knowledge'`; models from
`models.service.js` only; per-customer keys (task #61) apply automatically by
going through the router. Server strings (errors included) become
locale-neutral codes + English defaults — the client renders localized text
(v1's Hebrew-only error strings go away).

---

## 05 · Client work (per mockups M1–M5)

### 05.1 Apps shelf (M1)

`AppsPage` gains, when `canCreate`:
- a dashed **"New screen — with OTTO"** tile after the marketplace tiles →
  navigates to `/intelligence/:datasetId/apps/new`;
- custom tiles: drafts show a Draft badge (status `draft`/`ready`), published
  (`active`) look like module tiles. Everyone in the client sees all of them
  (D5). Clicking: draft → builder; active → the app's page.
- With otto off: page renders exactly as today (marketplace + planned only).

### 05.2 Builder page (M2–M4) — `/intelligence/:datasetId/apps/new` and `/apps/:appId` when the app is a draft

Inside `IntelligenceShell` (breadcrumbs `Home / Apps / <title>`), three
panels, the outer two collapsible (`«` in M2/M3):

1. **OTTO rail** (left): avatar + "Screen builder", the 4-step strip
   Chat / Plan / Approve / Build (v1's steps, restyled per mockups), the
   transcript, quick-start chips from `binding.starters`, the structured
   **plan card** (M3: SCREEN / SOURCES / FILTERS / COLUMNS / KPIS / ACTIONS as
   chip rows; Draft · awaiting approval; approve = build), revision chips
   after a build (M5), composer with "Send with Ctrl+Enter" checkbox (no mic
   icon in v1 — §12 Q6).
2. **STATUS panel** (middle): the status card (v1's activity log, condensed:
   current state + checklist with per-step timings — M3/M4 "Request understood
   56s / Plan drafted 57s / Screen built 1:25") and the Otto figure (new
   spherical render — §12 Q2 for the asset).
3. **Canvas** (right): title + inline rename pencil + status badge
   (Draft / Building / Ready for review), empty state with starter chips (M2),
   build progress view (M4: stage list `Reading the plan → Querying the data →
   Composing the screen → Validating totals`, per-block ticks, honest %),
   and after build the **live rendered screen** (M5) with "New screen" +
   "Save to Apps" actions in the header.

Global: the nav **building pill** (M4 top bar) from a small context while a
build job is active; polls, survives in-SPA navigation.

"Save to Apps" → confirm dialog stating the screen becomes visible to
everyone in the organization (§12 Q7) → PATCH `status: 'active'` → navigate
to `/intelligence/:datasetId/apps/:appId` (the published page). Delete lives
in the builder (drafts, hard delete per §12 Q4). Published apps: no edit or
delete entry point for now (D4; removal is super-admin only).

### 05.3 Renderer + published app page

`src/components/intelligence/Apps/custom/` — `CustomScreenPage` (fetches
record + `/data`, renders `ScreenRenderer`) and `blocks/` (KpiCards,
FilterBar, DataTable, ActionsBar, NoteLine). All filtering/sorting client-side
over the delivered result sets, exactly like the v1 generated screens did —
but in our tested components. `IntelligenceShell`'s `appId ===
'replenishment'` branch becomes a lookup: registry app ids → their pages;
anything else resolves against the custom list (draft → builder, active →
`CustomScreenPage`, unknown → shelf fallback as today).

Conventions honored: `ottoService.ts` over `apiRequest` (no raw fetch), every
string through `translations.ts` both locales, `--ai-*` tokens with
`var(--ai-x, var(--fallback))`, hooks above early returns, no
`useAgentContext` anywhere in the subtree, StrictMode-safe effects
(dedupe-by-key refs), `min-width: 0` discipline for the three-panel layout,
mobile pass per the existing intelligence mobile patterns.

---

## 06 · i18n + per-client styling

- UI strings: `otto.*` keys in `translations.ts`, both locales, RTL-safe
  layout. The builder follows the shell's EN/HE toggle live.
- Chat/plan language: the **mirror rule**, stated exactly as CLAUDE.md
  requires (mirror the prompt; Hebrew data values say nothing about the
  requested language; both documented failure directions considered). Verify
  prompt changes in both languages — correctness and language are independent
  failure modes.
- Generated content: every label in plan and spec is `{en, he}` (generated
  once at plan/build time), so one built screen renders fully in either
  locale — including M5's caveat note, which is quoted from the manifest's
  own bilingual text, never re-worded.
- Styling: no Otto theme. `otto/theme/app-theme.css` and the v1 build rules
  about `--otto-*` tokens are retired; blocks use the shell's `--ai-*`
  system, so each client's branding (and the default aspect look) applies by
  construction. The "purple is for actions only" rule survives as a property
  of the block components, where it is enforced once.

---

## 07 · Guard rails — accuracy and DB safety

Structural, in order of the layer they live in:

**07.1 The screen has no query power.** Rendered screens receive result-set
payloads from `/data`; there is no endpoint that accepts field lists, SQL, or
anything shaped like a query from the browser. The compiled SQL exists only
server-side, derived from the stored spec. A malicious or buggy screen cannot
express an expensive query — the API to express it does not exist.

**07.2 Verified before visible.** The build's `validating_totals` stage runs
probes and the build FAILS (feeds back, bounded retries) rather than shipping
wrong numbers:
- every result set non-empty where the plan implies data (empty → the probe
  names the filter/join to reconsider — the init-pipeline convergence trick);
- each KPI recomputed independently server-side from the raw result set and
  compared to what the renderer will compute (same expression grammar, two
  evaluators);
- totals cross-checked against an independently-written aggregate over the
  source relation (fan-out detection — the hypertoy 44.6% lesson);
- dates inside the dataset's real coverage (`dataThroughDate` anchoring);
- every field id in the spec exists in the binding's whitelist (cheap, first).

**07.3 The DB is protected even from correct queries.** Compiled queries run
with `statement_timeout` (15s), row caps (`limit` ≤ 2000 per result set),
schema-qualified names, `dedupeOn` joins from the binding, and — the ZolStock
30M-row answer — sources flagged `heavy` in the brief may only be referenced
through existing MVs/aggregating views, never raw fact relations; the compiler
refuses otherwise and the plan step already steers away from it. Result sets
are executed at build time and then **cached per reload cycle**: `/data`
serves the cache and refreshes it at most once per (screen × reload), so a
screen opened 200 times costs one query run per nightly import, matching the
"Data updated" stamp the shell already shows. The nightly hook warms the cache
for `active` screens; a cold miss computes on demand under the same caps.

**07.4 The model's choices are enumerable.** Field ids, sources, block kinds,
aggregation ops — all chosen from closed sets validated at every boundary
(plan validation, spec schema, compiler). Free text exists only in labels.
This is why probe feedback can converge (modules.md: a failed probe names
which mapping to reconsider; a re-roll is never needed).

**07.5 Honest refusal.** Asks outside the catalog or outside the data get the
capability-gate treatment: Otto says what is blocked and why, in one
sentence, in chat, before any plan exists. Manifest caveats ride every
relevant screen as a quoted note line (M5).

**07.6 Blast radius.** A failed build leaves the previous spec untouched
(v1's rule, kept). A failed nightly cache warm marks nothing but staleness —
the previous cache keeps serving with its own data-through stamp. Otto being
degraded/off never touches the reload, the shelf's marketplace section, or
any other surface (module framework guarantee, already wrapped).

---

## 08 · Cleanup of v1 (same branch, after the replacement works)

Server: delete `otto-models.py` (applied one-off), `otto-out.html` (sample
artifact), `otto/datasets/demo-dataset.js`, `otto/theme/app-theme.css`, v1
route/service/store files replaced in §04. Keep `docs/design/otto-*.md`
(decision record) and the asset scripts in `scripts/` (one-off tooling, but
they document the figure's provenance). Client: delete `OttoBuilderPage.tsx`
+ its module.css + the `/intelligence/:datasetId/builder` route; in
`public/otto/` keep only the assets the new UI uses (new figure + favicon),
delete the `v-*.png` experiments. Remove the v1 Google-Fonts injection.

---

## 09 · Testing & verification

- `scripts/test-otto-unit.js` — offline battery: spec schema validation
  (accepts M3–M5's shapes, rejects unknown blocks/fields/aggs), expression
  grammar (incl. rejection of anything code-like), compiler output for a
  fixture binding (schema-qualified, capped, timeout set, heavy-source
  refusal), probe pass/fail cases, byte-identical shelf payload with otto off.
- `scripts/test-otto-knowledge.js` — init pass against a real dataset
  (zolstock): every relation/field the brief names exists; brief prompt
  section within token budget (manifest-style ≤1500-token check).
- Client: `tsc -b` + eslint as always; a fixture-spec render smoke of every
  block in both locales/directions.
- **Catalog coverage check** (owner directive: "enough components for a
  decent amount of user request scenarios"): a written list of ~15 realistic
  request scenarios — drawn from the dataset quick questions, v1's example
  prompts, the replenishment domain, and real Data Chat transcripts — each
  mapped to the blocks that express it. Every unexpressible scenario is
  named in the verification README with the block that would cover it; the
  catalog is extended (or the gap accepted explicitly) before P4 closes.
- **Extraction stability gate**: after the ProcurementPage extraction, the
  page renders pixel-identically (screenshot compare, both locales) and the
  extracted components carry the page's existing behaviors (sort, filter,
  RTL, mobile) — the same components then serve both Procurement and Otto,
  so one implementation stays exercised by live traffic.
- End-to-end on zolstock (the hard case): build M3–M5's "Safety Stock" screen
  for real; verify KPIs against hand-run SQL; confirm the sku-vs-
  item_number_sales trap is handled by the brief (the known silent-zero-rows
  hazard); results + README in `verification/otto-integration/`.
- Both-language verification of every prompt (CLAUDE.md rule).

---

## 10 · Phased plan (each phase gated; do not skip gates)

- **P0 — Assets & fixtures.** Copy mockups into `docs/design/otto-v2/`;
  obtain the new figure asset (§12 Q2). *Gate: files in repo.*
- **P1 — Storage + module skeleton.** Migration + runner; `modules/otto`
  descriptor with audit/verify real, knowledge pass stubbed; registry entry;
  gate middleware; shelf payload extension behind it. *Gate:
  `test-modules-unit.js` still green; byte-identical shelf assertion for a
  no-otto dataset; enable/disable from the admin tab works.*
- **P2 — Knowledge pass.** `brief.service.js` + init integration; run for
  zolstock + hypertoy. *Gate: `test-otto-knowledge.js` green on both.*
- **P3 — Server core.** Brainstorm/plan/spec services, compiler, probes,
  build job, screens store, routes. *Gate: `test-otto-unit.js` green;
  a scripted end-to-end build of Safety Stock on zolstock passes probes.*
- **P4 — Client.** FIRST the block extraction (§02.2): pull table/KPI/filter
  components out of ProcurementPage into shared spec-driven blocks, adopt the
  Insights `BlockRenderer` blocks, pass the pixel-identical + scenario-
  coverage gates (§09). THEN shelf, builder (3 panels + pill), renderer,
  published page, shell routing generalization, ottoService, i18n keys,
  `OttoFigure` (the approved Orb), branding audit in both locales/directions.
  *Gate: extraction gates green; tsc + lint green; manual walk of M1→M5 flow
  on zolstock locally, EN and HE.*
- **P5 — Cleanup (§08) + docs.** `docs/features/otto.md` (feature doc, per
  house style), CLAUDE.md layout-table row update, INDEX update. *Gate: grep
  shows no references to deleted files; server boots; suites green.*
- **P6 — Verification record.** `verification/otto-integration/` README +
  artifacts; both-language runs. *Gate: README summary table complete.*

Rough shape: P1–P3 are server-repo commits, P4 client-repo, each phase one
reviewable commit on `vl_us_otto_intelligence_integration`.

---

## 11 · Out of scope (v1) — explicitly deferred

Chart block; editing published apps (unpublish/re-draft); per-user ownership
and permissions; write-back blocks over `custom_module_data` (schema + API
ship, no block uses them); real "Create purchase order" action (stub with
in-screen notice, per v1's rule 8); voice input unless Q6 says otherwise;
migration of v1 saved demo screens (Q3); Otto for datasets with no manifest
(the brief degrades gracefully but the honest-refusal quality drops — enable
per client deliberately).

---

## 12 · Open questions — need the owner's answer before/at approval

- **Q1 — `screen_spec` instead of `html`.** CONFIRMED by the owner
  (2026-09-14): store the structured spec, never generated HTML. Owner's
  condition — enough components for a decent range of request scenarios,
  built by making the system's EXISTING UI components reusable and stable —
  is met by the inventory in §02.2 (Insights' `BlockRenderer` is already a
  production spec-driven renderer; ProcurementPage supplies table/KPI/filter
  implementations for extraction) plus the §09 catalog-coverage check.
- **Q2 — The new Otto figure.** RESOLVED IN DIRECTION (2026-09-14): the owner
  rejected the old standing render and asked for something more aesthetic,
  with eyes, whose screen shows live "process" activity while Otto loads or
  responds, on white. Because the face must ANIMATE with real builder state,
  the figure is not a generated image at all — it is a hand-built SVG React
  component (`OttoFigure`, `state: idle|thinking|building|done|error`).
  Round 1 offered three candidates; the owner chose **Orb** (2026-09-14) and
  asked for professional, smooth motion (round 1 looked static on his
  machine — the page honored the OS reduced-motion flag, which disabled all
  animation; the review page now runs motion unconditionally, while the
  shipped component WILL honor the flag with static per-state poses).
  Round 2 — Orb fully animated (float/breathe/blink/gaze on idle, spinning
  iris + comet on thinking, bouncing blocks + shimmer progress on building,
  overshoot arcs + ring pulse on done, single shake + amber badge on error,
  click reaction) is published at the same URL:
  https://claude.ai/code/artifact/10b88447-d4a6-4c89-a220-f60bafa54880
  APPROVED by the owner (2026-09-14): Orb, with round-2 motion, ships as
  `OttoFigure`. Q2 is fully resolved.
- **Q3 — v1 saved screens.** CONFIRMED by the owner (2026-09-14): discard
  the `provider_config` demo-data blobs, no migration.
- **Q4 — Delete semantics.** ANSWERED (2026-09-14): drafts hard-delete from
  the builder's delete button; published apps are removable by super-admin
  only until a proper unpublish flow exists.
- **Q5 — Build model.** ANSWERED (2026-09-14): **Opus 5 from day one** for
  spec generation (chat/plan stay Sonnet 5). Owner chose quality over cost;
  a later downgrade to Sonnet stays possible if it proves sufficient.
- **Q6 — Mic icon.** ANSWERED (2026-09-14): omit the mic in v1 — the
  composer ships without it; voice input is a follow-up task.
- **Q7 — Publish gate.** ANSWERED (2026-09-14): no gate — anyone in the
  client can publish; "Save to Apps" shows a confirm dialog stating the
  screen becomes visible to everyone in the organization.

**All §12 questions are resolved. The spec is fully approved for
implementation as of 2026-09-14.**
