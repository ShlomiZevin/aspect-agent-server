# Task: Agent Testing — Step 3: Conversation Simulator

**Parent spec:** [agent-testing-system.md](./agent-testing-system.md)
**Domain:** `general` (infra) + `banking-onboarder-v2` (first domain consumer)
**Type:** Feature
**Priority:** High
**Status:** **Phase 0 SHIPPED (2026-05-15)** · Phase 1 pending · Phase 2 future

> **Phase 0 verified working end-to-end:** admin starts a synthetic conversation from a persona → opens the chat URL → SyntheticControlPanel renders → clicking "Next turn" produces a Hebrew opening from the synthetic user, a Libi/welcome-crew reply, turn counter advances 0/30 → 1/30, full crew journey lights up. See "Phase 0 Implementation Notes" at the bottom of this doc.

---

## Goal

Drive synthetic personas through real conversations with the target agent — through the **exact same code paths** real users hit. The simulator is a "robot client" of our own chat API, not a special internal pathway.

**Synthetic conversations must be indistinguishable from real ones** as far as the dispatcher, crew system, KB, tools, and chat UI are concerned. They live in the real `users`, `conversations`, and `messages` tables, accessible via the regular `/agent/conversations/:id` URL.

---

## Guiding Principles

1. **Exact production flow, just server-driven.** No special simulator pathway in the dispatcher. Synthetic conversations call the same chat API the browser calls.
2. **Microservices, small endpoints.** Each step (upsert user, generate next persona utterance, run one chat turn, advance one conversation turn) is its own callable endpoint. Composable and independently debuggable.
3. **Turn-by-turn first, automation later.** Build the manual cockpit before the auto-runner. If you can step through one conversation by hand, you've earned the right to automate.
4. **No concurrency in v1.** One turn at a time, one conversation at a time. Performance comes later.
5. **Zero schema migrations.** Use the existing `metadata` jsonb columns on `users` and `conversations` for tagging.

---

## Phased Delivery

### Phase 0 — Manual cockpit ✅ SHIPPED

**Outcome:** From the Test Runner's Individuals tab, the admin clicks a persona → clicks "Start synthetic conversation" → gets a conversation URL. They open it in the chat UI, which detects it's synthetic and renders a **SyntheticControlPanel** instead of the regular input box. Clicking "Next turn" advances the conversation by exactly one user→assistant exchange. They can step manually, indefinitely, until the run terminates or they close the tab.

This phase exists so we can verify the entire wiring (synthetic user, real conversation, dispatcher integration, transcript persistence) with our own eyes before automating anything.

**Status:** verified working with banking-onboarder-v2 on 2026-05-15. Synthetic user generated a contextual Hebrew opening for a `first_account`/student persona, agent's welcome crew responded in character, crew journey advanced correctly, transcript appended to `test_runs.output.transcript`, both messages persisted in the regular `messages` table.

### Phase 1 — Run-to-completion + Conversations tab

**Outcome:** A "Run to completion" button on the cockpit loops turns server-side until termination, polling pushes updates to the UI. The Conversations tab in Test Runner lets the admin pick a saved population and run each persona serially (no concurrency). Per-persona progress chips, transcript viewer.

### Phase 2 (later, separate task) — Concurrency, scheduled runs, batch comparison

Out of scope here.

---

## Architecture

### Synthetic users are real `users` rows

**Flag location:** `users.metadata` jsonb at [db/schema/index.js:44](../db/schema/index.js#L44) — already exists.

```js
users.metadata = {
  synthetic: true,
  persona: { /* the full IndividualProfile JSON from Step 1 */ },
  populationRunId: 123  // null if seeded directly from Individuals tab
}
```

- **One persona = one user**, reused across all conversations for that persona.
- Stable `externalId = "synthetic-<populationRunId>-<persona.id>"` (or `"synthetic-direct-<persona.id>"` for direct-from-individuals).
- Re-running on the same persona reuses the same user row — multiple conversations attach to it, exactly like a real user with a history.

**Users page filter:** `GET /api/admin/users` ([server.js:3691](../server.js#L3691)) gets an `?includeSynthetic=true` query param. Default behavior excludes synthetic users via `WHERE (metadata->>'synthetic' IS NULL OR metadata->>'synthetic' = 'false')`. UsersPage.tsx header gets a "Show synthetic users" toggle that flips it.

### Synthetic conversations are real `conversations` rows

**Flag location:** `conversations.metadata` jsonb at [db/schema/index.js:59](../db/schema/index.js#L59) — already exists.

```js
conversations.metadata = {
  synthetic: true,
  testRunId: 456,              // links back to the test_runs row
  populationRunId: 123,        // null if direct
  individualId: "123-005"
}
```

The chat page reads `conversation.metadata.synthetic` on load and, if true, renders the cockpit instead of the regular input.

### Call the chat API like a browser would — `POST /api/finance-assistant/turn`

The current chat endpoint [server.js:1839](../server.js#L1839) is SSE-only. The simulator needs a **non-streaming variant** that buffers the dispatcher's output and returns JSON. We'll add:

```
POST /api/finance-assistant/turn
  Body: same shape as /stream — { message, conversationId, userId, agentName, ... }
  Behavior: runs dispatcherService.dispatch() to completion, buffers reply,
            performs the same DB writes (user msg + assistant msg + transitions)
  Response: { reply, crewMember, conversationId, transitionedTo?, modelUsed, durationMs }
```

Implementation: extract the dispatcher loop body from the existing `/stream` handler into a shared helper. The `/stream` handler keeps SSE; the new `/turn` handler buffers and returns JSON. ~50 LOC shared, ~30 new.

This endpoint isn't only useful to the simulator — anyone scripting the agent (CI, debug tooling, future LLM-as-judge) gets a clean JSON API.

### Synthetic-user prompt — `llmService.sendOneShot()` with JSON output

```js
const responseText = await llmService.sendOneShot(
  systemPrompt,   // editable per-agent, with {{persona_json}} / {{motivation_description}} injected
  userPrompt,     // transcript so far + "what would they say next?"
  { model, jsonOutput: true, context: 'test-runner-synthetic-user' }
);
const { message, end, reason } = JSON.parse(responseText);
```

**System prompt** lives in `test_configs.metadata.conversationPrompt` (jsonb — no migration; schema comment at [db/schema/index.js:369](../db/schema/index.js#L369) already anticipates this). Seeded from `test-prompts/banking-onboarder-v2/conversation-agent.prompt.js` on first use, then editable in the Settings modal.

**Output shape:** `{ "message": "...", "end": false, "reason"?: "..." }`. The `end: true` flag is the clean termination signal — no sentinel parsing.

---

## API — Microservice Endpoints

All endpoints live under `/api/admin/` and are independently callable.

### 1. `POST /api/admin/test-runner/synthetic-users/upsert`

Get-or-create a synthetic user from a persona. Idempotent.

```
Body:    { persona: IndividualProfile, populationRunId?: number }
Returns: { userId, externalId, name, created: boolean }
```

Logic: derive `externalId = "synthetic-<populationRunId>-<persona.id>"` (or `"synthetic-direct-<persona.id>"`), upsert into `users` with `metadata.synthetic=true` and `metadata.persona=<persona>`.

### 2. `POST /api/admin/test-runner/conversations/start`

The **Phase 0 entry point**. Creates everything needed for a fresh synthetic conversation and returns the URL.

```
Body:    { agentName, persona | personaId, maxTurns?, model? }
Returns: { testRunId, conversationId, conversationUrl, userId }
```

Logic:
1. Upsert synthetic user (calls #1).
2. Create empty `conversations` row tagged `metadata.synthetic=true`, `metadata.testRunId=<placeholder>`, `externalId = "test-<testRunId>-<personaId>"`.
3. Create `test_runs` row of `type='conversation'`, `input = { agentName, personaId, userId, conversationId, maxTurns, model }`, `output = { transcript: [] }`, `status='running'`.
4. Update the conversation's `metadata.testRunId` to the new run id (resolves the placeholder).
5. Return the URL: `/<agentUrlSlug>/conversations/<conversationExternalId>`.

After this call, the admin opens the URL — the chat page renders with the SyntheticControlPanel ready to step.

### 3. `POST /api/admin/test-runner/synthetic-user/next-message`

Generate the persona's next utterance. Pure roleplay LLM call, no DB writes.

```
Body:    { persona, transcript, agentName }
Returns: { message, end, reason? }
```

Calls `sendOneShot` with the agent's saved `conversationPrompt`. Useful on its own for debugging the persona prompt without firing off a real conversation.

### 4. `POST /api/finance-assistant/turn`

Non-streaming chat — drives one user→assistant turn through the real dispatcher. (Described above.)

### 5. `POST /api/admin/test-runs/:id/turn`

**The atomic unit of the simulator.** Advances ONE turn of a synthetic conversation. Stateless: reads the test_runs row, decides what to do.

```
Body:    {} (everything comes from the run row)
Returns: { run, terminated, lastUserMessage?, lastAssistantReply? }
```

Logic:
1. Load `test_runs` row. If `status ∈ {completed, failed, cancelled}` → return as-is, `terminated: true`.
2. If `turnCount >= maxTurns` → mark `completed` with `terminationReason='max_turns'`, return.
3. Build transcript from `output.transcript` so far.
4. Call (3) `next-message`. If `end: true` → mark `completed` with `terminationReason='end_signal'`, save end reason, return.
5. Call (4) `POST /api/finance-assistant/turn` with the synthetic user's message.
6. Append both `{role:'user', content}` and `{role:'assistant', content, crewMember}` to `output.transcript`, increment `turnCount`, save run.
7. Return `{ run, terminated: false, lastUserMessage, lastAssistantReply }`.

Errors during the turn → mark `failed`, save `error`, return.

### 6. `POST /api/admin/test-runs/:id/run-to-completion` (Phase 1)

Server-side loop calling #5 until `terminated`. No concurrency. Returns the final run state.

### 7. `POST /api/admin/test-runs/:id/cancel` (Phase 1)

Sets a `cancelled: true` flag in the run row. The run-to-completion loop checks this between turns and stops cleanly.

---

## UI

### Phase 0 — entry point from Individuals tab

In `TestRunnerPage.tsx` → `IndividualsTab`, when the admin clicks a persona card to open the detail panel, add a button at the top of the detail panel:

```
[ ▶ Start synthetic conversation ]
```

Clicking it:
1. POSTs `/api/admin/test-runner/conversations/start` with `{ agentName, persona }`.
2. On response, opens `conversationUrl` in a new tab.

### Phase 0 — SyntheticControlPanel on the chat page

When the chat page loads a conversation (via `useConversation`), it gets the conversation row including `metadata`. If `metadata.synthetic === true`:

- The regular `ChatInput` is **replaced** (not augmented) with a new `SyntheticControlPanel` component.
- The human shouldn't type into a synthetic conversation; the synthetic LLM types.

**Panel UI (Phase 0):**

```
┌────────────────────────────────────────────────────────────┐
│ 🤖 Synthetic conversation                                  │
│ Persona: דנה כהן · age 34 · offer_driven · difficulty קשה  │
│ Status: running · Turn 4/30                                │
│                                                            │
│  [ ▶ Next turn ]                  [ × Close ]              │
└────────────────────────────────────────────────────────────┘
```

- **Next turn** → `POST /api/admin/test-runs/<testRunId>/turn`. On response:
  - If `terminated`: switch to terminated state (see below).
  - Otherwise: append `lastUserMessage` and `lastAssistantReply` to the chat bubble list (or refetch history — both work).

**Terminated state:**

```
┌────────────────────────────────────────────────────────────┐
│ ✓ Completed · 12 turns · reason: end_signal                │
│ "I've gotten what I needed, thanks!"                       │
│                                                            │
│  [ View in Test Runner ]                                   │
└────────────────────────────────────────────────────────────┘
```

### Phase 1 additions to the panel

```
[ ▶ Next turn ]   [ ⏩ Run to completion ]   [ ⏸ Stop ]
```

- **Run to completion** → POSTs `/run-to-completion`. The panel switches to "running…" with a 2s poll on `GET /api/admin/test-runs/<testRunId>`. New messages appear in the chat as they're saved.
- **Stop** → POSTs `/cancel`. The server-side loop stops between turns.

### Phase 1 — Conversations tab in Test Runner

Currently disabled. In Phase 1:
- Pick a saved population (dropdown).
- Set maxTurns (default 30) and model.
- "Run" button creates one test_run per individual, posts them to `/run-to-completion` one by one (no concurrency).
- Per-individual chips: pending / running / completed / failed.
- Click a chip → opens the conversation URL in a new tab (same view as Phase 0).
- Run history list of past conversation runs across this agent.

### Users page — synthetic toggle

`UsersPage.tsx` header gets:

```
[ ☐ Show synthetic users ]
```

Default off. When on, `getUsers()` adds `?includeSynthetic=true`. A small "🤖" badge appears next to synthetic user rows.

---

## Data Model

**No DB migrations needed for Phase 0.** Everything goes into existing jsonb columns.

> ⚠️ **Pre-existing gap (not blocking Phase 0):** the `test_runs` and `test_configs` tables are defined in [db/schema/index.js](../db/schema/index.js) but were never added via a versioned migration file (latest is `026`). Local dev DB has them because they were created ad-hoc when Steps 1 & 2 were built. Before this code ships to prod or a fresh environment, write **migration 027 — create test runner tables** (`CREATE TABLE IF NOT EXISTS`) plus optional partial indexes on `users.metadata->>'synthetic'` and `conversations.metadata->>'synthetic'` for fast filtering.

| Table | Field | New values |
|---|---|---|
| `users` | `metadata` jsonb | `{ synthetic: true, persona: {...}, populationRunId? }` |
| `conversations` | `metadata` jsonb | `{ synthetic: true, testRunId, populationRunId?, individualId }` |
| `test_configs` | `metadata` jsonb | `{ ...existing, conversationPrompt: { systemPrompt, userMessageTemplate, defaultMaxTurns, defaultModel } }` |
| `test_runs` | (existing) | New `type='conversation'` rows |

`test_runs` shape for a conversation run:

```js
{
  id, type: 'conversation', agentName, status,
  input:  { agentName, personaId, userId, conversationId, maxTurns, model },
  output: {
    transcript: [{ role, content, crewMember? }, ...],
    conversationId,        // for convenience
    terminationReason,     // 'end_signal' | 'max_turns' | 'failed' | 'cancelled'
    turnCount
  },
  parentRunId,             // population run id, if applicable
  metadata: { elapsed_ms, cancelled?: boolean }
}
```

---

## Files to Touch

### Phase 0

**Server:**

| File | Change |
|---|---|
| **New**: `services/synthetic-user.service.js` | `upsertSyntheticUser({ persona, populationRunId })` — derives externalId, upserts users row |
| **New**: `services/test-runner-conversation.service.js` *(or extend `test-runner.service.js`)* | `startConversation({ agentName, persona, maxTurns, model })`, `advanceTurn(runId)`, `generateNextMessage({ persona, transcript, agentName })` |
| `server.js` ([5055-5075](../server.js#L5055-L5075) and nearby) | Add endpoints #1, #2, #3, #5 from the API list above |
| `server.js` ([1839](../server.js#L1839)) | Extract dispatcher loop into a shared helper; add `POST /api/finance-assistant/turn` (endpoint #4) |
| **New**: `test-prompts/banking-onboarder-v2/conversation-agent.prompt.js` | Seed `systemPrompt` + `userMessageTemplate` for banking persona roleplay |
| `services/test-runner.service.js` `getConfig()` | Extend file-fallback to seed `metadata.conversationPrompt` from new prompt file |
| `server.js` users endpoint at [3691](../server.js#L3691) | Add `?includeSynthetic=true` query param |

**Client:**

| File | Change |
|---|---|
| **New**: `src/components/chat/SyntheticControlPanel/SyntheticControlPanel.tsx` (+ .module.css) | The cockpit component — Phase 0 has just "Next turn" + status + terminated state |
| Chat container (TBD — likely `ChatContainer.tsx` or wherever `ChatInput` is rendered) | Conditional: render `SyntheticControlPanel` instead of `ChatInput` when `conversation.metadata?.synthetic === true` |
| `useConversation` hook | Ensure `conversation.metadata` is included in the conversation data passed to the page (verify it isn't being stripped) |
| `src/services/testRunnerService.ts` | Add `startSyntheticConversation(opts)`, `advanceTurn(runId)`, `upsertSyntheticUser(persona)` |
| `src/types/testRunner.ts` | Add `SyntheticUser`, `ConversationTurn`, `ConversationTranscript`, `StartConversationResponse` |
| `src/components/dashboard/TestRunnerPage/TestRunnerPage.tsx` | Add "Start synthetic conversation" button in `IndividualDetail` panel |
| `src/components/dashboard/UsersPage/UsersPage.tsx` | "Show synthetic users" toggle + 🤖 badge column |
| `src/services/adminService.ts` (or wherever `getUsers()` lives) | Pass `includeSynthetic` flag through |

### Phase 1

**Server:**
- `runConversationToCompletion(runId)` + endpoint #6
- `cancelConversationRun(runId)` + endpoint #7

**Client:**
- `SyntheticControlPanel` gains "Run to completion" + "Stop" buttons + polling
- `ConversationsTab` in `TestRunnerPage.tsx` — population picker, batch runner, chip grid, transcript viewer
- `Conversations` tab in `TestRunnerPage.tsx` no longer disabled

---

## Verification

### Phase 0 smoke test

1. Generate 1 persona (Individuals tab).
2. Click the persona card → "Start synthetic conversation".
3. New tab opens at `/banking-v2/conversations/<id>`.
4. The chat page shows the SyntheticControlPanel, not the input box.
5. Click "Next turn". Within ~5s, a user bubble appears (the synthetic user's first message) followed by an assistant bubble (the agent's reply, with a crew tag).
6. Click "Next turn" again. Another exchange appears.
7. Repeat ~10x. The agent's responses reflect the persona's motivation / personality / difficulty.
8. Optionally let the synthetic user emit `end: true` (will happen naturally for some personas) — the panel switches to terminated state.
9. **`SELECT * FROM users WHERE metadata->>'synthetic' = 'true'`** — should show one row with the persona JSON in metadata.
10. **`SELECT * FROM conversations WHERE metadata->>'synthetic' = 'true'`** — should show the one conversation, with `metadata.testRunId` set.
11. **`SELECT id, status, jsonb_array_length(output->'transcript') AS turns FROM test_runs WHERE type='conversation'`** — turns should match the number of "Next turn" clicks.
12. Open the Users page (default view) — synthetic user must NOT appear. Toggle "Show synthetic users" — it appears with a 🤖 badge.
13. Open HistorySidebar in banking-v2 — synthetic conversation must NOT appear.

### Phase 1 smoke test

1. With a saved population of 3, open Conversations tab in Test Runner.
2. Click "Run" — 3 chips appear pending → running (one at a time) → completed.
3. Click each chip — conversation URL opens.
4. Pick one and on the chat page, click "Run to completion" mid-run on a manually-created one — agent and synthetic user alternate without manual clicks; status updates to completed.

---

## Open Questions

1. **Where does the chat page get `conversation.metadata`?** Need to verify `useConversation` passes it through. If not, small fix in `conversationService.ts` history fetch.
2. **Naming of the chat URL when conversation is synthetic.** Just the standard `<agent>/conversations/<externalId>` is fine — no naming convention change needed.
3. **Reset / replay a synthetic conversation.** Defer to Phase 2. For now, "fresh start" = click "Start synthetic conversation" again from the persona (creates a new test_run + conversation).
4. **Profiler / thinking advisor for synthetic conversations.** They cost tokens and don't add testing value. Add a `restrictedMode`-style flag forwarded by `/api/finance-assistant/turn` to the dispatcher to suppress them. Decide during Phase 0 implementation.
5. **`test_runs.parentRunId` for direct-start (no population).** Leave null. Population-driven runs in Phase 1 set it to the population run id.

---

## Acceptance Criteria

### Phase 0 ✅
- [x] From Individuals tab, clicking "Start synthetic conversation" creates: one `users` row (synthetic), one `conversations` row (synthetic, with `testRunId`), one `test_runs` row (type=`conversation`, status=`running`, empty transcript). Returns a conversation URL.
- [x] Opening that URL shows the regular chat page with the `SyntheticControlPanel` in place of the input.
- [x] "Next turn" advances exactly one user→assistant exchange, both saved to the messages table, both reflected in the chat UI, both appended to `test_runs.output.transcript`.
- [ ] After enough "Next turn" clicks (or persona-driven `end`), the run terminates and the panel shows the terminated state. *(end_signal path implemented but not yet observed in a long-running test — needs a real conversation to reach a natural end.)*
- [x] Users page hides synthetic users by default; "Show synthetic users" toggle reveals them.
- [x] HistorySidebar (banking-v2 or any agent) does NOT show synthetic conversations. *(They belong to synthetic users only, so user-scoped queries filter them out automatically.)*
- [x] `POST /api/finance-assistant/turn` works as a non-streaming variant — independently testable with curl.
- [x] No DB migration was required.

### Phase 1
- [ ] "Run to completion" on the cockpit drives the conversation to termination server-side; panel updates via polling.
- [ ] "Stop" cancels a running conversation cleanly between turns.
- [ ] Conversations tab in Test Runner runs a saved population serially (one at a time), creating one conversation per persona.
- [ ] Per-individual chips show pending/running/completed/failed; click → opens conversation URL.
- [ ] Failed conversations persist `status='failed'` with `error` populated and don't stop the rest of the batch.

---

## Out of Scope (Step 3)

- Reviewer scoring (Step 4).
- Concurrency / parallel conversation runs.
- Comparing transcripts across runs.
- Conversation replay / reset.
- Editing persona schema from UI.

---

## Phase 0 Implementation Notes (2026-05-15)

### Files actually created / modified

**Server (new)**
- [services/synthetic-user.service.js](../services/synthetic-user.service.js) — `upsert({ persona, populationRunId })`. Idempotent. Writes `users.metadata.synthetic = true`, `users.metadata.persona = <profile>`, deterministic `externalId = synthetic-(pop<id>|direct)-<personaId>`.
- [services/chat-turn.service.js](../services/chat-turn.service.js) — exports `runChatTurn(opts)`. Buffered, non-streaming version of the dispatcher loop. Same DB writes as the SSE `/stream` handler (user msg + assistant msg + pre/post-transfer transitions + usage logging). Used by both the HTTP `/turn` endpoint and the test-runner's `advanceConversationTurn`.
- [test-prompts/banking-onboarder-v2/conversation-agent.prompt.js](../test-prompts/banking-onboarder-v2/conversation-agent.prompt.js) — first-time seed for `test_configs.metadata.conversationPrompt`. Hebrew persona-roleplay system prompt with `{{persona_json}}`, `{{motivation_description}}`, `{{name}}`, `{{transcript}}` placeholders. Output shape `{ message, end, reason? }`.

**Server (modified)**
- [services/test-runner.service.js](../services/test-runner.service.js)
  - `getConfig()` now lazily seeds `metadata.conversationPrompt` from the new prompt file (handles both first-time seed and backfill into existing configs).
  - New: `startConversation({ agentName, persona, populationRunId, maxTurns, model })` — upserts user, creates `conversations` row tagged synthetic, creates `test_runs` row of type `conversation` (snapshots the full persona into `input.persona`), returns conversation URL.
  - New: `generateNextMessage({ persona, transcript, agentName })` — pure `sendOneShot` call against `conversationPrompt`. No DB writes. Returns `{ message, end, reason? }`.
  - New: `advanceConversationTurn(runId)` — the atomic per-turn unit. Reads run, generates next user message, calls `runChatTurn`, appends both turns to transcript, persists. Handles max_turns / end_signal / failure terminations.
  - Private: `_loadPersonaForRun(input)` — falls back to `users.metadata.persona` if the run was created before persona-in-input.
- [server.js](../server.js)
  - `POST /api/finance-assistant/turn` — thin wrapper over `runChatTurn`.
  - `POST /api/admin/test-runner/synthetic-users/upsert`
  - `POST /api/admin/test-runner/conversations/start` (Phase 0 entry point)
  - `POST /api/admin/test-runner/synthetic-user/next-message`
  - `POST /api/admin/test-runs/:id/turn`
  - `GET /api/admin/users` — added `?includeSynthetic=true` query param.
  - `GET /api/conversation/:id/history` — now also returns `metadata` on the conversation, so the chat client can detect synthetic mode.
- [services/admin.service.js](../services/admin.service.js) — `getUsers` defaults to `WHERE metadata->>'synthetic' IS DISTINCT FROM 'true'`; `?includeSynthetic=true` opts out.

**Client (new)**
- [src/components/chat/SyntheticControlPanel/](../../aspect-react-client/src/components/chat/SyntheticControlPanel/) — cockpit component. Status dot + persona summary + ▶ Next turn button + terminated state. Falls back to fetching `users.metadata.persona` via `GET /api/admin/users/:id` when `run.input.persona` is missing (handles runs created before persona-in-input).

**Client (modified)**
- [src/types/testRunner.ts](../../aspect-react-client/src/types/testRunner.ts) — added `ConversationTurn`, `ConversationOutput`, `StartConversationResponse`, `AdvanceTurnResponse`, `SyntheticUserUpsertResponse`, `ConversationMetadata`.
- [src/services/testRunnerService.ts](../../aspect-react-client/src/services/testRunnerService.ts) — added `startSyntheticConversation`, `advanceConversationTurn`, `upsertSyntheticUser`, `previewSyntheticUserMessage`.
- [src/types/admin.ts](../../aspect-react-client/src/types/admin.ts) + [src/services/adminService.ts](../../aspect-react-client/src/services/adminService.ts) — `AdminUserFilters.includeSynthetic` plumbed through to query param.
- [src/services/conversationService.ts](../../aspect-react-client/src/services/conversationService.ts) — `getConversationHistory` now returns `metadata`.
- [src/hooks/useChat.ts](../../aspect-react-client/src/hooks/useChat.ts) — `loadHistory` returns `metadata`.
- [src/context/ChatContext.tsx](../../aspect-react-client/src/context/ChatContext.tsx) — adds `conversationMetadata` state, populated from all 4 `loadHistory` call sites (initial mount, switchToChat, linkPhone, goMobile). Exposed on the context value.
- [src/components/chat/ChatContainer/ChatContainer.tsx](../../aspect-react-client/src/components/chat/ChatContainer/ChatContainer.tsx) — conditional render: `conversationMetadata?.synthetic === true ? <SyntheticControlPanel /> : <ChatInput />`.
- [src/components/dashboard/TestRunnerPage/TestRunnerPage.tsx](../../aspect-react-client/src/components/dashboard/TestRunnerPage/TestRunnerPage.tsx) — added "▶ Start synthetic conversation" button to `IndividualDetail`. Opens the conversation URL in a new tab.
- [src/components/dashboard/UsersPage/UsersPage.tsx](../../aspect-react-client/src/components/dashboard/UsersPage/UsersPage.tsx) — "Show synthetic users" checkbox in the filter row + 🤖 badge column rendering when `user.metadata?.synthetic === true`.

### Late tweaks during smoke testing

1. **Persona snapshot in `run.input`** — initially I only stored `personaId`; the cockpit's "Loading persona…" label hung forever because the full persona JSON wasn't on the run. Fixed by snapshotting the full persona into `run.input.persona` at `startConversation` time.
2. **Cockpit fallback fetch** — even with (1), the run already running at the time of the fix didn't have a persona snapshot. Added a fallback `useEffect` in the cockpit that fetches the synthetic user via `GET /api/admin/users/:id` and pulls `metadata.persona` when `run.input.persona` is missing. Handles old runs without restart.

### Microservice composition (the actual call graph)

```
Click "▶ Start synthetic conversation"
  → POST /api/admin/test-runner/conversations/start
      → syntheticUserService.upsert            (creates/reuses users row)
      → INSERT test_runs (type='conversation') (with persona snapshot in input)
      → INSERT conversations (metadata.synthetic=true, metadata.testRunId)
      → returns { testRunId, conversationUrl, ... }
  → window.open(conversationUrl)               (new tab)

Open the chat URL in new tab
  → GET /api/conversation/:id/history          (returns metadata.synthetic=true)
  → ChatContext.conversationMetadata populated
  → ChatContainer renders <SyntheticControlPanel />
  → cockpit fetches GET /api/admin/test-runs/:id

Click "▶ Next turn"
  → POST /api/admin/test-runs/:id/turn
      → testRunnerService.advanceConversationTurn
          → generateNextMessage                 (llmService.sendOneShot, jsonOutput)
          → runChatTurn                          (dispatcher loop, buffered)
              → conversationService.saveUserMessage
              → dispatcherService.dispatch       (crew, KB, tools — all production)
              → conversationService.saveAssistantMessage
          → append both turns to test_runs.output.transcript
  → cockpit re-fetches conversation history
  → both new bubbles appear in the chat
```

### What did NOT change

- No DB migration (only existing jsonb columns used).
- No changes to the regular SSE chat endpoint `/api/finance-assistant/stream`. The legacy path is untouched; the new `/turn` lives alongside it.
- No changes to the dispatcher, crew system, KB, tools, or thinking advisor. Synthetic conversations flow through the same production code path.
- No changes to the `messages` table schema or write path. Synthetic messages are real messages.

### Phase 1 hand-off

Phase 1 is purely additive on top of Phase 0:
- Add `POST /api/admin/test-runs/:id/run-to-completion` (server-side loop calling `advanceConversationTurn`).
- Add `POST /api/admin/test-runs/:id/cancel` (sets a `cancelled` flag the loop checks).
- Add "⏩ Run to completion" and "⏸ Stop" buttons to `SyntheticControlPanel` with 2s polling on the run.
- Enable the disabled Conversations tab in `TestRunnerPage`. Build `ConversationsTab` that picks a saved population, runs each persona serially.

Nothing built in Phase 0 needs to change for Phase 1.
