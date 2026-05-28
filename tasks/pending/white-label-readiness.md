# White-Label Readiness — Audit & Plan

> Goal: move the codebase toward a clean "core + per-client modifications" model so each agent (and its client) can be extracted, shipped, or hosted independently without manually rewriting shared code.

## Current state — what is already right

The paradigm is partially in place. Useful baseline:

- **Folder isolation per agent**
  - `agents/<name>/crew/` × 14 agents on the server, each owning its crew + persona + data-reload.
  - `src/agents/<name>.config.ts` × 13 on the client, indexed in `src/agents/agentRegistry.ts`.
- **Per-client database modules** for data-backed agents:
  `services/db.zer4u.js`, `services/db.newdeli.js`, `services/db.thestock.js`, `services/db.hypertoy.js`.
- **Agent registry in DB** (`agents` table) — slug is the single tenant key end-to-end.

Rough readiness score: **5–6 / 10**. The structure is there; the seams are not yet clean.

---

## Issues — where private leaks into shared

### 1. `services/sql-generator.service.js` — client logic inside a core service (PRIORITY 1)

`_getSchemaSpecificRules(schemaName)` contains four hardcoded branches:

```js
if (schemaName === 'hypertoy') { /* 145 lines of hypertoy SQL rules + examples */ }
if (schemaName === 'thestock') { /* 95 lines */ }
if (schemaName === 'newdeli')  { /* 100 lines */ }
if (schemaName === 'zer4u')    { /* 45 lines */ }
```

A core service knows the name of every client and carries their schema-specific prompts. Removing one client means editing this file. **This is the worst offender and the first thing to fix.**

### 2. `server.js` (5500+ lines) — god-file with hardcoded agent names

- Default agent name set to `'Aspect'` (lines 1492, 1811).
- Data-reload registration uses an explicit list (lines 5499–5502):
  ```js
  require('./agents/zer4u/data-reload').register(dataReloadService);
  require('./agents/newdeli/data-reload').register(dataReloadService);
  require('./agents/thestock/data-reload').register(dataReloadService);
  require('./agents/hypertoy/data-reload').register(dataReloadService);
  ```
- CORS hosts (`aspect-agents.web.app`, `freeda.ai`, etc.) baked in.

Should be auto-discovered from `fs.readdirSync('./agents')`.

### 3. `src/App.tsx` — all routes prescribed by hand

Each agent has two `<Route>` entries (the page and the `/conversations/:conversationId` variant). Adding/removing an agent means editing `App.tsx`. Should be generated from `AGENT_REGISTRY`.

### 4. `src/pages/` — 60+ files, no domain separation

Pages from three unrelated domains live in one folder:
- **Agent pages**: `Zer4UPage`, `FreedaPage`, `HyperToyPage`, …
- **Marketing/landing**: `AspectLandingPage`, `LybiLandingPage`, `PitchDeckPage`, `AboutShlomiPage`, …
- **Internal tools**: `TaskBoardPage`, `SuperAdminUsersPage`, `DashboardPage`, `CrewBuilderMockupPage`, …

When extracting code for a client, every file has to be classified manually.

### 5. Internal tooling bundled with the agent runtime

`task-board`, `query-optimizer`, `crew-editor`, `playground`, and `super-admin` are internal developer tools, not part of the product surface a client buys. They currently ride along in the same server and client build.

---

## Plan

Ordered by impact, each step independently shippable.

### Step 1 — Extract per-schema SQL rules (this task)

Move every `_getSchemaSpecificRules` branch into `agents/<name>/sql-rules.js`. `sql-generator.service.js` becomes name-agnostic: it asks the agent folder for its rules and injects whatever it gets.

**Files to add:**
- `agents/hypertoy/sql-rules.js`
- `agents/thestock/sql-rules.js`
- `agents/newdeli/sql-rules.js`
- `agents/zer4u/sql-rules.js`

**Files to change:**
- `services/sql-generator.service.js` — replace the four `if` branches with a single dynamic require keyed on `schemaName`, returning `''` when no rules file exists.

**Acceptance:** zero mentions of `hypertoy`, `thestock`, `newdeli`, `zer4u` in `sql-generator.service.js`. Existing behavior identical.

### Step 2 — Auto-discover agents in `server.js`

Replace explicit `require('./agents/X/data-reload')` calls with a loop over `fs.readdirSync('./agents')`. Each agent folder may optionally export `data-reload.js`; if present, it is registered.

Same pattern for any other "list of agents" still present in `server.js`. Move CORS hosts into env.

### Step 3 — Routes from registry in `App.tsx`

Generate `<Route>` entries by mapping `AGENT_REGISTRY`. `App.tsx` stops naming individual agents. Each `AgentConfig` declares which page component it owns.

### Step 4 — Reorganize `pages/` by domain

```
src/pages/
├── core/         # Login, Home, NotFound
├── agents/<slug>/  # everything specific to one agent
├── internal/     # task-board, super-admin, dashboard, crew-editor UI
└── marketing/    # landing pages, pitch deck, docs/architecture pages
```

This makes step 5 a one-line build flag instead of a manual sweep.

### Step 5 — Build flag for client-specific builds

`BUILD_FOR=<slug>` on both server and client:
- Server: only mount routes used by `<slug>`'s agent + `core/`. Skip internal tools.
- Client: Vite/webpack plugin keeps `core/` + `agents/<slug>/`, drops `internal/` and `marketing/`.

After step 5, shipping a client's code is `BUILD_FOR=zer4u npm run build` plus copying the output. No manual cleanup.

---

## What we are NOT doing

- **Splitting Cloud Run into one service per agent.** Wrong solution to the white-label problem; runtime separation and source-code separation are orthogonal. Current single-server deploy stays.
- **Building a full plugin system / dynamic agent registration at runtime.** Overkill for the current scale. File-system layout is enough.
- **Migrating away from the shared `aspect-agents-db`** for non-data tables (conversations, tasks, users, agents registry). That is a separate, much bigger conversation about per-tenant DBs.

---

## Status

- [x] Audit
- [ ] Step 1 — SQL rules extraction (in progress)
- [ ] Step 2 — auto-discovery in `server.js`
- [ ] Step 3 — `App.tsx` routes from registry
- [ ] Step 4 — `pages/` domain reorg
- [ ] Step 5 — `BUILD_FOR` flag
