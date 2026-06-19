# KB_V2 — Integrating Knowledge Bases into the V2 Builder (addons)

> Sub-task of **`ADMIN_V2.md`** (read that first for the builder doc model, the
> addon contract in §9, the agent-identity bridge, and the house rules incl. the
> **synced-types clobber gotcha**). This doc covers the KB system end-to-end and
> how to bring it into the V2 builder as **addon-attached** knowledge.

---

## 1. Goal & the key idea

V1 has a mature, **multi-provider** KB system (OpenAI vector stores, Google File Search,
Anthropic Files), plus admin-editable **dynamic KB** files. The user wants KB to live **in the
builder, attached to addons** — "it has to be part of the addons part of the builder" — so an
agent author can give a specific addon (e.g. a Talker/Thinker) access to a KB, per crew.

> ⚠️ **Naming trap:** V1 **"Dynamic KB"** = admin-editable markdown/table files synced into a KB.
> V2 **"Dynamic Context"** (`BUILDER_V2_DYNAMIC_CONTEXT.md`, the `{{dc:…}}` / `{{enum:…}}` tokens) is
> a *different* feature (value-keyed prompt text). **Do not conflate them.** This doc's "dynamic KB"
> always means the editable-files feature.

---

## 2. V1 KB system — end-to-end map

### Client
- **UI:** `aspect-react-client/src/components/kb/KBManager/KBManager.tsx` (+ `SyncKBModal`) — create KB
  (pick providers), upload files (drag/drop, progress), DB-view vs Provider-view, delete, **sync KB to
  another provider**, detach provider, attach dynamic files, download from GCS, preview.
  Page: `pages/KBPage.tsx` (route `/kb/:agent`). Also referenced in chat debug
  (`PromptEditorPanel` KB-source selection).
- **Services:** `src/services/kbService.ts` (`getKnowledgeBases`, `createKnowledgeBase(name,desc,agent,
  providers[])`, `uploadFiles`, `rename`, `delete`, `deleteFile`, `detachProvider`, `syncKnowledgeBase`,
  `getProviderFiles`, `deleteProviderFile`, `previewFile`); `src/services/dynamicKBService.ts`.
  Types: `src/types/kb.ts` (`KnowledgeBase`, `KBFile`, `KBProviderName = 'openai'|'google'|'anthropic'`).
  Hooks: `useKnowledgeBase.ts`, `useDynamicKB.ts`.

### Server endpoints (`aspect-agent-server/server.js`, ~lines 2474–3070)
```
POST   /api/kb/create                        { agentName, name, description, providers[] }
GET    /api/kb/list/:agentName
GET    /api/kb/:kbId/files
POST   /api/kb/:kbId/upload                   FormData(file, tags)   → uploads to all providers + GCS
GET    /api/kb/:kbId/files/:fileId/download
PATCH  /api/kb/:kbId                          { name }
DELETE /api/kb/:kbId
DELETE /api/kb/:kbId/files/:fileId
POST   /api/kb/:kbId/sync                     { targetProvider }     → copy files to another provider
POST   /api/kb/:kbId/detach                   { provider }
GET    /api/kb/:kbId/provider-files
DELETE /api/kb/:kbId/provider-files/:provider?fileId=…
GET    /api/kb/:kbId/files/:fileId/preview
```

### DB schema (`aspect-agent-server/db/schema/index.js`)
- **`knowledgeBases`**: `id, agentId(FK agents.id), name, description, providers(jsonb),
  vectorStoreId(OpenAI vs_*), googleCorpusId(fileSearchStores/*), syncedFromId, lastSyncedAt,
  fileCount, totalSize, metadata`.
- **`knowledgeBaseFiles`**: `id, knowledgeBaseId(FK), fileName, fileSize, fileType,
  openaiFileId, googleDocumentId, anthropicFileId, originalFileUrl(GCS), status, metadata(tags)`.
- **`dynamicKBFiles`**: `id, agentId, name, fileType('text'|'table'), gcsPath, fileSize` — admin-editable.
- **`dynamicKBAttachments`** (junction): `dynamicFileId ↔ knowledgeBaseId ↔ kbFileId`.
- KB references on crews today (V1 legacy): `crewPrompts.kbSources(jsonb)`,
  `crewMembers.knowledgeBase` / `knowledgeBaseSources`.

### Providers (per-provider service + runtime retrieval)
- **OpenAI** (`services/kb.openai.service.js`): vector store; runtime adds a `file_search` tool with
  `vector_store_ids:[vectorStoreId]`; results stream back as SSE `file_search_results`.
- **Google** (`services/kb.google.service.js`): File Search store; configured via Gemini
  `tool_config.file_search.stores`; auto-converts xlsx/docx → text on upload.
- **Anthropic** (`services/kb.anthropic.service.js`): **not semantic search** — files injected as
  `document` blocks into the first user message (`services/llm.claude.js`). Claude reads all of it.
- Orchestrator: `services/kb.service.js` (`uploadFileToProviders`, `deleteFileFromProviders`,
  `listProviderFiles`, `syncToProvider`) — DB is provider-agnostic, retrieval is provider-specific.

### Static vs Dynamic
- **Static KB:** user-uploaded files, immutable after upload, stored in DB + provider store + GCS.
- **Dynamic KB:** admin-editable markdown/table (`dynamicKBFiles` on GCS), attached to a KB via
  `dynamicKBAttachments`; re-fetched from GCS on sync. Edited in `DynamicKBPage`.

### V2 builder KB state today
- **None.** `CrewBody.addons[]` has no KB field; no KB addon; no KB picker in the addon modal.
  Endpoints + provider services all exist and are reusable as-is. This is greenfield wiring on the
  builder side.

---

## 3. Recommended V2 integration

Two layers — **registry** (where KBs live) + **reference** (how an addon uses one):

### A. KB registry at agent level
KBs already key off `agentId` in `knowledgeBases`. In V2 that's the **runtime `agents.id` resolved
from the builder slug** (see `ADMIN_V2.md` §5 — `resolveLegacyAgentId(slug)`). So:
- A **"Knowledge Bases" panel in the builder AgentView** that calls the existing `/api/kb/*` endpoints
  with the agent slug (server resolves slug → runtime `agents.id`). This reuses `KBManager` almost
  verbatim — port it into the builder AgentView, swap its `agentName`-from-config for the builder slug.
- This gives create/upload/sync/delete per agent **inside the builder** (no separate `/kb/:agent` page).

### B. Per-addon KB reference (the "addons" requirement)
Let an addon opt into one or more of the agent's KBs. Smallest, cleanest shape: add an optional
universal field to `AddonInstance.context` (or a per-plugin config field) referencing KB ids:
```ts
// builder/types/index.ts  (server source → synced to client; see ADMIN_V2 §8 gotcha)
interface AddonContext {
  history: HistoryMode;
  // …existing…
  knowledge?: { kbIds: ID[] };   // KBs this addon may search this turn
}
```
- **UI:** a small "Knowledge" section in the **AddonModal** (universal, like Context/Output) — a
  multi-select of the agent's KBs. Only meaningful for LLM-calling addons (talker/thinker/extractors);
  hide for routers/summarizers via the descriptor (`hideStandardSections`-style flag).
- **Runtime:** in the addon's `run(ctx)` (or centrally in `BuilderRunner`/`addonRunner`), resolve
  `context.knowledge.kbIds` → KB rows → provider store ids, and pass them into the LLM call exactly as
  V1 does:
  - OpenAI: add `file_search` tool with the KBs' `vectorStoreId`s.
  - Google: set `tool_config.file_search.stores` to the `googleCorpusId`s.
  - Anthropic: inject the KBs' files as `document` blocks.
  Emit the existing `file_search_results` signal so the chat can surface referenced files (the V2 chat
  already has a "thinking process"/addon-trail surface to hang this on).

> Alternative considered: a dedicated **"KB Loader" addon** type. Rejected as the primary path because
> KB should augment *existing* LLM addons, not be a separate step — but a KB-loader addon could still be
> added later for "inject these docs into every prompt" use-cases. Per-addon reference (B) is the
> requested model.

### C. Dynamic KB
Port `DynamicKBPage` into the builder (under the AgentView KB panel or admin) only if needed; it reuses
`dynamicKBService` + `/api/kb/*` attach endpoints unchanged. Lower priority than static KB.

---

## 4. Build order
1. **AgentView KB panel** — port `KBManager` into the builder, slug-scoped. (Reuses all `/api/kb/*`.)
2. **`AddonContext.knowledge.kbIds`** type (add to **server** `builder/types/index.ts` so the sync
   propagates it) + AddonModal "Knowledge" multi-select.
3. **Runtime resolution** — KB ids → provider stores → LLM call inside addon execution, per provider.
4. **Surface referenced files** in the chat (reuse the `file_search_results` SSE + the addon trail).
5. **(Optional)** Dynamic KB editor in the builder.

## 5. Verification
- Create a KB in the builder AgentView for an agent; upload a file; confirm it lands in the chosen
  providers (DB-view + Provider-view).
- Attach the KB to a Talker addon; chat; confirm the model uses it and referenced files appear.
- Multi-provider: sync the KB to a second provider; switch the addon's model provider; confirm
  retrieval still works (OpenAI tool vs Google stores vs Anthropic doc-blocks).
- `npx tsc -b` clean (restore synced types if `personas` errors appear — ADMIN_V2 §8).

## 6. Risks / notes
- **agentId mapping:** `knowledgeBases.agentId` must be the **runtime** `agents.id` (slug-resolved),
  not `builder_agents.id`. Confirm `/api/kb/*` resolves slug consistently (audit like ADMIN_V2 §5).
- **Per-turn cost/latency:** Anthropic injects whole files into context (no search) — large KBs get
  expensive on Claude addons. Consider per-provider size caps / warnings.
- **Provider availability:** a KB only has a store on the providers it was created/synced with; if an
  addon's model provider has no store for the referenced KB, either auto-sync on demand or surface a
  clear "KB not available on <provider>" message.
- **Byte-equal prompt assembly** (ADMIN_V2 §9) — if KB injection touches prompt text, keep client
  preview and server runtime in lockstep.
- **Gotcha reminder:** new builder types go in the **server** `builder/types/index.ts`; the client copy
  is generated and will be overwritten by `sync-builder-types`.
