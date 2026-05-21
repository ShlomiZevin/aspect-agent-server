# Next-session prompt — Builder V2 P2 onward

Paste the block below as the first message in a fresh Claude Code
session. Everything Claude needs to pick up is in the docs index
plus the locations called out.

---

```
You're picking up work on the Aspect project — a multi-agent AI chat
platform (Node.js + Express + Postgres/Drizzle on the server,
React 19 + Vite + TypeScript on the client).

# Orient yourself first (read in this order)
1. /CLAUDE.md — repo overview.
2. aspect-agent-server/docs/INDEX.md — docs index.
3. aspect-agent-server/docs/guides/BUILDER_V2.md — the V2 plugin-
   based agent builder design + decisions journal (32 entries).
4. aspect-agent-server/docs/guides/BUILDER_V2_RUNTIME_PLAN.md — the
   plan for wiring runtime. P1 is done; you're starting P2.

Skim the user-memory at C:/Users/shazbak/.claude/projects/c--workspace-aspect/memory/
(especially feedback_modals_over_inline.md and feedback_minimal_explanatory_copy.md) —
those are standing UI preferences for this codebase.

# Where things are

V2 builder client: aspect-react-client/src/builder/
  - state/BuilderContext.tsx       — single source of truth
  - state/builderApi.ts            — fetch wrappers
  - state/useProjectSync.ts        — load/bootstrap + push helpers
  - state/runtimeStream.ts         — SSE consumer
  - components/ChatPanel/UserChat.tsx — sends turns, renders timeline
  - components/AddonRun/            — AddonRunCard + AddonRunTimeline
  - components/PromptTemplateModal/buildPromptPreview.ts — CLIENT
    prompt assembly; must stay byte-equal to the server's.

V2 builder server: aspect-agent-server/builder/
  - routes/projectsRoute.js        — /api/builder/* (doc CRUD)
  - routes/runtimeRoute.js         — /api/agents/:slug/* (runtime + convs)
  - runtime/BuilderRunner.js       — orchestrator, blocking lane
  - runtime/promptAssembler.js     — SERVER assembly; must mirror client
  - runtime/outputParser.js        — JSON extract for json-to-memory
  - services/builderProjects.js    — DB CRUD over the 5 builder_* tables

V2 DB: aspect-agent-server/db/schema/builder.js — projects, agents,
agent_versions, crews, crew_versions. All prefixed builder_*.
Coexists with legacy `agents` / `crewMembers` tables (those power v1
chats, unchanged).

# What works after P1

- Open /<agent>/builder. The client hydrates from server (or
  bootstraps if 404) at /api/builder/projects.
- Save / Save As / Set Active / Set Viewing on both crew + agent
  push to /api/builder/* surgically. Reload in another browser =
  same state.
- User Chat panel: send a message → POST to
  /api/agents/:slug/conversations/:convId/messages → SSE → live
  AddonRunCards (prompt + raw output + parsed JSON + memory writes)
  → Talker streams tokens into the transcript.
- llm_usage rows already log automatically via services/llm.js.
- Dirty-warning chip in UserChat when the viewing crew has unsaved
  edits ("Save first to include them").

# What P1 explicitly did NOT do (your work, in priority order)

P2 — addon_runs persistence + memory + history reads:

1. Create the addon_runs table (schema sketch + run_data shape are
   in BUILDER_V2_RUNTIME_PLAN.md under "Data model" / "P2"). Add it
   to aspect-agent-server/db/schema/builder.js and export from
   schema/index.js.

2. In aspect-agent-server/builder/runtime/BuilderRunner.js:
   - Insert one addon_runs row per addon execution (status,
     started_at, ended_at, duration_ms, run_data JSON).
   - The run_data JSON should match the addon.output event payload
     so the historical view reconstructs identical data.

3. Memory writes — turn the per-turn scratch into real persistence:
   - For each extractor's parsed_output, iterate fields and write
     to context_data (conversation-scoped). The existing
     services/context.service.js has writeContext/getContext.
     Build a small services/builderMemory.js wrapper that knows
     about field.domain.
   - Currently BuilderRunner.js uses an in-memory `turnScratch` map
     for downstream addons in the same turn — replace that with
     reading from context_data so it survives turns.

4. History reads — wire context.history to the LLM call:
   - When invoking llm.js, fetch the last-N / full history from the
     messages table and pass it as the message-history parameter
     (provider-specific shape). NOT interpolated into the prompt.
   - Currently P1 passes no history at all.

5. Memory reads — assemble the ## Memory block from context_data:
   - In promptAssembler.js, the `memoryValuesByDomain` callback
     currently returns {}. Wire it to read context_data for the
     selected domains. Match the client's same-fields-with-values
     contract (skip nulls).

P3 — historical view:

6. GET /api/agents/:slug/messages/:messageId/runs → returns the
   addon_runs rows for one assistant message.

7. UserChat: clicking a past assistant message expands its
   AddonRunTimeline (reuse the existing component) populated from
   the persisted rows.

8. Conversation switcher in UserChat: dropdown using
   GET /api/agents/:slug/conversations (already exists).

9. DELETE /api/agents/:slug/conversations/:convId already exists;
   add addon_runs cascade once that table is in.

# Known P1 gotchas to verify before P2

- The 5 builder_* tables have NOT been migrated to the running DB.
  Run `npm run db:push` (or generate + migrate) in
  aspect-agent-server/ before the runtime endpoint can succeed.
- The runtime expects builder_agents.slug to match the URL slug.
  Existing slugs in client routes: aspect, banking, banking-v2,
  byline, compass, foreman, freeda, newdeli, thestock, hypertoy,
  tiktok, zer4u. For builder previews, the slug works as a label —
  the v1 agents table is only touched to satisfy
  conversations.agentId FK (a placeholder row is created if no
  existing agent has that slug).
- Prompt-template byte-equality contract between client
  buildPromptPreview.ts and server promptAssembler.js — if you
  change one, change both. The placeholder list is in
  aspect-react-client/src/builder/types/index.ts
  (KNOWN_PROMPT_PLACEHOLDERS). Adding a placeholder = update map +
  both assemblers.
- Talker streaming uses llm.js's sendMessageStreamWithPrompt.
  Field Extractor uses sendOneShot. The model field is the
  `modelId` string flattened from { providerId, modelId }; llm.js
  routes by prefix (claude-, gemini-, gpt-).
- Some BuilderContext mutations were converted from functional
  setDoc updater to imperative compute so the sync push could see
  the new entity. This pattern (`let updated; setDoc(d => { ...
  updated = next; return ...; }); if (updated) syncRef.current?.pushXxx(updated)`)
  is fine for user-initiated single events but won't survive
  concurrent mutations. Acceptable for the builder's flow.

# Working style for this codebase (saved to memory but worth knowing)

- Modal-first, never window.confirm(). Use the existing Confirm
  context (useConfirm).
- Minimal explanatory copy in the UI — pill badges, one-line
  summaries, tooltips. Long paragraphs are useful at first, become
  clutter once the user understands the surface.
- Plan + decisions go in BUILDER_V2.md / BUILDER_V2_RUNTIME_PLAN.md
  decisions journal — keep adding entries as you make trade-offs.
- Phased delivery: pause after each P# for review.

Start by reading the three docs above and BUILDER_V2_RUNTIME_PLAN.md's
"Phasing → P2" section. Then plan P2's slice and confirm with the
user before touching code.
```
