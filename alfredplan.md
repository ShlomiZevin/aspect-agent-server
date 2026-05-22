Alfred — Detailed Plan
What Alfred is
The second chat tab in the builder. Talks with the user about the agent under construction:

Brainstorm (free conversation, full project context).
Propose JSON edits (with reasons) the user can Apply with one click.
Maintain a per-agent spec document in the DB.
Every applied change is journalled with a reason for audit + living documentation.

Architecture at a glance

[Browser BuilderChat tab]
   │
   │ POST /api/builder/alfred/chat (SSE)
   ▼
[Alfred runtime — aspect-agent-server/alfred/]
   │
   ├─ assemble context (ProjectDoc + agent + spec snapshot + chat history)
   ├─ call Claude Sonnet 4.6 with tools available
   │     ├─ readProjectState    (always)
   │     ├─ proposeChange       (P5.2)
   │     ├─ readSpec / appendSpecNote (P5.3)
   │     └─ readChangeLog       (P5.3)
   │
   ▼
SSE events: alfred.token | alfred.proposal | alfred.tool-result | done
Persistence model
Three new tables (or one + columns — see "Open questions" below).

agent_chats (Alfred conversations)
Like the existing conversations table but for builder helper sessions instead of user-facing chat. Lives separately because the data model is different (proposals, applied changes attached to messages).


agent_chats (
  id              SERIAL PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,   -- references builder_agents.id
  owner_user_id   VARCHAR(64) NOT NULL,
  title           TEXT,                   -- auto-derived from first user message
  metadata        JSONB,                  -- room for future stuff
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
)
agent_chat_messages (Alfred turns)

agent_chat_messages (
  id          SERIAL PRIMARY KEY,
  chat_id     INTEGER NOT NULL,           -- references agent_chats.id
  role        VARCHAR(20) NOT NULL,       -- 'user' | 'assistant' | 'tool'
  content     TEXT NOT NULL,
  proposals   JSONB,                      -- array of pending proposals from this turn (null when none)
  metadata    JSONB,                      -- tokens, model, etc.
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
)
agent_log (every applied mutation across the whole agent)

agent_log (
  id              SERIAL PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  actor           VARCHAR(20) NOT NULL,   -- 'alfred' | 'manual'
  reason          TEXT NOT NULL,          -- editable in the Apply confirmation
  patch           JSONB NOT NULL,         -- RFC 6902 array OR our custom shape
  source_chat_id  INTEGER,                -- nullable; only set for Alfred-driven changes
  source_msg_id   INTEGER,                -- nullable; ties back to the message that proposed it
  applied_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  applied_by      VARCHAR(64)             -- owner_user_id
)
This is the audit trail. Visible to Alfred (read tool) and visible in the UI as a "history of changes" feed.

agent_specs (the spec snapshot)

agent_specs (
  agent_id           VARCHAR(64) PRIMARY KEY,  -- one row per agent
  auto_section       TEXT NOT NULL,            -- auto-generated from AgentBody + crews
  user_notes         TEXT NOT NULL DEFAULT '', -- free-form, preserved across regens
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  auto_updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
)
One row per agent. The auto_section is regenerated whenever a save happens; user_notes is preserved.

Phasing
P5.1 — Brainstorm only (smallest slice, ships first)
Goal: BuilderChat tab works as a real LLM helper. No tools, no edits. Just conversation with full project context.

Server

Create aspect-agent-server/alfred/ folder.
Migration: agent_chats + agent_chat_messages tables.
Service alfred/services/alfredChats.js: create/list/getMessages/appendMessage.
Context assembler alfred/services/alfredContext.js: builds the system prompt + context block from the current ProjectDoc snapshot. Includes:
Agent identity (name, slug, persona, spec)
Each crew: name, spec, persona, addons (plugin id + config summary), fields
Agent fields and per-crew fields
The recent N turns of Alfred chat history (last 10 by default)
Route alfred/routes/alfredRoute.js:
POST /api/builder/alfred/chats — create chat (returns chatId).
GET /api/builder/alfred/chats?agentSlug=…&ownerUserId=… — list.
GET /api/builder/alfred/chats/:id/messages — message history.
POST /api/builder/alfred/chats/:id/messages — SSE. Body: { message }. Streams alfred.token events; persists user + assistant messages.
DELETE /api/builder/alfred/chats/:id — delete.
PATCH /api/builder/alfred/chats/:id — rename.
Wire the route in server.js.
Hardwired model: Claude Sonnet 4.6 via BUILDER_HELPER_MODEL. llm.js already handles the streaming call shape.
Client

API wrappers in state/builderApi.ts: createAlfredChat, listAlfredChats, fetchAlfredMessages, sendAlfredMessage (SSE), renameAlfredChat, deleteAlfredChat.
SSE consumer state/alfredStream.ts mirroring runtimeStream.ts but for Alfred events.
Rewrite components/ChatPanel/BuilderChat.tsx:
Same header pattern as UserChat (History button, Settings button, conversation switcher).
Streams responses token by token.
Persists across reloads via the new endpoints.
HistoryPanel — reuse the existing component, parameterize source.
The helper-model badge already renders the model name; keep it.
Done when:

User clicks Builder Chat tab → fresh chat or picks past one.
Types "what crews do I have?" → Alfred responds streaming with an accurate answer pulled from the current project.
Sends "how can I improve the Welcome crew's prompt?" → Alfred suggests in prose. No buttons, no JSON, just conversation.
Reloads page → past chats are there.
Estimated size: ~600–800 LOC server + client, one DB migration.

P5.2 — Propose-Apply with change log
Goal: Alfred can propose JSON edits. User Applies them with one click, with an editable reason. Every Apply is journalled.

Server

Migration: agent_log table.
Tool plumbing: extend alfredContext.js to tell Alfred about a propose_change tool. We use Claude's native tool-use protocol — the LLM emits a tool call, our SSE forwards it as an alfred.proposal event.
Proposal shape (JSON RFC 6902 patches, but limited to ops we support):

{
  id:        string;          // UUID, generated server-side
  reason:    string;          // Alfred's argument
  summary:   string;          // one-line headline for the diff card
  patch: Array<{
    op:    'add' | 'replace' | 'remove';
    path:  string;            // JSON pointer into the ProjectDoc
    value?: any;
  }>;
}
Apply endpoint: POST /api/builder/alfred/chats/:id/messages/:msgId/apply. Body: { proposalId, reason } (user can edit reason). Server:
Validates the patch shape.
Resolves which entity it touches (agent body / crew body / addon config).
Calls the existing /api/builder/* save endpoints to write the change.
Inserts an agent_log row.
Returns { ok: true, refreshedDoc: ... } so the client can refetch.
Patch validator alfred/services/proposalValidator.js: ensures the path is in our allowed set (no monkey-patching versionIds, etc.) and the operation type fits.
Client

Diff card in BuilderChat: when an alfred.proposal event arrives, render an inline card with:
The summary headline.
A collapsible JSON-patch preview (color-coded add/replace/remove).
The reason (Alfred's), editable inline.
Apply + Dismiss buttons.
Apply flow: clicks → POST → on success, BuilderContext refetches the project doc → builder re-renders with new state.
Persisted proposals: cards rendered from past Alfred messages stay visible (status: pending / applied / dismissed); applied cards turn green with the reason locked.
Done when:

User types "add an intent enum field to the agent with values: complaint, sales, support" → Alfred proposes the right patch with a reason → user clicks Apply → field appears in the FieldsPanel → reload page → applied card still shows with the reason.
Estimated size: ~700–900 LOC + 1 migration. Patch validator is the chewy bit.

P5.3 — Spec snapshot
Goal: Each agent has a living spec document that Alfred can read for context and append notes to. Auto-generated section regenerates on save; user/Alfred notes preserved.

Server

Migration: agent_specs table.
Generator services/agentSpecSnapshot.js: takes an AgentDoc, returns a markdown string:

# Agent: <name>
## Persona
...
## Spec
...
## Agent fields
- intent (enum): ...
## Crews
### Welcome
- Description: ...
- Addons: Field Extractor (Intent Extractor) → Talker
- Fields: ...
Hook into save endpoints: PUT /api/builder/agents/:id/versions/:vid, POST .../versions, crew equivalents — all call regenerateSpec(agentId) after the save succeeds. Idempotent + cheap.
Endpoints:
GET /api/builder/agents/:id/spec → { auto, notes, autoUpdatedAt, notesUpdatedAt }.
PUT /api/builder/agents/:id/spec/notes body { notes } — user-edit the notes section.
Alfred tools (extend context):
read_spec(agentId) → returns auto + notes concatenated.
append_spec_note(text) → appends text to the notes section with a timestamp prefix.
Client

Spec view as a new tab or section in the agent view: shows auto section (read-only) + notes section (editable textarea, save-on-blur).
Alfred-appended notes appear with an Alfred icon prefix.
Done when:

Save an agent → agent_specs row for it has the freshly-generated auto section.
View the agent's spec → see the auto-block + your notes.
Ask Alfred "remember that I want this crew to always greet in Hebrew" → Alfred uses append_spec_note → reload → note is there with timestamp.
Estimated size: ~500–700 LOC + 1 migration.

File layout

aspect-agent-server/
  alfred/
    routes/
      alfredRoute.js              ← /api/builder/alfred/*
    services/
      alfredChats.js              ← chat CRUD
      alfredContext.js            ← build the system prompt + context block
      alfredRunner.js             ← stream from Claude, handle tool calls
      proposalValidator.js        ← P5.2: validate JSON patches
      agentSpecSnapshot.js        ← P5.3: regenerate the auto section
    plugins/                      ← (not needed; Alfred isn't a builder plugin)
  db/schema/alfred.js             ← new tables
  db/migrations/
    029_add_alfred_chats.sql
    030_add_agent_log.sql         ← P5.2
    031_add_agent_specs.sql       ← P5.3

aspect-react-client/src/builder/
  state/
    alfredStream.ts               ← SSE consumer
    builderApi.ts                 ← new wrappers
  components/
    ChatPanel/
      BuilderChat.tsx             ← rewritten — full chat UI
      AlfredProposalCard.tsx      ← P5.2
    AgentSpec/                    ← P5.3
      AgentSpecPanel.tsx
      AlfredNotesEditor.tsx
Tools Alfred has
P5.1 — none. Pure conversation.

P5.2 — propose_change (emit a structured proposal; the UI handles Apply).

P5.3 —

read_spec(agentId) — returns the current spec doc.
append_spec_note(text) — appends to user_notes.
read_change_log(agentId, since?) — returns recent agent_log rows so Alfred can answer "what changed this week?".
We deliberately do NOT give Alfred a tool that mutates state directly. Every change goes through propose_change + an explicit user Apply. (Decision 36 + 41 + 46 cover the rationale.)

Context Alfred sees on every turn
Built fresh each turn by alfredContext.js:

System prompt (static-ish): identity, role, the tools available with usage examples, the policy "never mutate without proposing".
Project state block (dynamic):
Agent: name, slug, persona, spec.
Crews: each with name, spec, addon chain summary (plugin id + key config), fields.
Agent fields + per-crew fields, with how-to-extract guidance.
Spec snapshot (P5.3+): auto + notes sections, included so Alfred sees it like the user does.
Recent Alfred chat history: last 10 turns of THIS chat.
Recent agent_log (P5.3+): last 5 applied changes with reasons, so Alfred has memory of what's been done.
Context size budget: 4K–8K tokens for project state on a moderate agent; fine for Sonnet 4.6's window. We can prune later (summarize stale crews) if it gets big.

Open questions for you to call
Tool format: stick with Anthropic's native function-calling protocol (lets Alfred call multiple tools per turn cleanly) vs. ask the LLM to output a JSON block we parse manually (simpler but less robust). I'd go native. Confirm?

Apply confirmation flow: my current plan is the Apply button opens a tiny inline confirmation (Reason: [editable text]  [Apply] [Cancel]) — not a modal. Quick to dismiss, visible inline with the proposal. Or do you want a full modal?

Manual edit logging: should we log to agent_log for every save the user makes manually (not via Alfred)? Saying yes makes the log a complete audit trail. Saying no keeps it focused on Alfred changes. I'd say yes with actor: 'manual', reason: '' (user can edit reason after the fact from the log view if they want). Yes/no?

One-row-per-agent vs. versioned specs: agent_specs as designed has one row per agent — the auto section is always current, notes always current. Alternative: spec is versioned alongside the agent's version snapshots. I'd start with one-row (simpler); add versioning when there's a real use case.

agent_log UI: just an Alfred read tool, or also a visible UI panel in the agent view? My pick: also a UI panel — collapsible "Changes" section on the agent view, latest at top, with reason + diff. Cheap to add once the table is there.

Build order — what I'd ship in what order
Slice	Estimated effort	User value
P5.1 (brainstorm only)	1 working session	High — turns the placeholder tab into something useful.
P5.2 (propose-apply + agent_log)	1.5 working sessions	Very high — Alfred actually does work.
P5.3 (spec snapshot)	1 working session	Medium — incremental, once P5.2 has proven itself.
I'd ship P5.1, use it for a day or two, then P5.2. Don't bundle them — the conversation surface needs to feel natural before we layer proposals onto it.

What I'd want before starting P5.1
Confirm the 5 open questions above (or override them).
Confirm DB-migration approach: add 029_add_alfred_chats.sql (plain DDL) + a run-029-…js runner like the other migrations.
Say yes / pick options / push back and I'll start with P5.1.

