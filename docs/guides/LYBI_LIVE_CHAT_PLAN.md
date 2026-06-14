# Lybi 2.0 — Customer-Facing Chat (Plan)

## Context

V2 ("Lybi 2.0") is a builder with two **internal** chats (Alfred builder-chat + an in-builder *User Chat* preview). There is no **customer-facing** chat for V2 yet. The V1 chat is a good chat, but it *was* the builder — the entire V1 builder lived inside the chat behind Ctrl+Shift+D. We don't want that here: V2 has a real builder, so the customer chat should be clean, with only a small set of "hidden" dev affordances.

Noa (PM) wrote a spec + a complete HTML mockup (`C:\Users\shazbak\Downloads\lybi_demo_chat_2.html`) that fully defines the visual design and CSS. This plan builds a **new client surface** that renders Noa's design and talks to the **V2 runtime** (different engine — the new server).

**Decision: build a new client surface** (not a retrofit of V1's `ChatContainer`/`ChatContext`). Reuse infrastructure (V2 SSE parser, V2 conversation API, MarkdownBody, taskService), port the mockup's CSS 1:1, and carefully port V1's hard-won **RTL** behavior.

---

## Requirements traceability (the user's 7 points)

| # | Requirement | How the plan satisfies it |
|---|---|---|
| 0 | Agent comes from the URL; handle not-ready gracefully | `/:agent/live` — no slug config. If no builder agent for the slug → "create it in the builder" CTA; if agent exists but no active version → "publish an active version" CTA → both link to `/:agent/builder`. |
| 1 | Align with Noa's spec | Three-panel layout (Brain left / Chat / Profiler right, placeholders), RTL+He default, light default, Lybi-left/customer-right, topbar buttons, history drawer, settings popover (lang/theme/client/version/mode), DEBUG mode with per-message thinking + report. Ported 1:1 from the mockup CSS. |
| 2 | New server / different engine | Uses V2 runtime endpoints `/api/agents/:slug/conversations/*` + SSE (`runtimeStream.ts`). No new engine, no V1 endpoints. |
| 3 | RTL must be right (bubble side, title side, in-bubble alignment, corners) | Port V1's 4-layer RTL: UI `dir` on the **page wrapper** (not `<html>`), mockup's bubble-side flips, **plus** per-message content direction via V1's `isRTL()` + list-padding/`text-align:start` flips. Detailed §RTL. |
| 4 | Don't want full debug, but want delete-msg + delete-from-here | DEBUG mode (hidden, toggled in settings + Ctrl+Shift+D) reveals per-message **delete** and **delete-from-here**, reusing the V2 builder's existing `deleteMessage({…, fromHereDown})` endpoint. |
| 5 | Saving active version in builder must affect the live chat | Customer chat sends `version:'active'`. `resolveRunnable` reads `activeVersionId` **fresh from DB every turn** (no per-conversation cache) → a builder publish affects the next customer turn immediately. |
| 6 | Conversations shared with builder chat history (same user entity) | Customer chat reuses the **same** `localStorage['builder:ownerUserId']` and the same `createConversation`/`listConversations` calls. Builder lists by `agentId+userId+kind='user'` (version-agnostic), so conversations appear in both automatically. |
| 7 | Easy transition customer-chat ↔ builder (hidden) | "Open in builder" action (DEBUG mode) → `/:agent/builder?c=<convId>`; small one-file change to builder `UserChat` to load that conversation on mount. Builder side gets an "expand to live chat" link → `/:agent/live?c=<convId>` (same numeric IDs, so it just works). |

---

## Verified facts (code, with paths)

**Runtime / engine**
- `aspect-agent-server/builder/routes/runtimeRoute.js`: `POST /:slug/conversations` needs only `{ ownerUserId }` (no auth; `externalId` upsert). `POST /:slug/conversations/:convId/messages` accepts `{ ownerUserId, userMessage, version:'viewing'|'active', overrideCrewId? }`, streams SSE.
- SSE events: `conversation`, `addon.start` (has `pluginId`), `addon.token` (talker only), `addon.output` (**no `pluginId` — only `instanceId`**; keep a per-turn `instanceId→pluginId` map), `addon.error`, `assistant.message`, `done`.
- **Active vs viewing**: `aspect-agent-server/builder/services/builderProjects.js` `resolveRunnable()` — `mode==='active' ? agent.activeVersionId : agent.viewingVersionId`, read **per message**, **no per-conversation caching**. Throws `'Agent has no version pointer'` if the chosen pointer is null. → point 5 works; must handle the "no active version" error gracefully.

**Reusable client infra (zero builder-context deps)**
- `aspect-react-client/src/builder/state/runtimeStream.ts` → `sendRuntimeMessage(args)`, `RuntimeEvent`.
- `aspect-react-client/src/builder/state/builderApi.ts` → `createConversation` (L253), `fetchConversationMessages` (L293), `fetchRunsForMessage` (L340), `deleteMessage({agentSlug,conversationId,messageId,fromHereDown})` (L359), `listConversations` (L466); types `ConversationListItem`, `ConversationMessage`, `PersistedAddonRun`. `BASE_URL` from `VITE_API_URL`.
- `aspect-react-client/src/builder/components/ChatPanel/MarkdownBody.tsx` → `MarkdownBody`.
- Logic to **port** (component-local in `UserChat.tsx`): `messagesToTurns`, the `handleEvent` SSE switch, auto-scroll pattern, `deleteTurnSelf()` (L550) / `deleteTurnFromHere()` (L572).

**Shared identity / history**
- Builder owner id: `localStorage['builder:ownerUserId']` (fallback `'anon'`) — `UserChat.tsx:69-76`. **Reuse this exact key.** If missing, generate once and write it back to the same key (builder will then also adopt it).
- `listConversations({agentSlug, ownerUserId})` → server filters `agentId + userId + kind='user'`, `orderBy(updatedAt desc) limit 50`. Item shape `{ id:number, name|null, createdAt, updatedAt, metadata }` (name auto-set from first user message). No description → drawer second line = relative time; group client-side Today / Last 7 days / Older.

**Delete**
- V2 reuse: `deleteMessage({ agentSlug, conversationId, messageId, fromHereDown })` → `DELETE /api/agents/:slug/conversations/:convId/messages/:messageId` body `{ fromHereDown }`. `fromHereDown:true` deletes all messages with `createdAt >= pivot`.

**RTL in V1 (to replicate)**
- `LanguageContext.tsx:35-38` sets `dir`/`data-lang` on `document.documentElement` (we will scope to the **page wrapper** instead).
- Per-message direction: `Message.tsx:24-28` `isRTL(text)` (first real letter vs Hebrew `֐-׿` / Arabic `؀-ۿ` / Syriac `܀-ݏ`), applied as `dir={rtl?'rtl':undefined}` on the bubble content span / markdown div (`Message.tsx:248,313`).
- `styles/rtl.css`: bubble margin flips, list padding flips (`[dir="rtl"] … ul{padding-right;padding-left:0}`), `unicode-bidi:plaintext` for mixed content, send-arrow `scaleX(-1)`.
- `utils/textDirection.ts`: `containsHebrew`, `isMostlyHebrew`, `autoDir` (Hebrew-only; V1's `Message.tsx` `isRTL` is broader — use that).

**Routing**
- Builder: `/:agent/builder/*` (`BuilderPage.tsx` reads `:agent`). Customer V1: `/:agent/chat`. No cross-link exists today. Builder uses **numeric** conv IDs (same as our new chat → deep-linkable by id). `/lybi/*` is a splat to `LybiLandingPage`; `/:agent/live` should out-rank it, with explicit `/lybi/live` as a safety net.

---

## Decisions

- **Route**: `/:agent/live` (customer-facing = the *active/live* version). Entry e.g. `/lybi/live`. **The agent is the URL slug — no slug config needed.** Add explicit `/lybi/live` too if the `/lybi/*` splat shadows it.
- **Version**: send `version:'active'`.
- **Agent-not-ready empty states — reuse the builder's own gate.** On load, call `fetchProject({ agentSlug, ownerUserId })` from `builder/state/builderApi.ts` (same call the builder uses at `BuilderApp.tsx:78`). It answers both states with **no new server endpoint**:
  - **No builder agent for this slug** → `fetchProject` returns `null` (404). Show "אין כאן סוכן עדיין — צור אותו ב-Builder" / "No agent here yet — create one in the builder" → button to `/:agent/builder` (the builder's own Create gate takes it from there). *(Optional: replicate the builder's inline Create via `bootstrapProject`; default is to redirect to the builder.)*
  - **Agent exists but no active version** → returned `ProjectDoc.agents[i].activeVersionId` is empty → "כדי לעלות ל-Live צריך לשמור גרסה פעילה" / "Publish an active version to go live" → button to `/:agent/builder`. (Edge guard — `activeVersionId` defaults to the first version on creation, so it's usually set; see Risks.)
- **Identity**: reuse `localStorage['builder:ownerUserId']` (generate-and-persist to that key if absent) → shared history with the builder.
- **Folder**: `aspect-react-client/src/live-chat/`. **CSS scope**: every selector prefixed `.lybi-chat`; the page root `<div className="lybi-chat" dir … data-theme … data-mode … data-client …>` carries all state. Wrapper `position:fixed; inset:0` (replaces mockup `body{overflow:hidden}` / `100dvh`). **Never put `transform`/`filter` on the wrapper** (drawer/scrim/modal/toast/popover are `position:fixed`). Inject the Assistant Google-Font `<link>` once via `useEffect`. Never touch `document.documentElement`.
- **Markdown**: reuse `MarkdownBody` inside bot bubbles; restyle via `.lybi-chat .bubble` descendant rules.
- **"Demo version" selector** (Noa): the agent is fixed by the URL, so this selector is **decoupled from real slugs** — kept as a labels-only UI placeholder for now (the user hasn't defined its behavior). White-label "client" selector only swaps logo/brand-name (data attribute), not the agent.
- **DEBUG mode** = the single "hidden" advanced surface (Noa's DEBUG + the user's extras). Toggle via settings popover **and** Ctrl+Shift+D. When on: topbar DEBUG pill; each Lybi message shows: **thinking process** (real, non-talker addon outputs), **report bug/task**, **delete**, **delete-from-here**; topbar shows **Open in builder**.

---

## RTL (point 3 — explicit)

The mockup already flips **bubble side** correctly (Lybi visual-left, customer visual-right in both dirs) via:
```
.msg.bot{align-self:flex-end;flex-direction:row-reverse}
.msg.user{align-self:flex-start;flex-direction:row}
[dir="ltr"] .msg.bot{align-self:flex-start;flex-direction:row}
[dir="ltr"] .msg.user{align-self:flex-end;flex-direction:row-reverse}
```
Because the avatar side is constant, the mockup's fixed bubble corners (`bot`→top-left sharp, `user`→top-right sharp) are correct for both dirs — **no corner flipping needed**.

What the mockup is **missing** and we must add (ported from V1):
1. **Per-message content direction.** Compute `dir` per message from its text using V1's `isRTL()` (Hebrew/Arabic/Syriac, first-letter rule). Apply `dir={msgDir}` + `style={{textAlign:'start'}}` on the bubble content element so a Hebrew message right-aligns and an English message left-aligns **regardless of UI language**. Add `unicode-bidi:plaintext` for mixed content.
2. **Markdown list/quote padding flip** inside bubbles: `.lybi-chat .bubble[dir="rtl"] ul, …ol{padding-right:1.4em;padding-left:0}` and blockquote border-side via logical props.
3. **Composer**: `dir="auto"` on the textarea (caret + alignment follow typed language); mirror the send-arrow in RTL (`.lybi-chat[dir="rtl"] .send-btn svg{transform:scaleX(-1)}`) — optional but matches V1.
4. **Sender/title + action row** (DEBUG buttons under bubbles) already follow flex direction; verify they sit on the avatar side in both dirs.

Reuse: copy V1's `isRTL` into `live-chat/textDir.ts` (or import `utils/textDirection.ts` and extend to Arabic). Verification includes a Hebrew message in EN UI and an English message in He UI.

---

## Files to create (`aspect-react-client/src/live-chat/`)

| File | Responsibility |
|---|---|
| `LiveChatPage.tsx` | Page root: scoped wrapper + `dir`/`data-*` attrs, font injection, composes everything; owns open/close UI state (drawer, popover, brain/profiler panels, report modal, toast); reads `:agent` + `?c=` |
| `liveChat.css` | Mockup CSS (lines 9–278) ported, every selector `.lybi-chat`-prefixed; `:root` vars → `.lybi-chat`, themes → `.lybi-chat[data-theme=…]`; **+ the RTL additions above** |
| `liveConfig.ts` | `DemoClient{ id, name:{he,en}, logoUrl? }` ×4 (lybi→`/img/lybi-logo-transparent.png`) + scenario **labels** only (placeholder, no slugs). Agent identity comes from the URL. |
| `components/AgentNotReady.tsx` | Centered empty state for the two states (no builder agent / no active version) with a CTA button to `/:agent/builder`; driven by `fetchProject` result (null → create, empty `activeVersionId` → publish) |
| `i18n.ts` | Port mockup `I18N` he/en dict + `t()`; add keys for toasts/modal/delete-confirm/errors |
| `useLiveSettings.ts` | `{ lang, theme, client, scenario, mode }` → `localStorage['lybi-live:settings']` |
| `identity.ts` | `getOwnerUserId()` → reads/writes `localStorage['builder:ownerUserId']` (shared with builder) |
| `textDir.ts` | Ported `isRTL(text)` (Hebrew/Arabic/Syriac) + `msgDir(text)` |
| `useLiveChat.ts` | Turn state machine: port `messagesToTurns` + `handleEvent` switch (minus crew/memory/builder), `instanceId→pluginId` map, per-turn `thinkRuns`; exposes `send`, `newChat`, `refresh`, `loadConversation`, `deleteTurn`, `deleteFromHere`, `convList`, `busy`, `error` |
| `components/TopBar.tsx` | Hamburger + logo/client-mark (inline-start); new-chat, refresh, profiler/brain toggles, settings (inline-end); DEBUG pill; **Open-in-builder** (DEBUG only). SVGs from mockup |
| `components/MessageStream.tsx` | Scroll container + auto-scroll (UserChat pattern) |
| `components/MessageBubble.tsx` | Avatar + bubble (`MarkdownBody` for bot); per-message `dir`; DEBUG `.msg-actions` row: think toggle, report, delete, delete-from-here |
| `components/ThinkingProcess.tsx` | Expandable `.think-body`; live `thinkRuns` or lazy `fetchRunsForMessage` (filter `pluginId!=='talker'`); plain-object `parsedOutput`→`key:value` `.tstep` rows, else `rawOutput` mono |
| `components/Composer.tsx` | Auto-grow textarea (`dir="auto"`, max 140px), Enter sends / Shift+Enter newline, attach (no-op), hint |
| `components/HistoryDrawer.tsx` | Scrim + drawer (inline-start), new-chat top, Today/Last 7 days/Older grouping, relative-time line |
| `components/SettingsPopover.tsx` | Lang/theme segments, client select, scenario select (→ navigate), normal/DEBUG segment |
| `components/SidePanel.tsx` | Generic collapsible panel; Brain (inline-end) + Profiler (inline-start) placeholders (card + ghost rows); <860px full overlay |
| `components/ReportModal.tsx` | Bug/task kind segment, quoted message ctx, title+desc → `createTask` |
| `components/Toast.tsx` | Bottom-center, 2.2s auto-hide |
| `components/ConfirmDelete.tsx` | Custom confirm modal for delete / delete-from-here (no browser `confirm()`) |
| `../pages/LiveChatPage.tsx` | Thin re-export (pages convention) |

## Files to modify

1. `aspect-react-client/src/App.tsx` — `const LiveChatPage = lazy(() => import('./pages/LiveChatPage'))`; `<Route path="/:agent/live" element={<Suspense…><LiveChatPage/></Suspense>} />`; if needed, explicit `<Route path="/lybi/live" …/>` placed with the other `/lybi/*` routes (above the splat). Not added to the eager pages barrel.
2. `aspect-react-client/src/builder/components/ChatPanel/UserChat.tsx` — on mount, read `?c=<convId>` from `location.search`; if numeric and present in `convList`, call `loadConversation(id)` (point 7, builder side). Add a small **"expand to live chat"** link in the builder chat header → `/${slug}/live?c=${conversationId}`.

**No server changes.** Agent-not-ready detection reuses `fetchProject` (existence + `activeVersionId`) — the same call the builder already uses.

## Reuse (exact imports)
- `builder/state/builderApi.ts`: `fetchProject` (agent-not-ready gate), `createConversation`, `fetchConversationMessages`, `fetchRunsForMessage`, `deleteMessage`, `listConversations` (+ types); optional `bootstrapProject` for inline create.
- `builder/state/runtimeStream.ts`: `sendRuntimeMessage`, `RuntimeEvent`.
- `builder/components/ChatPanel/MarkdownBody.tsx`: `MarkdownBody`.
- `services/taskService.ts`: `createTask`; `types/task.ts`: `CreateTaskData`; `utils/userIdentifier.ts`: `getUserId`.

## Data flow
- **On load**: resolve agent slug from URL → `fetchProject({agentSlug, ownerUserId})`. `null` → `AgentNotReady` (create); doc with empty `activeVersionId` → `AgentNotReady` (publish); else render the chat and `listConversations`.
- **Send**: lazy `createConversation({agentSlug, ownerUserId})` on first message → optimistic turn `{userText, assistantText:'', thinkRuns:[], runMap:{}}` → `sendRuntimeMessage({…, version:'active', onEvent})`.
- **Events**: `conversation`→ids; `addon.start`→`runMap[instanceId]=pluginId`; `addon.token`→append to bubble; `addon.output`→ if mapped plugin≠`talker` push to `thinkRuns`; `addon.error` `instanceId:null`→ error toast (handle "no version pointer" specially); `assistant.message`→final text+id; `done`→reload `convList`.
- **History**: `fetchConversationMessages`→turns (`thinkLoaded:false`); first think-expand on historical turn → `fetchRunsForMessage` → filter `!=='talker'`.
- **Delete** (DEBUG): `deleteTurn`→`deleteMessage` per id; `deleteFromHere`→`deleteMessage({fromHereDown:true})`; then refetch messages.
- **New chat**: clear state (row created on first send). **Refresh**: refetch current messages + list (no `location.reload`). **Scenario change**: navigate to new `/:agent/live`.

## Persistence
- `localStorage['lybi-live:settings']` = `{lang,theme,client,scenario,mode}` (defaults he/light/lybi/first/normal).
- `localStorage['builder:ownerUserId']` (shared with builder).

## Build order
1. CSS port + static page skeleton + settings/i18n/config → verify visuals, **RTL/LTR incl. per-message dir**, dark, mobile <860px.
2. `useLiveChat` + Composer + stream/bubbles → live streaming, `version:'active'`.
3. History drawer (grouping, load past conv, new chat, refresh) → confirm it matches builder history.
4. DEBUG: ThinkingProcess (live+historical), delete + delete-from-here (ConfirmDelete), ReportModal→`createTask`, Toast.
5. Cross-nav: Open-in-builder + builder `?c=` load + builder "expand to live" link.
6. Route wiring + polish/error states (no-active-version toast).

## Verification
1. `cd aspect-agent-server && npm start` (3000) + `cd aspect-react-client && npm run dev`.
2. `http://localhost:5173/lybi/live` renders the chat (not LybiLandingPage).
2b. **Empty states**: visit `/:agent/live` for a slug with no builder agent → "create in builder" CTA; for an agent with no active version → "publish active" CTA; both link to `/:agent/builder`.
3. Send on a real builder slug with an **active** version: gradient user bubble visual-right, tokens stream into bot bubble visual-left, markdown renders.
4. **RTL**: He UI (Lybi left/user right), then send an English message (left-aligned inside bubble); switch to En UI, send a Hebrew message (right-aligned inside bubble); lists/quotes pad correctly; composer caret follows typed language.
5. **Point 5**: with the chat open, change & publish the agent's **active** version in the builder (other tab) → next customer turn uses it.
6. **Point 6**: the conversation appears in the builder's User Chat history (same owner id + slug).
7. **Point 4**: DEBUG on → delete a turn; delete-from-here; thinking process (live + after reload from history).
8. **Point 7**: Open-in-builder from chat lands on `/:agent/builder?c=<id>` with that conversation loaded; builder "expand to live" returns to `/:agent/live?c=<id>`.
9. Report bug → task appears in the tasks system (type bug, domain lybi).
10. Dark mode, client logo swap, <860px overlay panels; `/lybi`, `/demo`, `/:agent/builder` unaffected.

## Risks / notes
- Agent identity = URL slug; no slug config to maintain. Missing agent / missing active version are **first-class empty states** with a CTA to the builder (§Decisions), not errors — detected via the builder's own `fetchProject` gate (no new server code).
- `fetchProject` 404 distinguishes "not built yet" correctly (it hits the **builder project**, not the runtime `agents` table which auto-creates rows on first conversation).
- `activeVersionId` defaults to the first version when an agent is created, so the "no active version" state rarely fires. The genuinely common case is subtler — the active (live) version lagging behind the edited (viewing) draft, i.e. "promote your latest edits to active." Treat that as a **future nicety**, not in this scope.
- Runtime endpoints have no auth (same exposure as builder) — acceptable for this surface; flag for a hardened customer runtime later.
- DEBUG mode here **extends** Noa's spec (adds delete + open-in-builder beyond her thinking+report) — intentional per the user; everything else stays clean/customer-facing.
- Builder deep-link is a single-file `UserChat` change; keep it minimal and guarded (only act when `?c=` is numeric and in `convList`).
- Brain/Profiler panels are placeholders by design ("to be specified later" in Noa's spec).
