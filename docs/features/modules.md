# Aspect Modules — the framework

A generic module system: optional capabilities that can be switched on **per
client**, each one a folder with a single descriptor. Smart Replenishment is
module #1 (see [replenishment.md](./replenishment.md)); ZolStock is its first
binding.

Built 2026-08-27. Plan and per-step verification:
`tasks/pending/aspect-modules.md` and
`verification/modules-replenishment/README.md`.

---

## The one guarantee everything else rests on

**A dataset with no module row behaves byte-identically to a platform where
this framework was never installed.** No query is issued, no hook fires, no
log line appears, no prompt changes. That is what makes it safe to ship a
framework to a multi-client platform, and it is asserted directly in three
places rather than assumed:

| Where | Assertion |
|---|---|
| `scripts/test-modules-api.js` | a real dataset with no rows answers `{modules: []}`; a sibling dataset is unaffected |
| `scripts/test-modules-nightly.js` | the reload hook builds nothing **and emits no log line** |
| `scripts/test-replenishment-chat.js` | the crew keeps exactly the tools it had; a crew with no `datasetSchema` is untouched |

---

## Two switches, never one

| | Owned by | Meaning |
|---|---|---|
| `enabled` | a human, in the admin tab | the on/off button |
| `status` | the init pipeline | `not_initialized` → `initializing` → `ready` \| `failed` \| `degraded` |

**Surfaces activate only when `enabled AND status = 'ready'`.** Enabling a
module that has never been initialized does *not* make it live — it has no
views to read. Disabling one **preserves** its status and binding, so
switching it back on does not require re-initializing.

`moduleService.getLiveModules()` / `isLive()` is the single definition of
"live". Everything downstream asks it rather than reading the two columns
itself, so the rule exists once instead of being re-derived, subtly
differently, in five places.

---

## Where the code lives

| Path | Responsibility |
|---|---|
| `modules/registry.js` | Static list of module descriptors. Validated at boot — a malformed descriptor crashes on a developer's machine, not halfway through an init run. The dev-only `_stub` is registered only when `NODE_ENV !== 'production'`. |
| `modules/services/module.service.js` | State, 3-tier settings resolution with source tags, and the live gate. |
| `modules/services/module-init.service.js` | The init orchestrator: audit → propose → render → build(scratch) → verify, ≤5 rounds. |
| `modules/services/module-build.service.js` | The nightly hook, called from reload phase 2. |
| `modules/services/module-tools.service.js` | Attaches a live module's crew tools, idempotently, per turn. |
| `modules/notification.service.js` | Event emission; the default provider writes to an outbox instead of sending. |
| `modules/routes/modules.routes.js` | Public status + super-admin admin API. One mount line in `server.js`. |
| `modules/<id>/module.js` | The module descriptor — the whole contract. |
| `db/migrations/040_add_client_modules.sql` | `client_modules`, `module_runs`, `module_outbox` — all in the **platform** DB. |

Client: `src/components/dashboard/ModulesPage/` (admin tab),
`src/services/modulesService.ts`, `src/types/modules.ts`.

---

## The descriptor

One file is the entire contract — the admin tab, the init pipeline, the
nightly build and the chat integration all read from it. Adding a second
module is writing one of these; the framework and the admin UI do not change.

```js
module.exports = {
  id: 'replenishment',
  name: { en: '…', he: '…' },        // BOTH locales, validated at boot
  version: 1,
  settingsSchema: [ { key, type, required, default, label:{en,he}, hint:{en,he} } ],
  notificationEvents: ['init_completed', 'init_failed',
                       'nightly_build_failed', 'verification_degraded'],
  hooks: {
    audit(ctx),                    // read-only dataset scan, no LLM
    proposeBinding(ctx),           // LLM maps columns — never writes SQL
    renderInfra(binding, schema),  // deterministic: binding → DDL
    verify(ctx),                   // checkable probes against the built views
    nightlyBuild(ctx),
    chatTools(ctx),                // structured crew tools
    manifestFragment(ctx),         // measures/dimensions/vocabulary additions
  },
};
```

`settingsSchema` field types: `number`, `text`, `boolean`, `model`, `emails`,
`event_toggles`. The admin form renders them generically and knows nothing
about any particular module.

---

## Storage

All in the **platform** DB (`agents_platform_db`), never a dataset schema —
those are dropped and rebuilt behind an atomic swap on every import, so
anything a user typed there would silently vanish on the next reload.

- **`client_modules`** — one row per (dataset, module): `enabled`, `status`,
  `settings` (JSONB), `binding` (JSONB), `init_model`. `status` carries a
  CHECK constraint because it gates whether recommendations reach a client:
  a typo must fail at write time rather than park the module in a state that
  `= 'ready'` never matches. A partial index encodes the live gate directly.
- **`module_runs`** — one per init/nightly/verify run: `progress_stage`
  (polled by the admin tab), `rounds` (per-round probe results), `report`.
- **`module_outbox`** — mocked notification delivery. `run_id` is
  deliberately not a foreign key: outbox history should outlive run pruning.

Generated views live in the dataset schema and are rebuilt from the stored
binding on every reload, so losing them costs nothing. **The binding and the
settings are the durable state.**

---

## The init pipeline

Triggered by **Init infrastructure** in the admin tab; runs async while the
tab polls `module_runs`.

```
audit  ──▶  ┌─ propose binding ─▶ render + build (scratch) ─▶ verify ─┐
(once)      └──────────── failed? feed probes back, next round ───────┘
                                  (max 5 rounds)
```

**Why rounds can converge here**, when free SQL generation could not: the
model chooses column mappings and quirk flags from an enumerable set. A
failed join-rate probe names exactly which mapping to reconsider, so the next
attempt is a revision rather than a re-roll.

Three properties worth knowing:

- **Target and source schemas are separate.** Views are created in the
  scratch schema but read the live data. They are the same schema only on the
  nightly path, where the shadow holds a full fresh copy. One stored binding
  serves both.
- **The scratch schema outlives the build and is dropped after verify**, in a
  `finally`. Dropping it inside the build meant probes queried a schema that
  no longer existed.
- **A rejected proposal costs one round, not the run.** Structural validation
  catches a malformed binding in ~1s with errors naming the exact fields.

Progress is stored as `"<round>:<stage>"` and the percentage is *computed* —
monotonic by construction, no counter to drift.

---

## The nightly hook

Reload phase 2 gains one call, after the dataset's own indexes and MVs and
**before the atomic swap**, so a module's views arrive with the swap as one
unit.

**A module can never fail a reload.** The reload is the platform's most
important scheduled job and every dataset depends on it; an optional module
breaking it would be a catastrophic trade. A failed module build marks the
module `degraded`, emits `nightly_build_failed`, and lets the swap proceed —
the module keeps serving its last good build until a clean build clears the
state. Even the *lookup* of module state is wrapped: an unreachable platform
DB mid-reload leaves the dataset's own build unaffected.

---

## Notifications

Real settings, real events, real provider contract; **delivery is mocked**.
The default `outbox` provider writes to `module_outbox` and the admin tab
renders those rows. Swapping in a real email provider is a provider change,
not a rebuild.

Nothing in the notification path throws at its caller — an init that
succeeded and then blew up announcing itself would be reported as a failure,
which is worse than a missing notification.

---

## API

Mounted at `/api/modules` (one line in `server.js`).

| Method | Path | Who |
|---|---|---|
| GET | `/:datasetId` | **public** — which modules are live (id + bilingual name only) |
| GET | `/admin/:datasetId` | super-admin — all registered modules + state |
| GET | `/admin/:datasetId/:moduleId` | super-admin |
| PUT | `/admin/:datasetId/:moduleId/enabled` | super-admin |
| PUT | `/admin/:datasetId/:moduleId/settings` | super-admin |
| POST | `/admin/:datasetId/:moduleId/init` | super-admin — starts a run |
| GET | `/admin/:datasetId/:moduleId/runs/latest` | super-admin — polled progress |

Route order matters: the admin sub-router mounts **before** the public
`/:datasetId`, or "admin" is captured as a dataset id. The public payload is
deliberately smaller — it is fetched by a customer's browser to decide
whether to render a nav item, and settings, bindings and model ids have no
business there.

Modules may mount their own client API underneath, e.g.
`/api/modules/replenishment/:datasetId/...`.

---

## Adding a module

1. `modules/<id>/module.js` exporting a descriptor (both locales, all seven
   hooks — the registry refuses anything less at boot).
2. Register it in `modules/registry.js`.
3. If it owns data a user types, add a migration for it in the **platform**
   DB, namespaced by `dataset_id`.

Nothing in the admin UI, the router, the init orchestrator or the nightly
hook changes — they all read the descriptor.

---

## Testing

| Script | What it covers |
|---|---|
| `scripts/test-modules-unit.js` | descriptor validation, settings resolution — offline |
| `scripts/test-modules-api.js` | the live gate and the admin API, against a running server |
| `scripts/test-modules-init.js` | the orchestrator: convergence, exhaustion, monotonic progress, the 409 concurrency guard |
| `scripts/test-modules-nightly.js` | the reload hook in all three states, and the outbox |

Every battery is self-cleaning: they work under the dev `_stub` module or a
throwaway dataset id and delete their own rows, so a run leaves nothing in
the shared platform DB.
