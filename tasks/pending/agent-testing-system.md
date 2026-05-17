# Task: Agent Testing System — Automated Conversation Testing

**Domain:** `general` (infra — agent-agnostic, with domain-specific configs per agent)
**Type:** Feature
**Priority:** High

---

## Background

We need a way to automatically test our agents by simulating real conversations with synthetic users and reviewing the results. The system is a **4-step pipeline**, where each step is a separate admin tool with reviewable output:

1. **Individuals Generator** — Generate a population of realistic synthetic personas.
2. **Populations** — Sample/mix individuals across motivations into a labeled, reusable test set.
3. **Conversation Simulator** — Run each persona in a population through a multi-turn conversation with the target agent and persist the transcript.
4. **Reviewer** — Evaluate each conversation against agent-specific criteria.

Each step produces output that must be reviewable before feeding into the next. This is not a one-click pipeline — it's 4 independent tools that chain together.

> **Note on history:** The original spec had 3 steps. During implementation, **Populations** was added as a separate step between Individuals and Conversations, because in practice testers want to sample/mix personas from many generation runs before running a batch of conversations. The UI was extended to 4 tabs accordingly.

---

## Status

| Step | Name | Status | Reference |
|------|------|--------|-----------|
| 1 | Individuals | **DONE** | [services/test-runner.service.js](../services/test-runner.service.js) + [components/dashboard/TestRunnerPage/](../../aspect-react-client/src/components/dashboard/TestRunnerPage/) |
| 2 | Populations | **DONE** | Same files (PopulationsTab in TestRunnerPage.tsx) |
| 3 | Conversations — Phase 0 (manual cockpit) | **DONE (2026-05-15)** | [agent-testing-step-3-conversations.md](./agent-testing-step-3-conversations.md) — see "Phase 0 Implementation Notes" |
| 3 | Conversations — Phase 1 (run-to-completion + batch) | **PENDING** | Same spec |
| 4 | Reviewer | **NOT STARTED** | — |

The Conversations tab in Test Runner and the Reviewer tab are still rendered disabled in the UI — Phase 0 of Step 3 ships with a per-persona cockpit entry point from the Individuals tab and a SyntheticControlPanel that replaces ChatInput inside synthetic conversations.

---

### Infra vs Domain-Specific

The testing infrastructure (DB tables, CRUD service, execute flow, UI shell, populations sampler) is **agent-agnostic**. Each agent provides its own:

- **Generator prompt** — what personas look like for this domain (fields, motivations, demographics).
- **Conversation prompt** (Step 3) — how the synthetic user behaves in roleplay.
- **Review criteria** (Step 4) — what capabilities to score (e.g., LYBI has 26 banking-specific capabilities).

These domain configs live in the DB (`test_configs`), with **file-based fallback** for first-time seeding from `test-prompts/{agentName}/`.

---

## Architecture

### Data Model

The shipped schema (in [db/schema/index.js:360-387](../db/schema/index.js#L360-L387)) has **two** tables, not one — `test_configs` was added beyond the original spec to store domain-specific config in DB:

#### `test_configs` (added during implementation, was NOT in the original spec)
Editable per-agent config (one row per agent), seeded from file on first use:

```
test_configs:
  id: serial PK
  agentName: varchar UNIQUE
  motivations: jsonb — array of { key, description }
  generatorPrompt: text — system prompt for individual generation
  userMessageTemplate: text — uses {{motivation}}, {{count}}
  personaSchema: jsonb (nullable)
  defaultModel: varchar (default 'gpt-4o')
  defaultCount: integer (default 10)
  metadata: jsonb — future: conversationPrompt, reviewerCriteria
  createdAt, updatedAt: timestamps
```

#### `test_runs`
One table for all step outputs, distinguished by `type`:

```
test_runs:
  id: serial PK
  type: 'individuals' | 'population' | 'conversation' | 'review'
  agentName: varchar — target agent being tested
  status: 'pending' | 'running' | 'completed' | 'failed'
  input: jsonb — parameters for the run (motivation, count, profile, etc.)
  output: jsonb — the generated result (personas array, population, transcript, report)
  parentRunId: integer (nullable) — chains steps together
  error: text (nullable)
  metadata: jsonb — timing, model used, token count
  createdAt, updatedAt: timestamps
```

### Server Structure

```
aspect-agent-server/
├── services/
│   └── test-runner.service.js      # CRUD + execute logic (infra). DB-with-file-fallback config.
├── test-prompts/
│   └── {agentName}/
│       ├── individual-generator.prompt.js   # Domain-specific (Step 1) — seeds test_configs on first use
│       ├── conversation-agent.prompt.js     # Domain-specific (Step 3 — pending)
│       └── reviewer.prompt.js               # Domain-specific (Step 4 — not started)
```

### Client Structure

```
aspect-react-client/src/
├── services/testRunnerService.ts
├── types/testRunner.ts
└── components/dashboard/TestRunnerPage/
    ├── TestRunnerPage.tsx              # Shell with 4 tabs + SettingsModal
    ├── TestRunnerPage.module.css
    └── (sub-components defined inline in TestRunnerPage.tsx)
        - IndividualsTab        ✅ shipped
        - PopulationsTab        ✅ shipped
        - ConversationsTab      ❌ pending — see step-3 spec
        - ReviewerTab           ❌ not started
        - SettingsModal         ✅ shipped (Step 1 fields; will be extended for Step 3)
```

### API Endpoints (all shipped)

```
GET    /api/admin/test-runs                 — List runs (?type=&agentName=&status=)
GET    /api/admin/test-runs/:id             — Get one run with full output
POST   /api/admin/test-runs                 — Create a run (pending)
POST   /api/admin/test-runs/:id/execute     — Trigger execution (currently only 'individuals' wired)
POST   /api/admin/test-runs/:id/save-output — Direct save (used by populations — no LLM needed)
PATCH  /api/admin/test-runs/:id             — Update input (e.g. rename a population)
DELETE /api/admin/test-runs/:id             — Delete a run
GET    /api/admin/test-runs/config/:agentName — Get config (DB with file fallback)
PUT    /api/admin/test-runs/config/:agentName — Update config in DB
```

Step 3 will add: `case 'conversation'` to `/execute`, and `POST /api/admin/test-runs/:id/simulate-population`.

---

## Step 1 — Individuals Generator (DONE)

Takes a `motivation` type and `count`, calls an LLM with the domain-specific generator prompt, returns a JSON array of realistic synthetic personas.

**Input:** `{ "motivation": "bad_experience", "count": 10, "model": "gpt-4o" }` (motivations defined per-agent in `test_configs.motivations`).

**Output:** JSON array of persona objects. Schema is domain-specific — for banking-onboarder, ~30 fields per persona (demographics, banking status, behavioral traits, motivation, difficulty, unique_fact).

**Implementation:** `testRunnerService.generateIndividuals(runId)` — uses `sendOneShot()` with `jsonOutput: true`. Auto-unwraps `{ individuals: [...] }` JSON-mode envelopes. Assigns globally unique IDs `<runId>-001`, `<runId>-002`, etc.

**UI:** `IndividualsTab` — agent-scoped motivation dropdown, count input, Generate button, run chips (pending/running/completed/failed), card grid with detail panel.

**Settings:** `SettingsModal` lets admins edit motivations (key+description), generator prompt template, user-message template, default model/count. Persisted to `test_configs`.

---

## Step 2 — Populations (DONE)

Takes individuals from one or more completed Step 1 runs and assembles them into a named, sized, labeled test set.

**Input:** `{ name, size, mode: 'random' | 'manual', percentages?: { motivation: pct } }`. Persisted as `test_runs` row with `type='population'`.

**Output:** Array of `IndividualProfile` objects (subset of the available pool).

**Implementation:** Client-side sampling (random or %-by-motivation), saved via `POST /api/admin/test-runs/:id/save-output` (no LLM call — pure data manipulation).

**UI:** `PopulationsTab` — pool summary, size+mode controls, % grid for manual mode, build/save/rename/delete saved populations, card grid with detail panel.

---

## Step 3 — Conversation Simulator (Phase 0 ✅ shipped · Phase 1 pending)

**See dedicated spec:** [agent-testing-step-3-conversations.md](./agent-testing-step-3-conversations.md).

Summary: drives synthetic personas through real conversations with the target agent using the **exact same code paths real users hit**. Synthetic users are real `users` rows (flagged `metadata.synthetic = true`); their conversations are real `conversations` rows visible at `/agent/conversations/:id`. The simulator is a robot client of our own chat API, not a special internal pathway.

**Phased delivery:**

- ✅ **Phase 0 — Manual cockpit (SHIPPED 2026-05-15):** From the Individuals tab, "Start synthetic conversation" on a persona creates a synthetic user + a real conversation + a `test_runs` row, returns a URL. The chat page detects synthetic conversations and renders a **SyntheticControlPanel** (Next turn / status / terminated state) instead of the regular input. The admin steps through one turn at a time by hand. Verified end-to-end with banking-onboarder-v2.
- **Phase 1 — Run-to-completion + Conversations tab (NEXT):** Adds "Run to completion" and "Stop" to the cockpit, plus a Conversations tab in Test Runner that batches a saved population serially (no concurrency). Purely additive on top of Phase 0.
- **Phase 2 (separate task, later):** Concurrency, scheduled runs, regression comparison.

**Key architecture decisions** (implemented in Phase 0, full detail in the step-3 spec):
- New non-streaming chat endpoint `POST /api/finance-assistant/turn` — buffered JSON variant of the existing SSE `/stream`. Thin wrapper over a shared `services/chat-turn.service.js` helper (`runChatTurn`) that the test-runner also calls directly. Microservice-friendly. Useful beyond the simulator (CI, debug tooling).
- New endpoint `POST /api/admin/test-runs/:id/turn` — atomic "advance one turn" call, the unit the cockpit fires per click and (in Phase 1) the run-to-completion loop will fire per iteration.
- Zero DB migrations. Synthetic flag in existing `users.metadata` jsonb. Conversation linkage to test run in existing `conversations.metadata` jsonb. Synthetic-user prompt in existing `test_configs.metadata` jsonb. ⚠️ Pre-existing gap: `test_runs`/`test_configs` tables exist in dev DB via ad-hoc creation but have no migration file (write 027 before prod).
- Users page gets `?includeSynthetic=true` filter (default off) + "Show synthetic users" toggle + 🤖 badge.
- Cockpit reads `conversation.metadata.synthetic` to decide whether to render `SyntheticControlPanel` instead of `ChatInput`. Persona summary comes from `test_runs.input.persona` (snapshot) with a fallback fetch of `users.metadata.persona` for old runs.

---

## Step 4 — Reviewer (NOT STARTED)

Takes a conversation transcript + persona profile. Two modes:
- `single` — per-conversation report with scored criteria.
- `aggregate` — summary across all conversations for a motivation group.

Review criteria are domain-specific (LYBI has 26 capabilities scored 1–10). Will be planned in a dedicated spec once Step 3 ships.

`parentRunId` links each review back to its conversation run.

---

## Out of Scope (current)

- Automated pipeline (running all 4 steps without review between them).
- Scheduling / cron-based test runs.
- Comparison between test runs over time (v2).
- A UI for editing the persona JSON schema (lives implicitly in the generator prompt for now).

---

## Files Touched (Steps 1 & 2 — shipped)

| File | Change |
|------|--------|
| `db/schema/index.js` | Added `testRuns` and `testConfigs` tables ([lines 360-387](../db/schema/index.js#L360-L387)) |
| `services/test-runner.service.js` | **New** — CRUD for runs and configs, `generateIndividuals()`, `saveOutput()` (for populations), DB-with-file-fallback `getConfig()` |
| `test-prompts/banking-onboarder-v2/individual-generator.prompt.js` | **New** — banking-onboarder generator prompt + 8 motivations (used as DB seed) |
| `server.js` | Added 9 `/api/admin/test-runs` endpoints ([5013-5146](../server.js#L5013-L5146)) |
| `src/types/testRunner.ts` | **New** — `TestRun`, `TestRunConfig`, `IndividualProfile`, `MotivationDef` |
| `src/services/testRunnerService.ts` | **New** — client API service |
| `src/components/dashboard/TestRunnerPage/` | **New** — 4-tab dashboard page; IndividualsTab + PopulationsTab + SettingsModal implemented; Conversations/Reviewer tabs render disabled |
| `src/pages/DashboardPage.tsx` | Route for test-runner |
| `src/components/dashboard/DashboardLayout/DashboardLayout.tsx` | Nav item |

---

## Acceptance Criteria (Steps 1 & 2 — met)

- [x] Admin can create an "individuals" test run by selecting agent, motivation, and count.
- [x] Executing the run calls the LLM and returns a JSON array of personas.
- [x] Each persona is realistic — varied names, demographics, behavioral traits per the generator prompt.
- [x] Output is stored in DB and reviewable in the dashboard.
- [x] Run history shows past runs with status (pending/running/completed/failed).
- [x] Failed runs show the error message.
- [x] The generator prompt is domain-specific (lives per-agent in DB with file fallback), not hardcoded in the service.
- [x] Admin can sample individuals across motivations into a named, reusable Population (random or manual %).
- [x] Saved populations are renameable and deletable.

Acceptance criteria for Steps 3 and 4 live in their respective spec files.
