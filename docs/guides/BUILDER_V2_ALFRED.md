# Builder V2 — Alfred (Phase 5)

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first. This
> one covers only Alfred — the in-builder AI helper that lives in the
> Builder Chat tab.
>
> The patch-generator Alfred reads
> [BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md) at runtime as its
> canonical schema reference. Keep that doc in sync with the code.

## What Alfred is

The second chat tab in the builder. Two distinct LLM "brains" working
together:

- **Brainstorm Alfred** — Claude Sonnet 4.6. Free conversation with the
  user about the agent under construction. Sees the project as a
  human-readable summary, not raw JSON. Cannot write JSON. When the user
  converges on a concrete change, calls a `propose` tool with a
  one-line summary + an English `what_to_do`.
- **Patch-generator Alfred** — Claude, separate call. Fires only when
  the user clicks **Apply** on a proposal card. Receives the current
  body JSON + the full schema reference + canonical examples + the
  English `what_to_do`. Returns the **full new body** (not a patch).
  Never participates in conversation.

Separation of concerns:

|                  | Brainstorm Alfred       | Patch-generator Alfred |
| ---------------- | ----------------------- | ----------------------- |
| Sees JSON?       | No — human summary only | Yes — raw body         |
| Knows schema?    | No — concepts only      | Yes — full schema      |
| Output           | Text + `propose(...)`   | Full new body JSON     |
| When             | Every chat turn         | Only on Apply click    |
| Tools            | `propose`, `append_spec_note`, `read_spec`, `read_change_log` | None — structured output only |
| `llm_usage` ctx  | `alfred-brainstorm`     | `alfred-apply`         |

Decision 51: Brainstorm and apply are separate LLM calls, **not** a
single multi-turn tool-using agent. Reasons: smaller brainstorm prompt
(no schema noise), patch generator can use a different/cheaper
structured-output model, failures isolate cleanly, the user can edit
`what_to_do` between brainstorm and apply.

Decision 52: Patch generator returns the **full new body**, not RFC 6902
patches. Reasons: Claude writes JSON reliably and JSON Pointers
unreliably; we already have `AgentBody`/`CrewBody` Zod-equivalent
schemas server-side; the diff for the change log is computed
after-the-fact from `before`/`after` bodies.

## Architecture at a glance

```
[Browser  BuilderChat tab]
   │
   │ POST /api/builder/alfred/chats/:id/messages   (SSE)
   ▼
[Brainstorm Alfred — Claude Sonnet 4.6]
   ├─ context: human summary of ProjectDoc + last N chat turns + spec
   ├─ tools available: propose, append_spec_note, read_spec,
   │                   read_change_log
   └─ streams back: alfred.token | alfred.proposal | alfred.tool-result
                  | done

[User clicks Apply on a proposal card]
   │
   │ POST /api/builder/alfred/chats/:id/messages/:msgId/apply
   ▼
[Patch-generator Alfred — separate Claude call]
   ├─ context: current AgentBody/CrewBody JSON
   │         + schema reference (types + examples)
   │         + what_to_do (English, possibly user-edited)
   └─ returns: full new body JSON (structured output)
        │
        ▼
[Server validates body, calls existing /api/builder save endpoints,
 writes agent_log row, returns refreshed doc]
```

## Persistence model

Decision 53: Reuse the existing `conversations` and `messages` tables
with a discriminator column. Saves one migration. Alfred chats share
the same history endpoints, rename/delete plumbing, message-store
shape as user chats.

### `conversations` — add `kind`

```sql
ALTER TABLE conversations
  ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'user';
  -- 'user' | 'alfred'
```

Existing rows default to `'user'`. New Alfred chats insert with
`kind='alfred'`. List endpoints filter by `kind`.

### `messages` — proposals live in existing `metadata` JSONB

No schema change. When brainstorm Alfred emits a `propose` tool call,
the server stashes the proposal object under
`messages.metadata.proposal`:

```ts
type Proposal = {
  id:        string;       // UUID, server-generated
  summary:   string;       // one-line headline
  what_to_do: string;      // English, editable by user before Apply
  status:    'pending' | 'applied' | 'dismissed';
  applied_at?: string;
  applied_log_id?: number; // FK into agent_log
};
```

A single assistant message can carry zero or one proposal (the tool is
designed to fire at most once per turn).

### `agent_log` — new table

```sql
CREATE TABLE agent_log (
  id              SERIAL PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  actor           VARCHAR(20) NOT NULL,    -- 'alfred' | 'manual'
  reason          TEXT NOT NULL,
  body_before     JSONB NOT NULL,
  body_after      JSONB NOT NULL,
  entity          VARCHAR(20) NOT NULL,    -- 'agent' | 'crew'
  entity_id       VARCHAR(64) NOT NULL,    -- agent id or crew id
  source_chat_id  INTEGER,                 -- conversations.id, nullable
  source_msg_id   INTEGER,                 -- messages.id, nullable
  applied_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  applied_by      VARCHAR(64) NOT NULL     -- owner_user_id
);

CREATE INDEX idx_agent_log_agent_id ON agent_log (agent_id, applied_at DESC);
```

The diff displayed in the Changes panel is computed from `body_before`
vs `body_after` at view time. Cheap.

### `agent_specs` — new table

```sql
CREATE TABLE agent_specs (
  agent_id           VARCHAR(64) PRIMARY KEY,
  auto_section       TEXT NOT NULL,            -- generated markdown
  user_notes         TEXT NOT NULL DEFAULT '', -- free-form markdown
  auto_updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  notes_updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
```

Both columns are **markdown text** (per your call: keep the markdown in
the DB, no physical .md file). The UI renders them as markdown. An
"Export .md" button concatenates and downloads.

Decision 54: One row per agent. No version history on the spec — the
spec describes "what the agent is right now." If we later need
versioned specs we'll add a `agent_specs_history` table; for now
deferred.

## Tools available to brainstorm Alfred

Native Anthropic tool-use protocol. The LLM emits a `tool_use` block
in its response; the server forwards each as an SSE event.

### `propose({ summary, what_to_do })`

The headline tool. Brainstorm Alfred calls it when the user has agreed
to a concrete change. **Not called during exploration.** System prompt:

> When the user has agreed to a concrete change, end your message by
> calling the `propose` tool with a one-line `summary` and a precise
> English `what_to_do` description. Don't call it during exploration
> or while clarifying. Call it at most once per turn.

`what_to_do` is plain English. **Not JSON.** Example values:

- `"Add an agent-level field 'intent' (enum: complaint/sales/support, inferred). Wire it as extracted by the existing Intent Extractor in the Welcome crew."`
- `"Rename the 'Greet' crew to 'Welcome' and update the agent's defaultCrewId to point to it."`
- `"Add a new crew 'Symptoms' with a Field Extractor that captures symptom_severity (int) and a Talker addon. Set its persona to mirror the existing Welcome crew."`

The proposal is persisted under the assistant message's
`metadata.proposal` and emitted to the client as
`alfred.proposal` over SSE.

### `append_spec_note(text)`

Appends `text` to `agent_specs.user_notes` with a timestamp + actor
prefix:

```
[2026-05-23 · Alfred] text…
```

Used when the user says something like "remember that I want Hebrew-only
greetings." Brainstorm Alfred calls this; no proposal card, no Apply
needed. Writes happen immediately.

### `read_spec()` and `read_change_log({ since? })`

Read-only. Brainstorm Alfred uses these to answer "what changed this
week?" or "what was decided about X?" Returns the corresponding rows
(or markdown).

## Context assembly

Built fresh each turn by `alfredContext.js`.

### Brainstorm Alfred sees:

1. **System prompt** (static-ish): identity, role, the four tools with
   usage examples, the policy `"never write JSON; describe changes in
   English"`.
2. **Project state — human summary** (dynamic, regenerated each turn):

   ```
   Agent: Freeda  (slug: freeda)
     Persona: warm menopause companion…
     Spec: …

     Agent fields:
       - age (int, explicit)
       - journey_stage (enum: peri/post, inferred)

     Crews:
       Welcome  (default)
         Description: greet + classify intent
         Addons (main lane):
           1. FieldExtractor "Intent Extractor"  (extracts: intent)
           2. Talker
         Crew fields:
           - intent (string, inferred)

       Symptoms
         Addons (main lane):
           1. FieldExtractor                      (extracts: severity)
           2. Talker
         Crew fields:
           - severity (int, explicit)
   ```

   No `instanceId`s. No JSON. No internal keys.

3. **Spec snapshot**: `auto_section` + `user_notes` concatenated as
   markdown, so brainstorm Alfred "sees the spec the way the user does."
4. **Recent Alfred chat history**: last 10 turns from this chat.
5. **Recent agent_log**: last 5 applied changes
   (`reason · summary · actor · applied_at`).

Token budget on a moderate agent: ~3–6K. Comfortable for Sonnet 4.6.

### Patch-generator Alfred sees:

1. **System prompt** (static): "You produce the FULL new
   `AgentBody`/`CrewBody` JSON given a current body and an English
   description of the change. Output JSON only. Preserve fields not
   mentioned. Generate new ids for new entities."
2. **Schema reference**: [BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md)
   read verbatim and embedded into the system prompt. That doc is the
   canonical source of truth — type definitions, plugin registry,
   invariants, and canonical example bodies. Updated by hand when the
   types or plugins change. See its "Maintenance rule" header.
3. **Current body JSON**: the actual `AgentBody` or `CrewBody` being
   edited, verbatim.
4. **`what_to_do`**: the (possibly user-edited) English description from
   the proposal card.

Output: a JSON object that parses cleanly as `AgentBody` or `CrewBody`.
Server-side validator checks it against § 5 (Invariants) of
BUILDER_V2_SCHEMA.md before writing.

Decision 55: The schema reference is a hand-maintained markdown doc
([BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md)) — NOT auto-derived
from the TS types. Reasons: lets us bundle invariants the type system
can't express (cross-reference checks, monotonic version numbers, enum
requires `enumValues`, etc.) and canonical example bodies the model
imitates. The maintenance contract is "update this doc in the same
commit that changes types/index.ts or a plugin descriptor."

## Apply flow — end to end

```
1. User clicks Apply on a proposal card
2. UI: optional inline edit of `what_to_do` + optional edit of `reason`
3. Client → POST /api/builder/alfred/chats/:id/messages/:msgId/apply
              body: { proposalId, what_to_do, reason }
4. Server:
   a. Loads proposal from messages.metadata.proposal
   b. Loads current AgentDoc/CrewDoc
   c. Determines which body (agent vs crew) to mutate from what_to_do
      OR from a hint included on the proposal at brainstorm time
   d. Calls patch generator Alfred → new body JSON
   e. Validates new body against TypeScript schema (shared validator)
   f. Calls the existing /api/builder/agents/:id/versions/:vid PUT
      or /api/builder/crews/:id/versions/:vid PUT to save
   g. Inserts agent_log row:
        { actor: 'alfred', reason, body_before, body_after,
          entity, entity_id, source_chat_id, source_msg_id }
   h. Mutates messages.metadata.proposal.status = 'applied' +
      stores applied_log_id
   i. Returns { ok: true, refreshedDoc, logId }
5. Client:
   a. BuilderContext refetches the project
   b. Proposal card flips to green "Applied" with the locked reason
   c. Changes panel surfaces the new log row at the top
```

Step (4c) — which body to mutate — is decided by including an
`entity_hint` on the brainstorm proposal: `{ entity: 'agent'|'crew',
entity_id?: string }`. Brainstorm Alfred picks this when calling
`propose`. The patch generator never decides scope; it just produces
the body it's pointed at.

## Manual change logging

The user can also log a manually-edited change (point #3 from your
brainstorm answers):

- Every save (via Save / Save as…) silently captures `body_before` →
  `body_after` and stashes it in a short-lived in-memory ring buffer
  on the server (last ~5 per agent).
- The Changes panel shows a **"Log this change"** affordance on the
  most recent un-logged save.
- Click → small modal asks for a reason → server inserts `agent_log`
  row with `actor='manual'`, `source_chat_id=null`,
  `source_msg_id=null`, `body_before`/`after` from the ring buffer.

Decision 56: Auto-logging every manual save was rejected — it'd flood
the log with noise (typo fixes, persona tweaks). Manual opt-in keeps
the log meaningful.

## Spec regeneration

Manually triggered (your point #7 — auto-on-every-save was rejected).

```
POST /api/builder/agents/:id/spec/regenerate
  body: { note?: string }
```

Server:

1. Loads the current `AgentDoc`.
2. Runs `generateAutoSection(agentDoc)` → markdown string.
3. Writes to `agent_specs.auto_section`, updates `auto_updated_at`.
4. If `note` provided: appends to `user_notes` as
   `[<date> · You] note` and updates `notes_updated_at`.

`generateAutoSection` (in `services/agentSpecSnapshot.js`) emits
markdown shaped like:

```markdown
# Agent: <name>

## Persona
<persona>

## Spec
<spec>

## Agent fields
- intent (enum: complaint/sales/support, inferred): "Classify the user message…"
- age (int, explicit): "Direct ask…"

## Crews
### Welcome (default)
- Description: …
- Addons: FieldExtractor "Intent Extractor" → Talker
- Crew fields:
  - intent (string, inferred)

### Symptoms
- Addons: FieldExtractor → Talker
- Crew fields:
  - severity (int, explicit)
```

## API surface

```
POST   /api/builder/alfred/chats                            # create chat
GET    /api/builder/alfred/chats?agentSlug&ownerUserId      # list
GET    /api/builder/alfred/chats/:id/messages               # history
POST   /api/builder/alfred/chats/:id/messages   (SSE)       # send message
PATCH  /api/builder/alfred/chats/:id                        # rename
DELETE /api/builder/alfred/chats/:id                        # delete

POST   /api/builder/alfred/chats/:id/messages/:msgId/apply  # apply proposal
POST   /api/builder/alfred/chats/:id/messages/:msgId/dismiss # dismiss

GET    /api/builder/agents/:id/log                          # change log
POST   /api/builder/agents/:id/log                          # manual log entry

GET    /api/builder/agents/:id/spec                         # { auto, notes, ... }
POST   /api/builder/agents/:id/spec/regenerate              # body: { note? }
PUT    /api/builder/agents/:id/spec/notes                   # body: { notes }
```

Chat CRUD endpoints reuse the existing `conversations` table; the route
handlers in `alfredRoute.js` just filter on `kind='alfred'` and delegate
to the same `conversationsService` used by the user-facing chat.

## File layout

```
aspect-agent-server/
  alfred/
    routes/
      alfredRoute.js              ← /api/builder/alfred/*
    services/
      alfredChats.js              ← chat CRUD (thin wrapper on conversations)
      alfredContext.js            ← human summary + system prompt
      alfredRunner.js             ← brainstorm Claude call + SSE
      patchGenerator.js           ← apply-time Claude call
      proposalValidator.js        ← validates the body the generator returns
      agentSpecSnapshot.js        ← generateAutoSection(agentDoc)
      changeLog.js                ← agent_log read + write
  db/schema/
    alfred.js                     ← agent_log + agent_specs ORM models
  db/migrations/
    029_add_conversations_kind.sql
    030_add_agent_log.sql
    031_add_agent_specs.sql

aspect-react-client/src/builder/
  state/
    alfredStream.ts               ← SSE consumer
    builderApi.ts                 ← new wrappers (alfred chat, log, spec)
  components/
    ChatPanel/
      BuilderChat.tsx             ← full rewrite (real chat UI)
      ProposalCard.tsx            ← inline diff card with Apply/Dismiss
    AgentSpec/
      AgentSpecPanel.tsx          ← markdown render + notes editor
    ChangeLog/
      ChangeLogPanel.tsx          ← collapsible list of agent_log rows
      ChangeLogRow.tsx            ← row with reason · date · diff toggle
```

## SSE event shapes

Mirror the runtime events from BUILDER_V2.md:

```ts
type AlfredEvent =
  | { type: 'conversation'; chatId: number; messageId: number }
  | { type: 'alfred.token'; token: string }
  | { type: 'alfred.tool-use'; tool: 'propose' | 'append_spec_note' | ...;
      input: unknown; toolUseId: string }
  | { type: 'alfred.proposal'; messageId: number; proposal: Proposal }
  | { type: 'alfred.tool-result'; toolUseId: string; result: unknown }
  | { type: 'alfred.error'; error: { code: string; message: string } }
  | { type: 'done'; totalMs: number };
```

`alfred.proposal` is a server-synthesised event — the server intercepts
the `propose` tool call, persists the proposal, and emits this
ready-to-render event so the client doesn't need to know about
Anthropic's tool-use protocol.

## Phasing

| Slice    | Effort   | Value | What ships |
| -------- | -------- | ----- | ---------- |
| **P5.1** | 1 session  | High  | Brainstorm-only Alfred. Real chat tab with history. No tools, no Apply. `conversations.kind`, alfredRoute, alfredContext (human summary), alfredRunner. |
| **P5.2** | 1.5 sessions | Very high | Proposal cards + Apply. `propose` tool, patch generator call, `agent_log` table, Apply endpoint, ProposalCard component, ChangeLogPanel. |
| **P5.3** | 1 session  | Medium | Spec snapshot. `agent_specs` table, `agentSpecSnapshot.js`, `read_spec` + `append_spec_note` tools, AgentSpecPanel, regenerate button. |

Ship P5.1 first, use it for a day, then P5.2. Don't bundle — the
brainstorm surface needs to feel natural before proposals layer on.

## Decision journal

Continues from BUILDER_V2.md's numbering.

**51. Brainstorm and apply are separate LLM calls.** Not a single
multi-turn tool-using Claude. Cleaner separation, smaller brainstorm
prompt, easier failure isolation, patch generator can pick a different
model.

**52. Patch generator returns the full new body, not RFC 6902.** Claude
writes JSON reliably and JSON Pointers unreliably. Diffs computed
after-the-fact from `body_before` vs `body_after`.

**53. Reuse `conversations` + `messages` with `kind` discriminator.**
Saves a migration. Alfred chats inherit history/rename/delete plumbing
for free. Proposals stashed under `messages.metadata.proposal`.

**54. One row per agent in `agent_specs`.** No versioning. Spec
describes "what the agent is right now"; versioned history lives in
`agent_log`. Add `agent_specs_history` later if needed.

**55. Patch generator's schema reference is sourced from the V2
TypeScript types verbatim.** Keeps the generator in sync with the type
system; no hand-maintained schema doc to drift.

**56. Manual changes are NOT auto-logged.** A "Log this change"
affordance in the Changes panel opts in. Auto-logging would flood the
log with typo fixes and persona tweaks; manual opt-in keeps entries
meaningful.

**57. Spec regeneration is manual only.** No auto-on-save hook. The
regenerate button optionally accepts a `note` that's appended to
`user_notes` — captures "why I regenerated" in one click.

**58. Brainstorm Alfred never sees or writes JSON.** Its context is a
human-readable summary of the project; its `what_to_do` is plain
English. Only the patch generator touches raw JSON. Brainstormer
thinks in agent/crew/field/addon vocabulary, not schema keys.

**59. Both Alfred calls log to `llm_usage`** with
`context: 'alfred-brainstorm'` and `context: 'alfred-apply'`
respectively. Same row shape as runtime LLM calls.

**60. The Apply endpoint validates the patch generator's output server-
side against the V2 schema before saving.** Don't trust model output;
reject malformed bodies with a structured error so the UI can surface
"Apply failed, try again."

## Deferred (after P5.3)

- **Full JSON viewer panel** in the agent view (your point #5). Read-
  only render of the resolved ProjectDoc, syntax-highlighted, with
  copy-to-clipboard.
- **Apply confirmation as modal vs inline** — defaulting to inline
  small confirmation per your preference; revisit if it feels cramped.
- **Multi-agent Alfred** (same chat editing multiple agents) — defer
  until the single-agent workflow is solid.
- **Versioned specs** — add when a use case appears.
- **Alfred-initiated cross-entity changes** (one Apply touches both
  agent + crew bodies) — out of scope for P5.2; brainstormer will split
  these into two proposals.

## What I need from you before starting P5.1

1. Confirm the migration approach: plain `*.sql` files in
   `db/migrations/` + a `run-029-…js` runner like the existing pattern.
2. Confirm we ship P5.1 alone first (no proposal cards), use it for a
   day, then start P5.2.
3. Any naming pushback — currently I have `alfred/` as a peer of
   `builder/` under `aspect-agent-server/`. If you'd rather nest
   (`builder/alfred/`), say so.
