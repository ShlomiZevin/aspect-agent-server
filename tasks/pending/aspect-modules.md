# Aspect Modules — a generic module system, with Smart Replenishment as module #1 and ZolStock as binding #1

> **Source of truth:** transcribed verbatim (text + visually verified screenshots)
> from the "Aspect Modules" planning artifact prepared with the codebase owner,
> 2026-08-27. Sections 00–12 below are that document. Section 13 is this
> session's own execution log — added here, not part of the original.
>
> **Supersedes file placement in `tasks/pending/zolstock-smart-replenishment.md`**
> — that file's engineering content (its Step 4 engine and step verifications)
> transfers into section 07/08 below **verbatim**. Per step E4, the old file
> moves to `tasks/done/` with a pointer to this one **once E4 is actually
> reached** — it stays in `pending/` and stays authoritative on the ZS-n detail
> until then; do not move it early.
>
> **Companion feasibility brief:** "ZolStock Replenishment Pilot" (2026-08-25) —
> an earlier, narrower feasibility study focused on *push alerts to one
> supplier*. Its six risks (goods-receipt gap, alert fatigue, lead time, safety
> stock, pipeline stability, expansion data wall) are folded into this plan's
> guardrails (§09) and module design (§07) rather than repeated here; see
> `verification/modules-replenishment/pilot-brief-notes.md` if a re-read is
> ever needed (not yet created — see §13).
>
> Status: **awaiting build**

## How to use this document

**Human:** sections 00–07 are the functionality description — what is being
built and why each decision was made. Section 08 is the phased plan with
verification clauses; skim the phase headers and gates.

**Claude Code session:** read first — server `CLAUDE.md`, client `CLAUDE.md`,
`agents/zolstock/AGENT.md`, `services/dataset-manifest/zolstock.manifest.js`,
`services/schema-rules/zolstock.rules.js`, and
`tasks/pending/zolstock-smart-replenishment.md` (its Step 4 engine and step
verifications are reused verbatim here). Then execute section 08 one step at a
time. Do not start step N+1 until step N's verify clause passes. Record
results in `verification/modules-replenishment/` with a README. Section 09's
guardrails override convenience every time they conflict with it.

---

## 00 · Decision record

Locked with the codebase owner on 2026-08-27. These are not open for
re-litigation during implementation; changes go back to the owner.

| # | Decision |
|---|---|
| D1 | **Client requirement first, no frankenstein.** Smart Replenishment ships using this codebase's standard patterns only: feature folder + one-line router mount, platform-DB storage, manifest opt-in, self-checking scheduler jobs, services layer, bilingual i18n. Every module surface reuses an existing pattern; none invents a parallel one. |
| D2 | **Extension, not refactor.** The module system is additive. A dataset with no module enabled behaves byte-identically to today — the same safety property the dataset-manifest engine already has. No existing feature is rewritten. |
| D3 | **Template + LLM mapping.** Modules ship canonical, hand-verified view shapes and engine formulas. The init LLM produces a binding (which columns mean demand, stock, on-order, supplier, item key; which quirks apply). A deterministic generator renders DDL from the binding. The LLM never writes the arithmetic and never free-writes SQL that ships. |
| D4 | **Modules tab is super-user only.** Clients get a separate read-only situation page (similar in spirit to the reports page), linked from the header and the side menu. New requirement, folded into scope — section 05. |
| D5 | **Notification delivery is mocked.** Settings, events, and the provider interface are real; the default provider writes to an admin-visible outbox instead of sending. A real email provider is a later swap-in, not a rebuild. |
| D6 | **Module skeleton now; Replenishment is module #1; ZolStock is binding #1.** ~90% of the existing 10-step ZolStock plan transfers verbatim — file locations change, hardcoded zolstock references become the binding. |
| D7 | **Chat priority via structured tool + manifest fragment.** When a module is enabled and ready, it registers a crew tool (structured args, no generated SQL) and contributes schema-rules/manifest fragments steering the SQL generator to module views. Module off ⇒ both vanish ⇒ behavior identical to today. |

---

## 01 · Extension, not refactor — the evidence

Every capability the module system needs already exists as a platform
mechanism. The module framework is a thin registry that composes them:

| Module system needs | Existing mechanism it plugs into |
|---|---|
| Per-dataset registration + enable/disable | `insights/datasets/registry.js` + `intelligence-config.service` pattern (registry entry + config over `provider_config`) |
| Safe multi-tenant activation | Dataset-manifest opt-in property: no manifest ⇒ byte-identical behavior, unit-asserted |
| Nightly build after import + indexing | `scheduler-tick.service` self-checking jobs ("loaded today, not yet done today") and the reload pipeline's phase-2 shadow-schema build |
| Async init with a progress bar | Insights investigation jobs: server-polled progress (`GET /:datasetId/progress/:jobId`), monotonic, real pipeline stages |
| LLM reads the client's schema and writes config | IntelligenceAdminPage "✨ Generate from your data" — precedent for the init scan |
| Admin-editable settings without new tables | `provider_config` JSON-blob layering (module *state* gets real tables — see §02 — but dataset defaults follow this pattern) |
| New API surface | Feature folder + router, one mount line in `server.js` (`bi/`, `insights/`, `hq/`, `builder/` pattern) |

**What is not touched:** the import mechanism, the atomic schema swap, the
chat dispatcher, the SQL generator core, existing MVs of other datasets, the
Builder, and every non-participating dataset. The framework adds hook points;
only registered, enabled, ready modules ever execute through them.

---

## 02 · Module system architecture

### The module descriptor

One folder per module under `modules/` in the server repo. The descriptor is
the whole contract — the admin tab, init pipeline, nightly build, and chat
integration all read from it. Adding a second module means writing one
descriptor; zero framework or admin-UI changes.

```js
// modules/replenishment/module.js
module.exports = {
  id: 'replenishment',
  name: { en: 'Smart Replenishment', he: 'חידוש מלאי חכם' },
  version: 1,

  // Renders the setup form generically in the admin tab (section 04).
  // Field spec: { key, type, required, default, label:{en,he}, hint:{en,he} }
  settingsSchema: [ /* section 07 lists Replenishment's fields */ ],

  // Events this module can emit (section 06).
  notificationEvents: ['init_completed', 'init_failed',
                       'nightly_build_failed', 'verification_degraded'],

  hooks: {
    audit(ctx),            // read-only dataset scan; no LLM; writes audit JSON
    proposeBinding(ctx),   // LLM mapping: audit + schema -> binding (model from settings)
    renderInfra(binding),  // deterministic: binding -> DDL for the canonical views
    verify(ctx, round),    // checkable probes against the built views
    nightlyBuild(ctx),     // called in reload phase 2, builds into the SHADOW schema
    chatTools(ctx),        // structured crew tools (only when enabled + ready)
    manifestFragment(ctx), // measures/dimensions/vocabulary/refusals additions
  },
};
```

### Platform-DB state (never the dataset schema)

```sql
CREATE TABLE client_modules (
  id             BIGSERIAL PRIMARY KEY,
  dataset_id     TEXT NOT NULL,
  module_id      TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  status         TEXT NOT NULL DEFAULT 'not_initialized',
                 -- not_initialized | initializing | ready | failed | degraded
  settings       JSONB NOT NULL DEFAULT '{}',
  binding        JSONB,          -- the LLM-mapped, verified binding (D3)
  init_model     TEXT,           -- model id from services/models.service.js
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, module_id)
);

CREATE TABLE module_runs (
  id             BIGSERIAL PRIMARY KEY,
  dataset_id     TEXT NOT NULL,
  module_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,  -- init | nightly | verify
  status         TEXT NOT NULL,  -- running | succeeded | failed
  progress_stage TEXT,           -- what the progress bar shows
  rounds         JSONB,          -- per-round verification results
  report         JSONB,          -- human-readable outcome, incl. failures
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);
```

Module-owned data tables (e.g. `supplier_settings` for Replenishment) are
ordinary migrations in the platform DB, namespaced by `dataset_id` — exactly
as the existing ZolStock plan already specifies. Generated views live in the
dataset schema and are rebuilt from the stored binding on every reload, so
losing them costs nothing; the binding and settings are the durable state.

### Lifecycle

```
Configured  →  Init infrastructure  →  (≤5 rounds: bind → build → verify)  →  Ready
 (settings         (async run,                (failures feed back into           (binding +
  filled,           progress polled             next binding proposal)            report
  module off)       from module_runs)                                            persisted)
                                                                                      │
                                                                                      ▼
                                                                    Nightly: renderInfra(binding)
                                                                    runs inside the reload that
                                                                    already runs
                                                                                      │
                                                                                      ▼
                                                        Runtime surfaces live: screen · chat
                                                        tool · report · manifest fragment
```

Two independent switches: `status` (owned by the init pipeline) and `enabled`
(the on/off button). Surfaces activate only when `enabled && status ===
'ready'`. A nightly build failure moves `status` to `degraded` — surfaces
keep serving the last good build, the failure is reported and notified, and
the next successful reload clears it.

---

## 03 · The init pipeline

Triggered by the **Init infrastructure** (or **Re-init**) button. Runs async;
the admin tab polls `module_runs` and renders a monotonic progress bar with
the real stage names (the insights-jobs pattern — never animate against a
guessed duration).

1. **Audit** — the module's read-only scan of the dataset: tables, keys, join
   rates, coverage, date ranges. No LLM. Output saved as the run's audit JSON.
   For Replenishment this is the generalized A1–A12 measurement list from the
   ZolStock plan.
2. **Propose binding** — the chosen LLM (model picked in settings, called via
   `services/llm.js` with a context key, temperature 0) receives the audit +
   schema descriptor + the module's binding contract, and returns a binding
   document. It maps; it does not write SQL.
3. **Render + build** — the deterministic generator renders the canonical
   view DDL from the binding and builds it in a scratch schema first, never
   live.
4. **Verify** — checkable probes, not vibes: every referenced relation/column
   exists; key join rates meet the contract's thresholds; view row counts
   reconcile against the audit; spot-check aggregates match raw-table
   aggregates; velocity coverage is non-empty. Each probe records pass/fail
   with numbers.
5. **Loop or finish** — on failure, the probe results feed back into a
   revised binding proposal: that cycle is one round, capped at 5. Success
   persists the binding + report and sets `ready`; exhaustion sets `failed`
   and the full per-round report is shown in the admin tab — which probes
   failed, with which numbers, every round.

**Why rounds can work here** (and couldn't under full generation): the search
space is small — the LLM chooses column mappings and quirk flags, not
arbitrary SQL. A failed join-rate probe says exactly which mapping to
reconsider. Verification is meaningful because the thing being verified is
enumerable.

---

## 04 · Admin: the Modules tab (super-user only)

One new tab in the existing per-dataset admin (beside the Intelligence admin
surfaces), gated by the existing super-admin key mechanism. Fully generic —
it renders whatever descriptors the registry returns:

- **Module list per dataset:** name, status dot (the same enabled/disabled
  signal the Intelligence admin already uses), enabled toggle.
- **Settings form** rendered from `settingsSchema` — mandatory/optional
  marking, bilingual labels via `i18n/translations.ts` (both locales,
  always), typed inputs, model picker fed from `GET /api/models`.
- **Init / Re-init button** with the progress bar; disabled while a run is
  active; re-init available whenever a binding exists.
- **Last run report** — expandable: per-round verification results, the
  binding (readable), the audit summary, and the notification outbox
  (section 06).

House UI rules apply: modal editing (never inline), custom confirm modal
(never browser `confirm()`), notices in a fixed-height slot so modals don't
resize, every string in both languages, RTL-safe layout. Visual design:
§12.1 (screenshot-verified 2026-08-27 — see §13).

---

## 05 · Client-facing situation page — new requirement

Clients never see the Modules tab. They get a read-only-by-default situation
page inside the Intelligence Center — for Replenishment this is the
Purchasing screen the ZolStock plan already specifies (its Step 6), now
framed as the module's client surface:

- **Route:** `/intelligence/:datasetId/purchasing` — a nav item in
  `IntelligenceShell` (the `purchasingRoute` prop pattern beside
  `reportsRoute`), plus links in the header and the side menu per the new
  requirement. The nav item renders only when the module is enabled + ready —
  driven by a small `GET /api/modules/:datasetId` status call, so turning the
  module off removes the page cleanly.
- **Three tabs**, mirroring the three supply-chain questions from the
  client's own framing: **Purchasing** (what to order), **Warehouse** (what
  comes in and goes out), **Branches** (what each branch needs). One anatomy
  for all three: summary tiles → one master table whose parent rows expand
  into child rows → a collapsible "How we calculated this" trust panel on
  every leaf. A user who learns one tab has learned them all.
  - **Tab 1 — Purchasing (this phase):** parent rows are suppliers (delivery
    time with its *you set this* / *default* badge, edit action,
    items-to-order count, estimated total); children are the item
    recommendations, urgency-sorted, each one plain-language sentence.
    Lead-time editing lives on the parent row (whether clients or only
    super-users may edit is settable per dataset — default: editable, since
    the buyer owns lead times).
  - **Tab 2 — Warehouse (phase 2, designed now):** parent rows are items (in
    stock, incoming, reserved, net position); children are the individual
    movements — open purchase-order lines (flagged unverified, no
    goods-receipt in the feed) and open customer orders. Same engine,
    stock-source parameter — a new caller, not a new implementation.
  - **Tab 3 — Branches (phase 3, data-gated):** parent rows are branches
    (items short, units needed, priority); children are per-item needs with
    suggested quantities. Activates only when the client delivers item-keyed,
    dated store inventory (85% of store-inventory rows currently carry no
    item code); until then the tab shows the coverage notice, not fake
    numbers.
- The leaf trust panel **is** the trust surface: every input, the formula,
  the result, and the source of each parameter (configured / dataset default
  / computed), with caveats written in words. A buyer will not act on a
  number they cannot check.

Client components live under `src/components/intelligence/Purchasing/` with
the Intelligence token set (`--ai-*` with fallbacks), never
`useAgentContext()` (it throws inside `IntelligenceShell`), strings in both
locales, and layout that survives `dir="rtl"`. Visual design: §12.2
(screenshot-verified 2026-08-27 — see §13).

---

## 06 · Notifications — real interface, mocked delivery

Settings carry notification emails (multiple) and per-event toggles. The
framework emits events; a provider interface delivers them:

```js
// modules/notification.service.js
// provider contract: async send({ datasetId, moduleId, event, payload, recipients })
// default provider: 'outbox' — writes to module_outbox (platform DB),
// rendered in the admin tab's run report. No real email leaves the system.
```

- **Operational events now** (about the module): `init_completed`,
  `init_failed`, `nightly_build_failed`, `verification_degraded`.
- **Business alerts later** (about the merchandise — "order X by Friday"):
  the agreed ZolStock phasing keeps these out of scope until the screen and
  numbers are trusted. The settings fields for them exist now
  (`alertEmails`, event toggles) so the push phase is a provider swap plus a
  scheduler entry — not a rebuild. This is exactly the "callable with no user
  in front of it" design constraint the spec page already imposes on the
  engine.

---

## 07 · Module #1: Smart Replenishment

### Binding contract (what init must produce)

```json
{
  "demand":   { "table": "facts", "rowFilter": "record_type = 'sales'",
                "dateCol": "row_date", "qtyCol": "qty_sold",
                "itemKey": "item_number_sales" },
  "stock":    { "warehouse": { "rowFilter": "record_type = 'warehouse_inventory'",
                               "qtyCol": "warehouse_qty", "itemKey": "sku" },
                "store":     { "...optional..." } },
  "onOrder":  { "rowFilter": "record_type = 'purchase_order'",
                "qtyCol": "purchase_order_qty", "itemKey": "sku",
                "unverified": true },
  "committed":{ "rowFilter": "record_type = 'customer_order'", "...": "..." },
  "catalog":  { "table": "items", "itemKey": "item_number",
                "replenishmentKey": "sku", "supplierCol": "positive_supplier",
                "cartonCol": "units_per_carton", "safetyCol": "safety_stock",
                "dedupe": "group_by_max" },
  "quirks":   ["catalog_not_unique", "vat_1_18", "anchor_to_demand_max_date",
               "supplier_col_reversed_latin"],
  "coverage": { "demandJoinRate": 0.999, "replenishmentKeyRate": 0.049,
                "...measured by audit, verified by probes..." }
}
```

The **stock source is a parameter of the engine call**, not of the binding —
warehouse now; per-store and warehouse-flow grains later are new callers,
not new implementations (the spec page's explicit instruction).

### Canonical views (templates rendered from the binding)

- **`mv_suppliers`** — grain: supplier. The supplier list builds itself from
  the data; nobody types suppliers in.
- **`mv_replenishment_base`** — grain: replenishment key (~14.6k rows for
  ZolStock): identity, supplier, carton, safety stock, stock, on-order (+
  last order date), committed, velocity over 28/90/365-day trailing windows,
  first/last sold, data-through. Heavy scanning happens at build time inside
  the reload; request time reads ~15k prepared rows.

Both carry UNIQUE indexes (required for `REFRESH … CONCURRENTLY`); every
trailing window anchors to the demand max date, never `CURRENT_DATE`.
Rendered DDL always dedupes the catalog before joining (`GROUP BY itemKey +
MAX()` — the 44.6% inflation lesson).

### The engine — transfers verbatim

The pure function from the ZolStock plan Step 4, unchanged: velocity → net
available → reorder point → order-by date → carton-rounded order quantity →
status (`overdue` | `due_soon` | `ok` | `no_demand`), with `today` as a
parameter and every output row carrying its parameter sources, caveats
(`notes[]`), and the unverified-on-order flag. All eight named edge cases
keep their offline unit-test battery (`scripts/test-replenishment-unit.js`) —
zero-velocity dead stock, negative available reported un-clamped, unknown
carton, unmatched SKU, thin history, stale 365d sales, inherited lead time.

### Settings schema

| Field | Required? | Default | Notes |
|---|---|---|---|
| `defaultLeadTimeDays` | required | 90 | Dataset default; per-supplier overrides on the Suppliers tab |
| `defaultReviewDays` | required | 30 | Review cycle for target stock |
| `defaultSafetyDays` | required | 14 | Computed fallback where the data has no safety stock |
| `velocityWindowDays` | required | 90 | Demand window for the engine |
| `initModel` | required | — | Model for the binding proposal; picker fed from `models.service.js` |
| `notificationEmails` | required | — | Multiple; operational events |
| `notificationEvents` | optional | all on | Per-event toggles |
| `includeStoreStock` | optional | false | Adds store stock into "available" |
| `horizonDays` | optional | 14 | "Due soon" window |
| `minOrderUnits` | optional | — | Dataset default; per-supplier override |
| `cartonRounding` | optional | true | Round order qty up to carton size where known |
| `clientCanEditLeadTimes` | optional | true | Whether the situation page allows lead-time editing |
| `alertEmails` | optional | — | Stored now, used by the future push phase |

### Chat & honesty integration (D7)

- Crew tool **`fetch_replenishment`** registered on the dataset's crew when
  enabled + ready: structured args (`supplier? sku? horizonDays? onlyDue?
  limit?`), calls the engine, never generates SQL. Answer-first-then-flag:
  answer with the default lead time, say so, point at the Suppliers tab. Same
  question five ways in either language ⇒ identical numbers — that
  invariance is why it's a tool and not a prompt.
- **Manifest fragment:** measures `replenishment need` and `estimated order
  cost` as `estimate`; dimension `supplier lead time` with new status
  `configured` (user-supplied, not from data); `goods receipt` as `absent`
  with roadmap; Hebrew/English vocabulary (זמן אספקה · נקודת הזמנה · מלאי
  ביטחון · הזמנה פתוחה); high-precision refusal triggers for arrival/receipt
  questions.
- **Schema-rules fragment:** replaces the current hand-written replenishment
  block — generated SQL must not attempt reorder arithmetic; item-grain fact
  scans stay forbidden.
- **Intelligence report:** the investigation PLAN gains a `replenishment`
  category whose rows come from the engine instead of NL→SQL; everything
  downstream (digest, verifier, downgrade guard) is untouched — it operates
  on rows and doesn't care where they came from.

---

## 08 · Development plan

Five phases, ordered so every phase ends in something verifiable and nothing
depends on unbuilt work. Steps marked **gate** stop for human review. The
ZolStock plan's step numbers are referenced as `ZS-n`.

### PHASE A — Module framework skeleton

**A0 — Fresh baseline.** Run and record: `test-insights-unit.js`,
`test-schema-contract.js`, `test-stage2-unit.js`, `test-stage3-unit.js`,
`tsc -b` + `eslint` on the client.
*Verify:* all pass, or pre-existing failures are written down in
`verification/modules-replenishment/`.

**A1 — Migrations:** `client_modules` + `module_runs` + `module_outbox`.
Hand-written SQL + paired runner (next free number at implementation time) +
Drizzle definitions in `db/schema/index.js`. Platform DB.
*Verify:* runner executes; tables exist; upsert + unique-constraint behavior
confirmed with a probe script.

**A2 — Registry + module.service + router.** `modules/registry.js` (static,
one entry per module — the insights-registry pattern),
`modules/services/module.service.js` (list/get/setEnabled/saveSettings/status
with settings resolution: module override → dataset default → code
constant, each resolved value tagged with its source level),
`modules/routes/modules.routes.js` mounted with one line in `server.js`. All
LLM calls route through `services/llm.js` with a context key.
*Verify:* API lists registered modules for a known dataset; unknown dataset ⇒
404; enable/disable round-trips; unit test asserts a dataset with no module
rows produces zero behavioral hooks (the byte-identical guarantee).

**A3 — Init-run orchestrator with a stub module.**
`modules/services/module-init.service.js`: runs audit → bind → render →
build(scratch) → verify rounds ≤5, writing `module_runs.progress_stage` at
each stage transition. Ship a dev-only `_stub` module exercising the full
lifecycle without an LLM (fixed binding, one deliberately failing probe on
demand) so the orchestrator, rounds, and failure report are testable
offline.
*Verify:* stub run reaches `ready`; forced-failure run exhausts 5 rounds,
sets `failed`, and the report names the failing probe per round. Progress
stages are monotonic.

**A4 — Admin Modules tab.** Generic tab in the per-dataset admin: module
list + status dots, settings form rendered from `settingsSchema`, enabled
toggle, Init/Re-init with polled progress, expandable last-run report +
outbox. Super-admin gated. New service module in `src/services/`; strings in
both locales.
*Verify:* renders in Hebrew and English; RTL layout holds; progress bar
reflects the stub run live; failure report is readable; toggle state matches
the API.

### PHASE B — Replenishment module core (offline)

**B1 — Binding contract + templates + deterministic renderer.**
`modules/replenishment/binding-contract.js` (shape + probe thresholds),
`templates.js` (canonical `mv_suppliers` + `mv_replenishment_base` DDL,
parameterized), `render-infra.js`. Renderer output for a fixture binding is
asserted against golden DDL. Includes ZS-2's correctness rules: catalog
dedup before every join, UNIQUE indexes, demand-max-date anchoring, `NULLS
LAST` on value orderings.
*Verify:* golden-DDL unit test passes; rendering the ZolStock-shaped fixture
produces DDL equivalent to the hand-written views in ZS-2.

**B2 — The engine + unit battery.** `modules/replenishment/engine.js` — the
ZS-4 pure function verbatim: formula, `today` as a parameter, sources +
`notes[]` on every row, stock source passed in (never hardcoded
"warehouse"). `scripts/test-replenishment-unit.js` with all eight named edge
cases, offline, no DB, no LLM.
*Verify:* battery passes. This step has no DB dependency — it can run before
any binding exists.

**B3 — Audit hook + Hebrew gap report.** Generalize ZS-1's
`zolstock-replenishment-audit.js` into the module's audit hook: the A1–A12
measurements (supplier coverage, replenishment-key coverage per supplier, PO
content, goods-receipt evidence, safety-stock/carton coverage, date ranges,
day-completeness via `coverage.service`), parameterized by schema. Keep
`--format=hebrew` — the plain-Hebrew "what is missing" summary Shlomi
forwards to the BI developer and the client.
*Verify:* read-only run against live zolstock completes; JSON + README land
in `verification/modules-replenishment/`; Hebrew summary renders.

**B4 — proposeBinding + verification probes.** The LLM mapping prompt (audit
+ schema descriptor + contract in, binding JSON out; temperature 0; model
from settings) and the verify hook's probe set: relations/columns exist;
demand-key join rate ≥ contract threshold; view row counts reconcile with
audit; three spot aggregates match raw-table aggregates; velocity coverage
non-empty; per-quirk assertions (e.g. dedup actually applied).
*Verify:* probes run green against a hand-authored correct ZolStock binding,
and each probe individually fails against a deliberately mis-mapped binding
(wrong item key, missing dedup) — the probes must be proven able to fail.

### PHASE C — ZolStock binding — the first real init

**C1 — Run init on ZolStock; review the audit.** ⚠ **GATE.** Configure the
module for zolstock in the admin tab, run Init, let the rounds converge.
Then stop: review the audit numbers (supplier-key coverage, PO reality,
receipt evidence) and the converged binding with Shlomi — the ZS-1 gate,
unchanged. If most suppliers have almost no coded items, re-scope before
building screens that recommend nothing.
*Verify:* status `ready`; binding matches the hand-authored reference from B4
(differences explained); gate review recorded in the run report.

**C2 — Sales-view supplier fix (binding-independent).** ZS-2 item 1: add
`positive_supplier` and `sku` to the item dimension of the existing zolstock
sales MVs — a correctness fix in its own right ("sales by supplier"
currently groups by the reversed-text manufacturer column).
*Verify:* scratch-schema build first; `test-schema-contract.js` passes; a
full reload completes.

**C3 — supplier_settings + service.** ZS-3 verbatim: the migration, Drizzle
definition, and `supplier-settings.service.js` (now under
`modules/replenishment/services/`), dataset defaults resolved through the
module settings chain.
*Verify:* upsert a supplier lead time; run a full zolstock reload; the
setting survives — that check is what proves the storage rule was respected.

### PHASE D — Surfaces

**D1 — Recommendations API.** ZS-5's endpoints, module-scoped: `GET/PUT
/api/modules/replenishment/:datasetId/suppliers[/:key]`, `GET/PUT …/defaults`,
`GET …/recommendations` (+ per-sku detail). Engine-backed, reads
`mv_replenishment_base`, 404 on unknown dataset or module-not-ready.
*Verify:* a supplier with no settings answers with `leadTimeSource:
'dataset_default'`; module disabled ⇒ 404 on recommendation routes.

**D2 — Client situation page + nav links.** ZS-6 plus the new requirement:
`src/components/intelligence/Purchasing/`, route
`/intelligence/:datasetId/purchasing`, nav item in `IntelligenceShell`, plus
header and side-menu links — all conditional on module enabled + ready.
Build the three-tab structure of §12.2 with the shared expandable-table
anatomy: the Purchasing tab fully live; Warehouse and Branches tabs present
but phase-gated (Branches also data-gated behind the store-inventory fix).
Leaf trust panels, CSV export, house modal rules, both locales, RTL.
*Verify:* both languages render; links appear only when the module is on; a
lead-time change reflects in Tab B without reload; row arithmetic matches
ten hand-checked SKUs computed with a calculator against raw tables
(recorded in `verification/`).

**D3 — Chat tool + schema rules + manifest fragment.** ZS-7 + ZS-8 as module
hooks: `fetch_replenishment` on the zolstock crew; the manifest fragment
(new `configured` dimension status, receipt refusals, vocabulary); replace
the hand-written replenishment block in `zolstock.rules.js` with the
module's fragment; registry prompt examples ("מה צריך להזמין עכשיו").
*Verify:* `test-schema-contract.js` + stage batteries; a receipt question
refuses with the manifest reason; `test-chat-regression.js zolstock` and
`--hebrew` pass; the same question asked five ways per language returns
identical numbers.

**D4 — Intelligence report category.** ZS-8's investigation change: PLAN
gains `replenishment`; rows come from the engine; downstream pipeline
untouched; existing block palette, no new block type.
*Verify:* `test-insights-suite.js zolstock all` and `… hebrew` pass; a
replenishment investigation produces engine-sourced rows.

### PHASE E — Operations & closure

**E1 — Nightly hook in the reload pipeline.** Reload phase 2 gains one call:
for each enabled + ready module of the schema being rebuilt, run
`renderInfra(binding)` into the shadow schema alongside the existing MVs,
before the atomic swap. Extend the freshness assertion to module views. A
module build failure marks the module `degraded` and emits
`nightly_build_failed` — it must never fail the reload itself
(log-and-surface, the reload-freshness philosophy).
*Verify:* full zolstock reload builds module views in shadow and swaps
clean; with the module disabled, the reload path is asserted byte-identical
to today; a forced module-build failure degrades the module, notifies, and
the reload still completes.

**E2 — Notification outbox provider.** `modules/notification.service.js`
with the provider contract; default outbox provider writing to
`module_outbox`; admin tab renders the outbox. Events wired from the init
orchestrator and the nightly hook.
*Verify:* forced init failure produces an outbox entry addressed to the
configured emails with the right event; toggled-off events produce nothing.

**E3 — Regression sweep.** ZS-9: `run-customer-replay.js` against the frozen
74-question corpus, `compare-replays.js` against the last baseline. Plus the
full offline battery set from A0.
*Verify:* zero regressions on the replay. (A 65-case invented suite once
passed 65/65 while one real 18-question client session exposed two silent
wrong answers — the replay is the bar.)

**E4 — Docs.** New `docs/features/modules.md` (framework) and
`docs/features/replenishment.md` (module); update `agents/zolstock/AGENT.md`,
`docs/INDEX.md`, both `CLAUDE.md` files' relevant sections; move
`zolstock-smart-replenishment.md` to `tasks/done/` with a pointer here and
fill its Results section.
*Verify:* docs name every new table, route, hook, and the byte-identical
guarantee; a fresh session can locate the module system from `CLAUDE.md`
alone.

---

## 09 · Guardrails — non-negotiable

Each of these is something this codebase already learned the hard way. They
override convenience, always.

1. **Nothing user-entered lives in a dataset schema.** Those schemas are
   dropped and rebuilt behind an atomic swap on every import. Platform DB
   only. The proof is C3's reload-survival check.
2. **Code does arithmetic; the model does judgment.** The LLM maps and
   explains; it never computes a recommendation and its SQL never ships
   unverified. Generation runs at temperature 0 via `services/llm.js` with a
   context key; model ids come from `models.service.js`.
3. **Anchor to the data's max date, never the clock.** Feeds are periodic
   exports and can be behind; the last day can be partial. `today` is a
   parameter everywhere.
4. **Dedupe the catalog before every join.** Duplicate item rows once
   inflated another client's revenue by 44.6%.
5. **No inline routes; no repo-relative persistence.** Feature folder + one
   mount line; Postgres/GCS for state — the container build wipes everything
   else on deploy.
6. **Bilingual mirrors the prompt, nothing else.** Hebrew inside the data
   says nothing about the requested language. Verify every prompt change in
   both languages — correctness and language are independent failure modes.
7. **Never mutate dataset config while a suite is running;** verification
   output goes in `verification/<topic>/` with a README, never the repo
   root.
8. **The no-module path stays byte-identical, and it is unit-asserted** (A2,
   E1) — that assertion is the multi-client safety guarantee and the licence
   to ship the framework at all.

---

## 10 · Open items — non-blocking, decide during build

- **Header-link placement:** the exact header slot for the situation-page
  link per agent config (the side-menu and IntelligenceShell nav placements
  are clear). Proposal lands with D2's first screenshot.
- **Page naming for clients:** "Purchasing" (רכש) vs "Replenishment" —
  client-facing wording, decide with Shlomi at D2.
- **`supplier_settings` naming:** kept as spec'd (it is
  replenishment-module-owned); if a future module needs per-entity settings,
  generalize then, not now.
- **Migration numbers:** assigned from the live migrations folder at
  implementation time — the ZS plan's "039" may already be taken.
- **Real notification provider:** choice of email service is deferred to the
  push phase; the outbox provider is the only deliverable now (D5).

---

## 11 · File map

| Area | New | Touched |
|---|---|---|
| Server — framework | `modules/registry.js` · `modules/services/module.service.js` · `modules/services/module-init.service.js` · `modules/notification.service.js` · `modules/routes/modules.routes.js` · `modules/_stub/module.js` · migrations (`client_modules`, `module_runs`, `module_outbox`) | `server.js` (one mount line) · `db/schema/index.js` · `services/data-reload.service.js` (phase-2 hook) · reload-freshness extension |
| Server — replenishment | `modules/replenishment/module.js` · `binding-contract.js` · `templates.js` · `render-infra.js` · `engine.js` · `audit.js` · `services/supplier-settings.service.js` · `scripts/test-replenishment-unit.js` · `supplier_settings` migration | `scripts/create-zolstock-mvs.js` (supplier fix) · `services/schema-rules/zolstock.rules.js` · `services/dataset-manifest/zolstock.manifest.js` · `agents/zolstock/crew/zolstock.crew.js` · `insights/services/investigation.service.js` · `insights/datasets/registry.js` |
| Client | `src/components/admin-modules/*` (Modules tab) · `src/components/intelligence/Purchasing/*` · `src/services/modulesService.ts` · `src/services/replenishmentService.ts` · `src/types/modules.ts` · `src/types/replenishment.ts` | `src/App.tsx` · `IntelligenceShell.tsx` (nav + header/side-menu links) · `src/i18n/translations.ts` (both locales) |
| Docs & verification | `docs/features/modules.md` · `docs/features/replenishment.md` · `verification/modules-replenishment/` | `docs/INDEX.md` · `agents/zolstock/AGENT.md` · both `CLAUDE.md` files · `tasks/pending/zolstock-smart-replenishment.md` → `done/` |

---

## 12 · Interface designs

Screen designs for the two new surfaces, matched to the live ZolStock
Intelligence product (screenshot-verified 2026-08-27): light lavender
ground, white rounded surfaces, deep-indigo primary, pill chips and status
dots, Inter-class type. The admin tab keeps its approved structure, restyled
to the product language. The client page carries three tabs mirroring the
three supply-chain questions — Purchasing, Warehouse, Branches — all sharing
one anatomy: summary tiles, a master table whose parent rows expand into
child rows, and a collapsible "How we calculated this" trust panel on every
leaf. Learn one tab, know them all. The client page ships in both languages;
shown in English with real Hebrew data, the everyday mixed state the i18n
rules are built for. Implementation note for D2/A4: the client page is built
on the Intelligence `--ai-*` token set re-themed per client via
`data-brand` — these mockups define the zolstock brand values for that set.

> This session rendered the source artifact headlessly (Chrome DevTools
> Protocol, full-page capture) to confirm the visuals below rather than
> relying on the text description alone — see §13.

### 12.1 · Admin — the Modules tab (super-user)

`aspect-agents.web.app/zolstock/dashboard/modules`

- **Module list:** one card per registered module — status dot + pill
  (`Ready` / `Not initialized`), a **Nightly ✓ 03:14** badge, an **Enabled**
  toggle. "Smart Replenishment" shows `Binding v3 · initialized 27 Aug 2026,
  14:32 · model claude-sonnet-4-6 · views mv_suppliers, mv_replenishment_base`
  with **Settings / Re-init infrastructure / Run report** actions.
  "Warehouse Flow" sits below as `Not initialized`, enabled toggle off,
  showing only a **Settings** action — proving toggle and status are
  independent.
- **Settings modal:** two-column form — lead time / review cycle / safety
  stock / velocity window (all required, numeric), init model picker,
  horizon days, two toggles (include store stock, carton rounding),
  multi-value email chips, a row of "Notify on" checkboxes, an info notice in
  a fixed-height slot ("Saved settings apply from the next init or nightly
  build"), Cancel / Save settings.
- **Init run panel:** live stage checklist (Audit ✓ → Propose binding ✓ →
  Render+build ● → Verify ○), a **Round 2 of 5** counter, and a **round
  history** that names the exact failure — `probe demand_join_rate — 61.9% <
  95% threshold (binding mapped item_number; probe feedback returned to the
  model)` — followed by the revised round in progress. A separate "Last
  completed run" card shows the previous green run (`probes 11/11 · binding
  v3 stored`) plus the mocked outbox line for its notification.

### 12.2 · Client — the Purchasing situation page

`aspect-agents.web.app/intelligence/zolstock/purchasing`

- **Tab 1 — Purchasing:** an info banner ("Delivery times are set for 1 of 13
  suppliers…"), four summary tiles (Order now `23` / Due in 14 days `12` /
  Stocked OK `539` / No recent sales `89`), then the supplier table. Each
  supplier row shows delivery time with a `you set this` (green) or `default
  — set it` (amber) badge, an items-to-order count, and an estimated total.
  Expanding a supplier reveals urgency-sorted item rows, each a one-sentence
  recommendation with a lateness/due badge; expanding a row's **Why?** opens
  the full trust panel (sales pace, in stock, on the way — flagged `⚠ may
  already be delivered` — reserved, delivery time, safety buffer, the
  one-sentence derivation, and the caveat sentence about list-price
  estimates and unconfirmed deliveries).
- **Tab 2 — Warehouse:** same anatomy, item-grain. Four tiles (units coming
  in / reserved out / below safety stock / idle stock), then an item table
  (in stock, coming in, going out, net position ≈ days of cover). Each item
  expands into its individual movement lines (a PO line flagged unverified,
  a customer-order line), each with its own **Why?** panel.
  Present in the tab bar now; **later** badge, not live data yet.
- **Tab 3 — Branches:** an amber coverage banner ("Branch stock data
  currently covers only part of the chain…"), tiles (branches needing stock
  / items short / units to send / a `Partial ⚠` data-coverage tile), then a
  branch table expanding into per-item transfer suggestions with a
  branch-local **Why?** panel (branch sales pace, branch stock snapshot,
  what the warehouse can supply). **Later** badge — data-gated behind the
  store-inventory fix, shown honestly as coverage rather than fabricated per-
  branch numbers.

---

## 13 · This session's execution log and approach

*(Added by the Claude Code session that picked this plan up on 2026-08-27 —
not part of the original artifact. Kept here so a future session, or a
resumed one after a context reset, can pick up without re-deriving any of
this.)*

### How this will be executed

- **Phase-sized branches, not step-sized.** One `feat/modules-phase-a`
  branch (etc.) per phase, following this repo's established workflow:
  branch → commit → push → `--no-ff` merge to master → push master. Never
  commit directly to master. A phase's branch stays open across however many
  sessions that phase takes.
- **Every step's `Verify` clause is actually run, not assumed.** Output goes
  to `verification/modules-replenishment/` with a README per the plan's own
  instruction; this file's checklist (below) is only marked `[x]` once that
  verification is recorded.
- **Checkpoints with the user**, not per-step permission: Phase A (framework
  skeleton) is additive and touches no live dataset, so A0–A4 run in one
  continuous stretch and get reported once done, not step-by-step. **C1 is a
  hard gate** per the plan itself (§08) — stop there regardless, review the
  audit and converged binding with Shlomi before continuing. E1 (the nightly
  reload hook) touches the production reload pipeline for zolstock, so it
  gets flagged for explicit go-ahead before its own verify run, even though
  it isn't marked `gate` in the source plan.
- **Migrations** (A1, C3, and the `supplier_settings` migration) are
  hand-written SQL + paired runner, executed by this session through the
  Cloud SQL Proxy exactly like every other migration in this repo — never an
  ad-hoc `CREATE TABLE`/`ALTER` against the live DB.
- **Deploys are asked for individually, every time** — Phase A's admin tab,
  Phase D's client page, Phase E's nightly hook are three very different
  blast radii and each gets its own explicit yes, per this project's
  standing rule.
- **The old ZolStock plan is read, not re-solved.** Where a step says
  "ZS-n verbatim", the corresponding section of
  `tasks/pending/zolstock-smart-replenishment.md` is the literal spec —
  this file does not re-derive the formula, the audit measurements, or the
  edge cases; it points at them.

### Progress checklist

Mirrors §08 exactly. Check off only once that step's `Verify` clause has
actually passed and been recorded.

- [x] A0 — Fresh baseline
- [x] A1 — Migrations: client_modules + module_runs + module_outbox
- [x] A2 — Registry + module.service + router
- [x] A3 — Init-run orchestrator with a stub module
- [x] A4 — Admin Modules tab
- [x] B1 — Binding contract + templates + deterministic renderer
- [x] B2 — The engine + unit battery
- [x] B3 — Audit hook + Hebrew gap report
- [x] B4 — proposeBinding + verification probes
- [x] C1 — Run init on ZolStock; review the audit **(GATE — human review required)**
- [x] C2 — Sales-view supplier fix
- [x] C3 — supplier_settings + service
- [x] D1 — Recommendations API
- [x] D2 — Client situation page + nav links
- [ ] D3 — Chat tool + schema rules + manifest fragment
- [ ] D4 — Intelligence report category
- [x] E1 — Nightly hook in the reload pipeline **(ask before running against production reload)**
- [x] E2 — Notification outbox provider
- [ ] E3 — Regression sweep
- [ ] E4 — Docs

### Results

*(fill in as steps complete — this section, together with the checklist
above, is the durable record for this build)*
