# Builder V2 — Runtime Wiring Plan

> Plan for connecting the V2 builder to a real LLM runtime so the
> **User Chat** panel can send a message, watch every addon execute
> with its prompt + raw output + parsed result, see the Talker's
> response streamed token-by-token, persist the whole turn for
> later inspection, and play back any historical message's runs.
>
> Read this together with [BUILDER_V2.md](./BUILDER_V2.md) for the
> data model and decisions journal. This doc focuses on the
> server-side runtime + client wiring that makes the builder JSON
> actually runnable.

---

## Goal

The first satisfying loop end-to-end:

1. User types a message in the User Chat panel of the builder.
2. Server runs the **viewing** crew version of the viewing agent
   through its **Blocking lane** addons in order — today
   `Field Extractor` then `Talker`.
3. Every addon's **assembled prompt**, **raw output**, **parsed
   result**, **memory writes**, and **token usage** stream live to
   the client. The user sees per-addon cards lighting up as each
   step runs.
4. The Talker's text streams token-by-token into the transcript.
5. The whole turn is persisted: the user message, the assistant
   message, one `addon_runs` row per addon, and every LLM call into
   the existing `llm_usage` table.
6. Any past assistant message can be expanded to replay the same
   per-addon timeline from the persisted data.

---

## Locked decisions

1. **Server persistence is authoritative.** The client writes
   through on Save / Save As / Set Active. The runtime fetches
   from DB on every run — no full doc in the request body.
2. **Run uses the *viewing* version.** Preview semantics. Active
   is reserved for the (future) customer-facing runtime.
3. **Dirty working copy → warning, no autosave.** If the local
   working copy differs from the viewing version's persisted
   snapshot, the UserChat shows a small chip ("Unsaved changes
   won't be included — Save first to include them"). Run still
   proceeds using the persisted state.
4. **No reuse of `/api/finance-assistant/*`.** Builder-only doc
   CRUD lives under `/api/builder/*`. The shared **runtime + history**
   surface lives under `/api/agents/:slug/*` so a future customer-
   facing v2 chat can call the same endpoints (with `version: 'active'`)
   without renaming anything.
5. **v1 customer-facing chat is unaffected.** Old endpoints +
   dispatcher + `CrewMember` runtime continue to power it.
6. **Conversation owner = the existing localStorage dummy user id**
   (same mechanism v1 uses today).
7. **`addon_runs` retention = forever** at first. Bulk-delete by
   `conversation_id` for cleanup.
8. **Memory writes are conversation-scoped.** User-scoped memory
   stays untouched until domains gain TTL/scope settings (Backlog).
9. **Real token streaming** for Talker via `llm.js`'s existing
   provider streaming. New SSE event: `addon.token`.
10. **Client UUIDs accepted by the server.** The client generates
    new version ids (`uid('ver')`) locally; the server stores what
    it's given. Lets Save As feel instant — local state updates
    immediately, the server call confirms.
11. **Client model stays nested.** `BuilderContext` keeps the
    `ProjectDoc` shape it has today (agents own crews, versions
    inside the entity). An adapter on `GET /api/builder/projects`
    denormalizes the response; all mutations call surgical
    endpoints. Two shapes stay in sync via `BuilderContext` only.
12. **Phased delivery — three phases:**
    - **P1**: Persistence layer + first runnable user-chat.
    - **P2**: `addon_runs` + memory writes + history reads.
    - **P3**: Historical view.

---

## Architecture: data flow

```
                  Builder UI
                       │
                       │  Save / Save As / Set Active
                       │  → surgical PUT/POST to /api/builder/*
                       ▼
        ┌──────────────────────────────────────────────┐
        │  projects · agents · agent_versions ·         │
        │  crews · crew_versions   (server DB)          │
        └──────────────────────────────────────────────┘
                       ▲
                       │ GET on builder load (one request,
                       │ denormalized response — full ProjectDoc shape)
                       │
                       │ READ ON RUN (resolve viewing versions)
                       │
                  Builder UI (User Chat)
                       │
                       │  POST /api/agents/:slug/conversations/:cId/messages
                       │  body: { userMessage, version: 'viewing' }
                       ▼
                  [Express handler] ── opens SSE ──┐
                       │                            │
                       ▼                            │
                  [BuilderRunner]                   │
                       ├─ resolve agent.viewing → body → defaultCrewId
                       ├─ resolve crew.viewing → body → addons
                       ├─ load history + (P2) memory
                       │
                       ├─ for each blocking-lane addon:
                       │     1. assemble prompt (promptAssembler)
                       │     2. emit SSE: addon.start / addon.prompt
                       │     3. call llm.js (streaming for Talker) → llm_usage row
                       │           Talker: emit SSE: addon.token … (real streaming)
                       │     4. parse output by outputType
                       │     5. (P2) memory writes via context.service
                       │     6. emit SSE: addon.output
                       │     7. (P2) INSERT addon_runs row
                       │
                       ├─ INSERT user + assistant rows into messages
                       └─ emit SSE: done
```

---

## Data model

### Schema — five new tables (P1)

The principle: **shell rows hold identity + pointers + cheap
metadata as columns; bodies that evolve in shape stay in `jsonb`.**
No nested JSON-inside-JSON; versions are first-class rows.

**`projects`** — top entity. Plain columns, no JSON body.

```
id              uuid pk
owner_user_id   text
name            text
spec            text
created_at      timestamptz
updated_at      timestamptz
```

**`agents`** — shell only. Identity + pointers.

```
id                   uuid pk
project_id           uuid fk → projects.id   on delete cascade
slug                 text
active_version_id    uuid fk → agent_versions.id
viewing_version_id   uuid fk → agent_versions.id
created_at           timestamptz
updated_at           timestamptz
unique(project_id, slug)
```

**`agent_versions`** — versioned bodies for the agent shell.

```
id           uuid pk
agent_id     uuid fk → agents.id   on delete cascade
number       int
description  text                  -- optional Save-As description
created_at   timestamptz
body         jsonb                 -- AgentBody = { name, slug, spec,
                                  --   persona, defaultCrewId? }
unique(agent_id, number)
```

**`crews`** — shell only. Membership via FK to `agents`.

```
id                   uuid pk
agent_id             uuid fk → agents.id   on delete cascade
active_version_id    uuid fk → crew_versions.id
viewing_version_id   uuid fk → crew_versions.id
created_at           timestamptz
updated_at           timestamptz
```

**`crew_versions`** — versioned bodies for the crew shell.

```
id           uuid pk
crew_id      uuid fk → crews.id   on delete cascade
number       int
description  text
created_at   timestamptz
body         jsonb                 -- CrewBody = { name, description?,
                                  --   spec, persona?, addons[] }
unique(crew_id, number)
```

**Notes:**
- Crew membership lives in the FK (`crews.agent_id`), not inside
  the agent body. Switching agent versions changes persona / spec /
  `defaultCrewId` but does NOT add/remove crews. Crew create /
  delete is its own action.
- `body` JSON shape comes from the TypeScript types
  (`AgentBody`, `CrewBody`) in
  [aspect-react-client/src/builder/types/index.ts](../../../aspect-react-client/src/builder/types/index.ts).
  Server doesn't validate inside — it stores what the client sends.
- The first `agent_version` and `crew_version` row are written when
  the agent / crew is created (as "v1 — Initial"); both
  `active_version_id` and `viewing_version_id` point at it.

### Reused tables (no changes)

- **`conversations`** — one row per builder-preview conversation
  (same shape as today).
- **`messages`** — user + assistant messages.
- **`context_data`** — memory writes land here (P2). Conversation-
  scoped first.
- **`llm_usage`** — every `llm.js` call inserts here. Admin usage
  views keep working unchanged.

### New table for P2 — `addon_runs`

(Not built in P1, but designed now so we don't paint into a corner.)

```
id                    uuid pk
conversation_id       fk → conversations.id  on delete cascade
message_id            fk → messages.id       on delete cascade
agent_id              uuid                   -- denormalised
agent_version_id      uuid
crew_id               uuid
crew_version_id       uuid
addon_instance_id     text                   -- from the JSON config
plugin_id             text                   -- 'field-extractor' | 'talker' | …
lane                  text                   -- 'main' | 'background' | 'offline'
status                text                   -- 'success' | 'error' | 'running'
started_at            timestamptz
ended_at              timestamptz
duration_ms           int
run_data              jsonb                  -- see below

idx(conversation_id, message_id)
idx(agent_id, started_at)
```

`run_data` shape:

```json
{
  "model": { "providerId": "openai", "modelId": "gpt-4o-mini" },
  "prompt": "<assembled prompt string>",
  "history_sent_count": 5,
  "raw_output": "<llm output text>",
  "parsed_output": { "name": "Sara", "age": 32 },
  "output_type": "json-to-memory",
  "memory_writes": [
    { "domain": "customer_profile", "field": "name", "value": "Sara" }
  ],
  "tokens": { "input": 234, "output": 56, "total": 290 },
  "error": null
}
```

---

## API surface

### Builder-only — doc CRUD (`/api/builder/*`)

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/api/builder/projects?agentSlug=:slug&ownerUserId=:uid` | Load full hydrated ProjectDoc (denormalized response). Returns 404 if not yet bootstrapped. |
| `POST` | `/api/builder/projects` | Bootstrap a new project + agent + initial crew + v1's of each. |
| `POST` | `/api/builder/agents/:agentId/versions` | Save As — create new `agent_versions` row, flip viewing pointer. |
| `PUT` | `/api/builder/agents/:agentId/versions/:versionId` | Save — overwrite an existing agent version's body. |
| `PUT` | `/api/builder/agents/:agentId/active` | Flip `agents.active_version_id`. |
| `PUT` | `/api/builder/agents/:agentId/viewing` | Flip `agents.viewing_version_id`. |
| `POST` | `/api/builder/agents/:agentId/crews` | Create a new crew + its v1. |
| `DELETE` | `/api/builder/crews/:crewId` | Delete (cascades versions). |
| `POST` | `/api/builder/crews/:crewId/versions` | Save As. |
| `PUT` | `/api/builder/crews/:crewId/versions/:versionId` | Save. |
| `PUT` | `/api/builder/crews/:crewId/active` | Flip `crews.active_version_id`. |
| `PUT` | `/api/builder/crews/:crewId/viewing` | Flip `crews.viewing_version_id`. |

All bodies / fields the client sends are accepted as-is (server
doesn't validate inside the JSON). Surgical = each endpoint maps
to one builder action.

### Shared runtime + history (`/api/agents/:slug/*`)

Used by the builder today (`version: 'viewing'`) and by a future
customer-facing v2 chat (`version: 'active'`). No rename needed.

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/api/agents/:slug/conversations?ownerUserId=:uid` | List past conversations for this agent. |
| `POST` | `/api/agents/:slug/conversations` | Create a new conversation. Returns `{ conversationId }`. |
| `POST` | `/api/agents/:slug/conversations/:convId/messages` | **The runtime call.** Body: `{ userMessage, version: 'viewing' \| 'active' }`. Response is **SSE**. |
| `GET` | `/api/agents/:slug/conversations/:convId/messages` | Fetch the transcript. |
| `DELETE` | `/api/agents/:slug/conversations/:convId` | Bulk delete (cascade messages + addon_runs). |
| `GET` | `/api/agents/:slug/messages/:messageId/runs` | Addon runs for one assistant message (P3). |

---

## SSE event shape

Additive — new event types under an `addon` namespace. Each event
carries `instanceId` so the client can correlate live + historical
views to the addon card in the canvas.

| Event | Payload (key fields) |
|---|---|
| `conversation` | `{ conversationId, messageId }` — fires once at the start |
| `addon.start` | `{ instanceId, pluginId, lane, label, model }` |
| `addon.prompt` | `{ instanceId, prompt, historyCount }` |
| `addon.token` | `{ instanceId, token }` — Talker only (real streaming) |
| `addon.output` | `{ instanceId, rawOutput, parsedOutput?, memoryWrites?, tokens, durationMs }` |
| `addon.error` | `{ instanceId, error: { code, message } }` |
| `assistant.message` | `{ messageId, text }` — final Talker output (after token stream completes) |
| `done` | `{ totalMs }` |

The event shape is the contract between live and historical views.
`addon_runs.run_data` (P2) JSON serialises the same fields the
`addon.output` event carries — historical view reconstructs the
live event from the row.

---

## Server file layout

New code under `aspect-agent-server/builder/`. Sibling to existing
`crew/` so the V2 path is clearly separate from legacy.

```
aspect-agent-server/
├── builder/
│   ├── routes/
│   │   ├── projectsRoute.js        Builder-only CRUD (under /api/builder/*).
│   │   ├── runtimeRoute.js         /api/agents/:slug/conversations/:convId/messages
│   │   │                           SSE entry point; delegates to BuilderRunner.
│   │   ├── conversationsRoute.js   List / create / fetch / delete conversations.
│   │   └── historyRoute.js         (P3) addon_runs by message.
│   ├── runtime/
│   │   ├── BuilderRunner.js        Loops blocking-lane addons; emits SSE events.
│   │   ├── promptAssembler.js      Substitute placeholders in promptTemplate.
│   │   │                           IDENTICAL string output to client
│   │   │                           buildPromptPreview.ts.
│   │   ├── outputParser.js         Parse LLM output by outputType.
│   │   └── (P2) addonRunStore.js   Insert addon_runs rows.
│   └── services/
│       ├── builderProjects.js      DB CRUD over the 5 new tables.
│       └── (P2) builderMemory.js   writeField(domain, name, value) wrapper.
└── db/schema/
    ├── projects.js                  NEW
    ├── agents.js                    NEW  (V2 — different from legacy)
    ├── agentVersions.js             NEW
    ├── crews.js                     NEW
    ├── crewVersions.js              NEW
    └── (P2) addonRuns.js            NEW
```

Reused without changes:
- `services/llm.js` — every LLM call goes through it; usage logging there.
- `services/context.service.js` — `writeContext` / `getContext` (P2).
- `services/conversation.service.js` — message persistence + history slicing.
- The existing SSE writer pattern in `server.js`.

Not touched:
- `crew/` — legacy dispatcher / `CrewMember` base. Still powers v1.
- All existing `/api/finance-assistant/*` routes.

---

## Client changes

### `useProjectSync(agentSlug)` hook (NEW)

- On mount: `GET /api/builder/projects?agentSlug=…`. If 404,
  `POST /api/builder/projects` with the local `emptyProject()` shape.
- Adapter: denormalize the server response (separate tables) into
  the client's nested `ProjectDoc`. Inverse adapter helpers per
  mutation.
- Wraps every `BuilderContext` version action so Save / Save As /
  Set Active also makes the surgical server call. Calls are
  awaited so local state and server stay consistent. Optimistic
  could come later if it ever feels slow.

### `BuilderContext` (CHANGED)

- Mutations still update local state synchronously (current
  behaviour) so the UI is instant.
- Additionally call the matching server endpoint via
  `useProjectSync`. The hook handles the API request.

### `UserChat` ([components/ChatPanel/UserChat.tsx](../../../aspect-react-client/src/builder/components/ChatPanel/UserChat.tsx))

- Replace the stub `send()` with a real SSE call.
- Hold a `conversationId` in component state (created server-side
  on first send via the `conversation` event).
- Body of the panel: transcript · live `AddonRunTimeline` · composer.
- If `isCrewDirty(...)`, show a small **"⚠️ Unsaved changes
  won't be included — Save first"** chip with a one-click Save.

### New components

- `AddonRunCard.tsx` — single addon's run summary, expandable to
  show prompt, raw output, parsed values, memory writes, tokens.
  Same component for live and historical (P3).
- `AddonRunTimeline.tsx` — ordered list of `AddonRunCard`s for
  one user turn.

### Plugin DebugComponent slot

Each plugin already has an optional `DebugComponent?`. We'll use
it inside `AddonRunCard` so plugins can render richer views of
their own runs (e.g. Field Extractor → typed table of extracted
values). Default rendering is the generic display. Not blocking
the MVP.

---

## Two contracts that matter most

These are the two places where client + server **must** agree
exactly. Drift = silent bugs.

### 1. Prompt template assembly

Client side: [buildPromptPreview.ts](../../../aspect-react-client/src/builder/components/PromptTemplateModal/buildPromptPreview.ts).
Server side: new `aspect-agent-server/builder/runtime/promptAssembler.js`.

**Same output string, given the same inputs.**

Strategy:
- Extract the substitution logic into a tiny pure function. Port
  identically. Same placeholder collapse rules around empty values.
- The placeholder map (`KNOWN_PROMPT_PLACEHOLDERS` in
  [types/index.ts](../../../aspect-react-client/src/builder/types/index.ts))
  is the source of truth. Adding a placeholder = update that map.

### 2. The SSE event shape

The event payloads are the contract between live + historical
views. The `run_data` JSON in `addon_runs` (P2) serialises the
same fields as the live `addon.output` event.

---

## Phasing

Three phases. Each ends with something testable.

### P1 — Persistence + first runnable user-chat

**Scope:**
- DB: five new tables (`projects`, `agents`, `agent_versions`,
  `crews`, `crew_versions`). Drizzle schema files; migration runs
  on server start (or via the existing `npm run` task — match
  whatever the repo uses).
- Server routes:
  - Builder doc CRUD under `/api/builder/*` (full table above).
  - Runtime: `POST /api/agents/:slug/conversations/:convId/messages`
    streams SSE.
  - Conversations: list / create / fetch / delete under
    `/api/agents/:slug/conversations/*`.
- `BuilderRunner`: blocking-lane only; Field Extractor →
  Talker; one LLM call per addon via `llm.js`; **real token streaming
  for Talker** through `addon.token` events.
- `promptAssembler`: byte-for-byte same output as client
  `buildPromptPreview`.
- `outputParser`: lenient JSON extract for json-to-memory; plain
  text for text-to-user.
- Persist `conversations` + `messages` rows. **No `addon_runs`
  yet** (that's P2). `llm_usage` still gets rows automatically via
  `llm.js`.
- Client:
  - `useProjectSync(agentSlug)` hook: load + bootstrap +
    write-through on version actions.
  - `BuilderContext` mutations call through to the server.
  - `UserChat` posts to the runtime endpoint, consumes SSE,
    renders the live `AddonRunTimeline`, transcripts the assistant
    message.
  - Dirty warning chip.

**Done when:**
- Bootstrap from scratch in two browsers → both see the same
  saved project.
- Send a message in the User Chat → Field Extractor card lights
  up showing its prompt + parsed JSON → Talker card streams
  tokens → final reply lands in the transcript.

### P2 — `addon_runs` + memory writes + history reads

**Scope (next session):**
- `addon_runs` table + insert per addon execution.
- Memory writes: each extractor field value persisted to
  `context_data` per the field's domain (conversation-scoped).
- History reads: `context.history` config slices the conversation;
  result sent as the LLM's message-history parameter (NOT
  interpolated into the prompt).
- Memory reads: `## Memory` block assembled from `context_data`
  for the addon's selected domains.

**Done when:**
- Turn 1: user says "I'm Sara, 32". Extractor captures
  `customer_profile.name="Sara"`, `customer_profile.age=32`.
  Talker reply uses memory.
- Turn 2: with memory reads configured, the Talker prompt
  contains the populated `## Memory` block and references Sara
  by name.

### P3 — Historical view

**Scope:**
- `GET /api/agents/:slug/messages/:messageId/runs`.
- Clicking a past assistant message → expands its
  `AddonRunTimeline` (same component, reading from rows).
- Conversation switcher (dropdown of past conversations).
- `DELETE /api/agents/:slug/conversations/:convId`.

**Done when:**
- After a few turns, click any past assistant message; the same
  prompt / output / memory breakdown that was shown live is
  reconstructed from `addon_runs`.

---

## Migration strategy

Purely additive. Nothing legacy changes.

- v1 customer-facing chat keeps `/api/finance-assistant/*` + the
  legacy `crew/` dispatcher / `CrewMember` runtime.
- Legacy `agents/*.config.ts` keep working.
- New tables are V2-only. v1 doesn't read or write them.
- Future: rebuild v1 chat on `/api/agents/:slug/*` — separate
  decision, separate slice.

---

## Open questions for future slices

- **Server-side autosave** of the working copy as a separate
  "draft" slot — lets the runtime use the working copy without an
  explicit Save. Today: Save before run, warning chip on dirty.
- **Background + Offline lanes** — the runtime currently runs only
  blocking; the UI already shows the other lanes.
- **Transitions** — multi-crew agents need a transitioner; out of
  scope here.
- **Per-turn cost rollup** — `addon_runs.run_data.tokens` is per
  call; summary could surface in the UI.

---

## Reference — existing code we lean on

- `aspect-agent-server/services/llm.js` — every provider call,
  streaming for all of them, automatic `llm_usage` insert.
- `aspect-agent-server/services/context.service.js` —
  `getContext(namespace)` / `writeContext(namespace, data)` (P2).
- `aspect-agent-server/services/conversation.service.js` —
  message persistence + history slicing helpers.
- `aspect-agent-server/server.js` — Express setup, existing SSE
  writer patterns to mirror.
- `aspect-react-client/src/builder/components/PromptTemplateModal/buildPromptPreview.ts`
  — the client-side prompt assembly that the server mirrors.
- `aspect-react-client/src/builder/state/BuilderContext.tsx` —
  in-memory project doc + version actions to wrap with server sync.
- `aspect-react-client/src/builder/types/index.ts` —
  `KNOWN_PROMPT_PLACEHOLDERS` is the placeholder contract.
