# ADMIN_V2 — Porting the V1 Agent Admin/Dashboard into the V2 Builder

> Handoff spec for a **fresh session**. The author of this doc built the V2
> customer-facing chat (see `LYBI_LIVE_CHAT_PLAN.md`) and is staying on that
> task; this is for someone else to pick up. KB is a connected sub-task with
> its own doc: **`KB_V2.md`** (read it after the §KB section here).

---

## 1. Context & goal

The platform has **V1** (legacy runtime + a rich agent **admin/dashboard**) and **V2**
(the **builder** — `/:agent/builder`, addon/cortex engine). We already built the V2
**customer-facing chat**. Now we want the **V1 admin/dashboard available for every
agent created in V2** — not just the handful of hardcoded V1 agents.

The core shift: V1's dashboard keys off a **static agent registry** (`agents/agentRegistry.ts`
+ per-agent `*.config.ts`). V2 agents are **created dynamically** in the builder, so the
ported admin must work from the **builder agent slug alone** (resolved live via
`fetchProject`), with **no static config**. "Available per any agent we create" = derive
everything from the builder agent, not a registry.

**Recommended integration:** mount the admin **inside the builder** as a new top-level
view at **`/:agent/builder/admin`** (the builder is already the per-agent home, already
resolves the agent + auth + providers). Reuse V1's dashboard components/services where
they're already `(agentName, baseURL)`-parameterized; drop their `AgentConfig` dependency.

---

## 2. Scope decisions (read first)

V1's dashboard has ~19 entries. They split three ways for V2/Lybi:

| V1 entry | V2 disposition | Why |
|---|---|---|
| **Feedback** | ✅ Port | Generic, agent-scoped by slug. Useful for any agent. |
| **Users** | ✅ Port | Generic, tenant/agent-scoped. |
| **User Conversations** (drill-down) | ✅ Port (rewire to V2 runtime) | V2 already has conversations/messages/memory endpoints — see §5. |
| **Billing** | ✅ Port | Generic provider cost aggregation. |
| **LLM Usage** | ✅ Port | Generic per-process/model/crew token usage. |
| **Settings** (contact email / notifications) | ✅ Port | Generic per-agent settings. |
| **Test Runner** (synthetic users) | ◑ Optional | Generic but heavier; port if wanted. |
| **Cloud Run Logs** | ◑ Optional | Infra/ops; nice-to-have. |
| **Knowledge Base** | → **KB_V2.md** | Separate sub-task; belongs in builder **addons**, not just admin. |
| **Dynamic KB** | → **KB_V2.md** | Part of the KB task. **NB:** "Dynamic KB" (editable files) ≠ V2 "Dynamic Context" (enum/`dc:` tokens) — different things, don't conflate. |
| **Crew**, **Crew Editor (AI)**, **Crew Playground** | ❌ Skip (superseded) | These edit **V1 legacy crews**. In V2 the **builder itself IS the crew editor**. Don't port. |
| **Query Optimizer**, **Data Loader** | ❌ **Skip for Lybi** (Aspect-only) | **Data-agent** features for the Aspect client — require a SQL `database.schema`. Lybi agents have none, so they're already schema-gated off. Keep them gated; do not surface for Lybi. |
| **Podcast** | ❌ Skip | Freeda-specific. |
| **Conversation Trends** | ◑ Optional | Banking-v2-specific today; could generalize later. |
| **Library (Pinecone)** | ❌ Skip unless needed | Vector DB admin, niche. |

**User's explicit note:** the data-agent features (Query Optimizer, Data Loader) are for
the Aspect client and **not needed for Lybi**. They're gated behind a per-agent SQL schema —
keep that gate; a V2 agent with no schema simply won't show them. If V2 ever needs them for
a data-agent, the gate is a per-agent setting (see §6).

**Net "must-port" set for Lybi:** Feedback · Users · Conversations · Billing · LLM Usage ·
Settings. KB/Dynamic-KB go through `KB_V2.md`. Everything else is skip/optional.

---

## 3. V1 admin — how it works today (inventory)

- **Routes** (`aspect-react-client/src/App.tsx`): `/:agent/dashboard/*` and `/:agent/admin/*`
  → `MaybeDashboard` → `pages/DashboardPage.tsx` (the router hub; resolves `getAgentConfig(agent)`,
  wraps in `ThemeProvider` + `AgentProvider`, sub-routes each entry).
- **Shell/nav**: `components/dashboard/DashboardLayout/DashboardLayout.tsx` — sidebar with the entry
  list; conditional items gated by `config.database?.schema` (Query Optimizer / Data Loader) and
  agent id (Podcast=freeda, Trends=banking-v2). Admin-vs-Business user type in `localStorage['adminUserType']`.
- **Entries → components** (all under `components/dashboard/<Name>/`): FeedbackPage, UsersPage,
  UserConversationsPage, CrewPage, CrewEditorAI, CrewPlayground, QueryOptimizerPage, DataLoaderPage,
  PodcastPage, BillingPage, LLMUsagePage, SettingsPage, TestRunnerPage, ConversationTrendsPage,
  CloudRunLogsPage, DynamicKBPage.
- **Services** (`src/services/*`): `adminService.ts` (users/stats), `feedbackService.ts`,
  `crewService.ts`, `conversationService.ts`, `kbService.ts`, `dynamicKBService.ts`,
  `testRunnerService.ts`, `podcastService.ts`. **Most take `(agentName, baseURL)` explicitly — no
  global context — which makes them cleanly reusable.**

### Server endpoints for the must-port set (in `aspect-agent-server/server.js`)
- **Feedback:** `GET /api/agents/:agentName/feedback`, `/feedback/stats`, `/feedback/tags`,
  `/feedback/tags/search`; `GET|POST /api/messages/:messageId/feedback`;
  `PATCH|DELETE /api/feedback/:feedbackId`. Tables: `feedback_tags`, `message_feedback`.
- **Users:** `GET /api/admin/users` (filters `?source&tenant&search&limit&offset`),
  `GET /api/admin/stats`, `GET /api/admin/tenants`, `GET|PATCH|DELETE /api/admin/users/:userId`,
  `POST /api/admin/users`, `POST|DELETE /api/admin/users/:userId/link`. Tables: `users`,
  `conversations`, `messages` (tenant via `users.tenant` / `agent_id`).
- **Billing:** `GET /api/admin/billing` → `{ openai, anthropic, google }` month-to-date.
- **LLM usage:** `GET /api/admin/usage`, `/api/admin/usage/summary`. Table: `llm_usage_log`
  (`agent_name`, `crewMember`, `model`, `process`, tokens).
- **Settings:** `GET|PATCH /api/admin/agents/:agentName/settings` (`contact_email`). Table: `agent_settings`.

---

## 4. V2 builder — where the admin attaches

- **Doc model** (`aspect-agent-server/builder/types/index.ts`, synced to client — see §8 gotcha):
  `ProjectDoc → AgentDoc → CrewDoc`; `AgentDoc` has `slug`, `name`, `fields`, `parameters`,
  `domains`, `cortex`, `crews`, `versions`, `activeVersionId`/`viewingVersionId`.
- **Client shell**: `src/builder/BuilderApp.tsx` gates the agent (`fetchProject({agentSlug,ownerUserId})`),
  wraps providers, renders `BuilderShell` which has **nested `<Routes>`** inside the center canvas:
  ```
  /:agent/builder            → Canvas (Project/Agent/Crew view by sidebar selection)
  /:agent/builder/enums      → DynamicContextScreen
  /:agent/builder/personas   → PersonasScreen
  ```
- **Attach point (recommended):** add `‹Route path="admin" element={‹AdminDashboard /›} /›` to
  `BuilderShell` → **`/:agent/builder/admin`**, plus an "Admin / 📊" entry in the builder Sidebar
  (or TopBar). The admin reads the agent from `useCurrentAgent()` / `useBuilder()` (slug + name) —
  **no static AgentConfig**.

### New files (suggested)
```
aspect-react-client/src/builder/components/AdminDashboard/
  AdminDashboard.tsx        # shell: tab nav (Feedback|Users|Conversations|Usage|Billing|Settings)
  tabs/FeedbackTab.tsx      # reuse logic from components/dashboard/FeedbackPage
  tabs/UsersTab.tsx
  tabs/ConversationsTab.tsx # rewired to V2 runtime endpoints (§5)
  tabs/UsageTab.tsx
  tabs/BillingTab.tsx
  tabs/SettingsTab.tsx
  AdminDashboard.module.css
```
Port the V1 component bodies, swapping their `AgentConfig`/`AgentProvider` reliance for the
builder agent `slug`/`name`. Keep reusing the existing `src/services/*` (feedbackService,
adminService, etc.) — they already take `(agentName=slug, baseURL)`.

---

## 5. The critical wiring: agent identity (builder ↔ runtime)

This is the make-or-break detail. Two agent tables:
- **`builder_agents`** — `id` (`agent_*`), `slug` (URL key), `activeVersionId`/`viewingVersionId`.
  This is what the builder edits.
- **`agents`** (runtime/legacy) — `id` (serial), `urlSlug`, `domain` (`'builder-v2'` for builder
  agents), `isActive`. Conversations/feedback/usage key off **this** `agents.id`.

The bridge is in `aspect-agent-server/builder/routes/runtimeRoute.js` (`resolveLegacyAgentId(slug)`):
on first conversation it finds/creates an `agents` row with `urlSlug === slug`, `domain='builder-v2'`.
So **all V2 runtime data (conversations, messages, addon_runs, llm_usage) is keyed to the runtime
`agents.id` resolved from the builder slug.**

**Implication for admin:** the V1 admin endpoints are keyed by `:agentName` (== slug) or by
`agent_id`. For V2:
- Endpoints already keyed by **slug** (`:agentName`) work if the slug matches the runtime row's
  `urlSlug` — confirm each endpoint resolves slug → runtime `agents.id` (not the static registry).
- **Conversations/messages/memory: prefer the V2 runtime endpoints** the chat already uses
  (cleaner, already slug-scoped):
  - `GET /api/agents/:slug/conversations?ownerUserId=…` (list)
  - `GET /api/agents/:slug/conversations/:convId/messages`
  - `GET /api/agents/:slug/conversations/:convId/memory` (brain blob: memory/thinking/summary)
  - `GET /api/agents/:slug/messages/:messageId/runs` (addon_runs — the full per-message addon trail)
  - `client: aspect-react-client/src/builder/state/builderApi.ts` already wraps these.
- **Watch out:** V2 conversations are scoped by `ownerUserId` for *listing* (the per-browser
  `builder:ownerUserId`). An **admin** wants **all** conversations for the agent regardless of owner.
  The existing list endpoint filters by owner → **a new admin endpoint is likely needed**:
  `GET /api/agents/:slug/admin/conversations` (no owner filter, keyed only by runtime `agents.id`).
  This is the main server addition for the Conversations tab.

---

## 6. Per-agent settings (where new admin settings live)

V2 has no per-agent settings registry. Two options:
1. **In the doc** — add `settings?: AgentSettings` to `AgentBody`/`AgentDoc`
   (`builder/types/index.ts`): e.g. `{ database?: { schema }, features?: Record<string,bool>,
   contactEmail?, branding? }`. Versioned with the agent body. Best for builder-native settings
   (feature flags, the data-agent `database.schema` gate, etc.). Requires a small AgentView panel.
2. **In `agent_settings`** (existing table, keyed by agentName/slug) — reuse V1's
   `GET|PATCH /api/admin/agents/:agentName/settings` for runtime-ish settings (contact email).

**Data-agent gate:** the Query Optimizer / Data Loader visibility = `settings.database?.schema`
present. For Lybi leave it unset → features hidden. (User: not needed for Lybi.)

---

## 7. KB — pointer to the sub-task

KB is **not** just an admin page in V2 — per the user it must become **part of the builder addons**
(an addon can reference a KB; static + dynamic KB; multi-provider). That design + the full V1 KB
map (OpenAI vector stores, Google File Search, Anthropic Files; `knowledgeBases`/`knowledgeBaseFiles`/
`dynamicKBFiles` tables; `/api/kb/*` endpoints) lives in **`KB_V2.md`**. Do the admin port first
(or in parallel) but treat KB as its own milestone.

---

## 8. House rules / "how we work here" (honor these)

These conventions were established building the V2 chat — follow them:
- **Reuse, don't reinvent.** Pull from V1 where it's already parameterized; keep the **V2 runtime**
  as the engine. Don't drag V1's ChatContext/legacy-runtime baggage.
- **Per-agent, config-free.** Everything must work for any builder slug with no static registry.
- **Flag spec conflicts** instead of silently choosing; surface trade-offs, recommend one.
- **TypeScript is strict:** `tsconfig.app.json` has `noUnusedLocals` + `noUnusedParameters`.
  The build is `tsc -b && vite build`. Verify with `npx tsc -b` and keep **your** files at zero errors.
- **⚠️ Synced-types gotcha (will bite you):** `aspect-react-client/src/builder/types/index.ts` is
  **git-tracked but regenerated** from the server's `builder/types/index.ts` by
  `scripts/sync-builder-types.cjs`, which runs on `predev`/`prebuild`/`postinstall`. In this working
  tree the **server types lag the client code** (missing `personas`/`PersonaDef`), so running
  `npm run dev`/`build` **clobbers** the good client types and injects ~30 phantom errors. If you see
  `personas`/`PersonaDef` errors, run `git checkout -- aspect-react-client/src/builder/types/index.ts`
  to restore. When you add a type for an addon/admin, add it to the **server** source so the sync keeps it.
- **There are ~8 pre-existing builder type errors** (`src/builder/plugins/*Config.tsx` Record/`FieldDef`,
  `DynamicContextScreen` unused `ID`) unrelated to this work — don't be alarmed; just don't add new ones.
- **CSS:** scope new surfaces so they don't leak (the chat uses a `.lybi-*` prefix + data-attrs on a
  wrapper, never mutating `document.documentElement`). The builder uses CSS modules — match it there.
- **Adding an addon = 3 files + 2 registrations** (see §9 / `BUILDER_V2_ADDONS.md`). The KB task uses this.

---

## 9. Adding an addon (you'll need this for KB) — the contract

One descriptor JSON is the single source of truth, read by server + client + Alfred:
1. `aspect-agent-server/builder/addons/<id>.addon.json` — `pluginId`, lanes, output types,
   `defaultConfig`, `defaultPromptTemplate`, `purpose` (Alfred reads it).
2. `aspect-agent-server/builder/plugins/<id>/addon.<id>.js` — `registerPlugin({ id, allowedOutputTypes,
   async run(ctx) {…} })`; `run` returns `{ rawOutput, parsedOutput?, memoryWrites?, assistantText?,
   tokens, durationMs }`. Register via `require()` in `builder/plugins/index.js`.
3. `aspect-react-client/src/builder/plugins/<id>/addon.<id>.ts` — `PluginDescriptor` built from the
   JSON (`import descriptor from '@addons/<id>.addon.json'`) + a `ConfigComponent`; `registerPlugin(...)`.
   Register via `import` in `src/builder/plugins/index.ts`. Config UI in `<Id>Config.tsx`.
   Walk an existing one (`talker`, `fieldExtractor`) as the template.
- **Prompt assembly is byte-equal** between client preview (`buildPromptPreview.ts`) and server
  (`runtime/promptAssembler.js`). Keep them in lockstep.

---

## 10. Verification

1. Server (`cd aspect-agent-server && npm start`, :3000) + client (`npm run dev`).
2. Build/edit an agent in the builder; open `/:agent/builder/admin`.
3. Feedback/Users/Usage/Billing/Settings tabs render real data for **that** agent slug (try a
   second agent — must work with zero static config).
4. Conversations tab lists **all** conversations for the agent (not owner-filtered) and drills into
   messages + the addon trail (`/messages/:id/runs`).
5. Confirm the data-agent features (Query Optimizer/Data Loader) **do not** appear for a schema-less
   Lybi agent.
6. `npx tsc -b` → your files clean (restore the synced types file first if `personas` errors appear).

## 11. Risks / open questions
- **Owner-scoped vs all-conversations** for admin (needs the new no-owner-filter endpoint, §5).
- **Slug → runtime agents.id** resolution must be consistent across every reused endpoint (some use
  `agent_id`, some `agent_name`); audit each before reuse.
- **Auth/gating:** who can see `/:agent/builder/admin`? The builder is currently open (no auth, same
  as the chat). Decide whether admin needs gating before exposing user PII (Users tab).
- **`agents` row may not exist** until the agent has had ≥1 conversation (created lazily). Admin for a
  brand-new agent should handle "no runtime data yet" gracefully.
