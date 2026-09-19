# Builder MCP — maintaining the AI front door

> **Who this is for:** any session (or human) that changed Builder V2 and
> needs outside AI assistants to know about it — or that found an
> assistant getting something wrong through `lybi.ai/builder/mcp`.
>
> **When:** after the feature is approved, in the same session as the
> Alfred update (`ALFRED_UPDATE_PROTOCOL.md`). The two overlap a lot —
> this door serves Alfred's own knowledge — but not completely, and the
> gaps are listed below.
>
> **Why this exists:** the door is the one place where an AI we did not
> build, with no memory of us, has to learn the whole platform from a
> single URL. Anything it cannot read, it guesses. Anything it guesses in
> an agent body saves cleanly and then silently does nothing at runtime.

---

## 1. What it is, in one minute

A person pastes **`https://lybi.ai/builder/mcp`** into any AI chat (Claude,
ChatGPT, Codex, Claude Code) and says "help me build an agent". The page
teaches the assistant the platform in prose and hands it URLs for
everything else. Reads are plain GETs; changes are one POST.

**It is not an MCP server.** MCP is a protocol and a chat handed a URL
does not speak it — it fetches. The path is called `mcp` because that is
the word people reach for. A real MCP adapter could wrap these same
handlers later; it would add reach, not capability.

**Everything lives in one file:** `builder/routes/mcpRoute.js`, mounted in
`server.js` at `/builder/mcp` — deliberately outside `/api`, because
people type and paste this URL.

| Route | What it gives | Backed by |
|---|---|---|
| `GET /` | The entry page — the whole teaching, as prose | `entryDoc()` in the route file |
| `GET /agents` | Every agent, names + slugs | `alfredTools.listAgents` |
| `GET /agents/:slug` | Full project JSON — body, crews, versions. The thing that gets edited | `builderProjects.hydrateProject` |
| `GET /agents/:slug/conversations` | Recent chats | `alfredTools.listConversations` |
| `GET /agents/:slug/log` | Change history and reasons | `alfredTools.changeLogText` |
| `GET /conversations/:id` | Transcript + per-turn addon digest | `alfredTools.readConversation` |
| `GET /runs/:id` | One addon run in full — assembled prompt, raw/parsed output | `alfredTools.readRun` |
| `GET /addons` | **Every addon descriptor, in one page** | reads `builder/addons/*.addon.json` |
| `GET /code/<path>` | Any allowlisted source file; directories list | `alfredTools.readPlatformFile` |
| `POST /agents` | Create an agent (name is enough) | `builderProjects.createProject` |
| `POST /agents/:slug` | Save an edited agent body | `saveAgentVersionAs` + `setAgentActive` |
| `POST /agents/:slug/crews/:crewId` | Save an edited crew body | `saveCrewVersionAs` + `setCrewActive` |

**What it deliberately does NOT have:**

- **No auth.** Pre-launch platform; decided, not an oversight.
- **No body validator.** `alfred/services/bodyValidator.js` is a
  hand-maintained mirror of the real spec. Gating writes on it would make
  the newest platform capability the one thing this door rejects. Safety
  comes from versioning instead (§4).
- **No publish.** Nothing here can reach a customer.

---

## 2. The free tier — reaches the door with no work

The door reads live files and wraps existing readers, so a lot arrives on
its own. **Restart the server** after any of these.

| You changed… | Reaches the door via… |
|---|---|
| Added / edited an addon (`builder/addons/*.addon.json`) | `/addons` and `/code/builder/addons/` — both read the directory |
| Plugin, runtime, trigger code | `/code/builder/...` |
| `builder/types/index.ts` | `/code/builder/types/index.ts` — the entry page tells the assistant to read it for shapes |
| `builder/promptPlaceholders.json` | `/code/builder/promptPlaceholders.json` |
| Alfred's brief (`alfredContext.js`) | `/code/alfred/services/alfredContext.js` — the entry page calls it "the fullest written description of the builder" |
| A guide under `docs/guides/` or `docs/features/` | `/code/docs/...` |
| An improvement to an `alfredTools` reader | The matching route, since it calls the same function |

**Consequence:** the best place to teach most things is still where
§2 of the Alfred protocol says — the types file's doc-comments, the addon
descriptor's `purpose`, Alfred's brief. Do that and both Alfred and the
door learn it at once.

---

## 3. The checklist — what to update when

### 3.1 You added a top-level section to AgentBody

- [ ] **`normalizeAgentBody()` in `mcpRoute.js` — decide whether it needs
      a default.** Open the client's `bodyOfAgent` in
      `aspect-react-client/src/builder/state/BuilderContext.tsx`:
  - The key is emitted **unconditionally** (`domains: agent.domains ?? []`)
    → **add it** to `normalizeAgentBody` with the same empty default.
  - The key is behind the **empty == absent** trick
    (`...(x?.length ? { x } : {})`) → **do NOT add it.**

  Getting this wrong in either direction produces the same symptom: an
  agent written through the door opens in the Builder with
  *"Agent has unsaved changes"* before anyone has touched it.
- [ ] Update the `bodyOfAgent` replica in `scripts/test-builder-mcp.js` to
      match the client, or the battery will test the wrong thing.
- [ ] If the section has a trap an assistant will fall into, add a line to
      **"Things that are easy to get wrong"** in `entryDoc()`.

(The Alfred protocol's §3.1 covers the other places a new section must
go — `hydrateProject`, both client `bodyOfAgent` copies, the patch
generator. Those are prerequisites: if `hydrateProject` does not map the
key, the door cannot show it either.)

### 3.2 You added a key to CrewBody

- [ ] `normalizeCrewBody()` mirrors the client's `bodyOfCrew`, which
      currently emits every key unconditionally — add the new one with its
      empty default unless `bodyOfCrew` makes it conditional.
- [ ] Update `bodyOfCrew` in the test replica.

### 3.3 Assistants need to SEE something new
(a new run type, KB files, trigger history, a new panel's output…)

- [ ] **Write the reader in `alfred/services/alfredTools.js`, not in the
      route.** Then Alfred gets it too, and there is one lens instead of
      two drifting ones. Return prose/markdown shaped for a model — look at
      `readConversation` and `readRun` for the pattern (digest first, a
      pointer to the full view second).
- [ ] Add a `GET` route in `mcpRoute.js` that calls it, with the same
      try/catch → `500` + readable message shape as its neighbours.
- [ ] Add a row to the **Reading** table in `entryDoc()`. An endpoint the
      entry page does not mention does not exist, as far as an assistant
      is concerned.
- [ ] Wire it into Alfred as well (`alfredRunner.js` → `TOOLS` +
      `runTool`), per the Alfred protocol §3.5.

### 3.4 Assistants need to DO something new
(delete a crew, reorder crews, duplicate an agent, attach a KB…)

- [ ] Add a `POST` route in `mcpRoute.js`. It must keep every invariant in
      §4 — above all, **nothing here may move `publishedVersionId`**.
- [ ] Body edits go through `saveAsNewVersion()` — never a bare service
      call — so they get normalised, versioned and activated the same way
      as every other write.
- [ ] Unknown ids answer `404` **with a sentence that tells the assistant
      what to do next** (the crew route lists the crews that do exist).
      An assistant that gets a bare 404 guesses.
- [ ] Add it to **Changing an agent** in `entryDoc()`, including whether
      to ask the person first. Anything not undone by switching a version
      (creating, deleting) → "ask before doing this".
- [ ] If it is a deletion or anything irreversible, stop and check with
      Shlomi before building it. Every current write is undoable; that is
      a property worth protecting.
- [ ] Add a test to the battery that proves the change is visible in the
      working copy (§6), not just that the call returned 200.

### 3.5 An assistant keeps getting something wrong

Fix the knowledge where it is cheapest and reaches most readers, in this
order:

1. The **source** it reads — a doc-comment in `builder/types/index.ts`, the
   addon's `purpose`, the relevant section of Alfred's brief. Fixes Alfred
   and the door together.
2. **"Things that are easy to get wrong"** in `entryDoc()` — for traps
   specific to working from outside (JSON spellings vs screen names, where
   crews live, what not to delete).
3. **A composed page** (§3.6), if the mistake comes from the assistant not
   fetching enough.

Test the fix by pasting the URL into a real chat and asking the question
that went wrong.

### 3.6 Something is always needed together

**Rule: bundle what is always fetched together and rarely changes; keep
separate what is fetched occasionally and specifically.**

`/addons` exists because answering "what addons exist and how is each
configured" took a directory listing plus one fetch per addon — eight
round trips — and a web chat gave up partway and asked the person to
paste the files by hand. If you see an assistant making the same run of
fetches every session, that run is a candidate for one page. Add the
route, then point the relevant row of the entry page at it.

Do not bundle the long tail — one plugin's runtime, one guide, one
transcript. That only wastes the reader's context.

### 3.7 You want assistants to read more of the source

- [ ] `READABLE_PREFIXES` in `alfred/services/alfredTools.js` is **the
      single allowlist** for both Alfred and this door. Changing it
      changes both.
- [ ] Never add `services/`, `hq/`, anything holding credentials, or
      another product's folder. `.env` is not under any current prefix;
      keep it that way.

### 3.8 You changed a service the door wraps

`hydrateProject`, `createProject`, `saveAgentVersionAs`,
`saveCrewVersionAs`, `setAgentActive`, `setCrewActive`, or any
`alfredTools` reader.

- [ ] Run the battery (§6). The write tests exist precisely because these
      functions have non-obvious behaviour — see §4, "writes move active".

### 3.9 The URL or domain changes

- [ ] `lybi.ai/builder/mcp` is a **302 redirect** in
      `aspect-react-client/firebase.json`, not a proxy. lybi.ai is the
      `lybi-prod` Firebase project and the server is Cloud Run in
      `aspect-agents`; Firebase can only rewrite to a Cloud Run service in
      its own project. A real same-domain URL needs either a Cloud Run
      domain mapping (e.g. `mcp.lybi.ai`) or the server deployed into
      `lybi-prod`.
- [ ] `MCP_URL` in
      `aspect-react-client/src/builder/components/FolderDrafts/aiSetupContent.ts`
      is what the Builder's AI dialog shows and copies.
- [ ] Nothing in `mcpRoute.js` needs changing: every URL on the entry page
      is built from the request by `urls(req)`, which honours
      `X-Forwarded-Proto` / `X-Forwarded-Host`.

---

## 4. Invariants — do not break these

| Invariant | Why |
|---|---|
| **Never move `publishedVersionId`.** | It is the customer gate. Everything else here is undoable; that is not. |
| **A write = new version + `setXActive`.** Never `saveAgentVersion` (in place). | `hydrateProject` builds the working copy from **active** and reports `viewingVersionId` *as* active on load. `saveAgentVersionAs` alone moves only viewing — the version exists but the Builder never shows it. This was a real bug, caught only by testing the working copy. |
| **Normalise every body** (`normalizeAgentBody` / `normalizeCrewBody`), adding absent keys only. | Otherwise the Builder shows phantom "unsaved changes" (§3.1). |
| **No validator on writes.** | See §1. Versioning is the safety. |
| **Text goes out as `text/plain`.** JSON only for `GET /agents/:slug`. | Chat reader tools refuse `text/markdown` outright. ChatGPT reached the page and then declined to show it. The content is still Markdown. |
| **Every URL on the entry page comes from `urls(req)`.** Never hardcode a host. | The same page is served on the Cloud Run host, through the lybi.ai redirect, and on localhost. |
| **One allowlist** — `alfredTools.READABLE_PREFIXES`. | Two lists drift. |
| **Errors are sentences that say what to do next.** | An assistant that gets a bare status code guesses. |
| **`entryDoc()` is a template literal.** Escape every backtick as `` \` ``; interpolate only `base` and `origin`. | An unescaped backtick ends the string and the module fails to load — the whole door goes down, not just the page. |

---

## 5. Keeping the sibling surfaces in step

There are three ways an outside assistant learns the platform, and they
share facts without sharing files:

| Surface | Audience | File |
|---|---|---|
| **This door** | Any chat, no setup | `builder/routes/mcpRoute.js` → `entryDoc()` |
| **The AI folder** | Claude Code / Codex on the person's machine, via the Builder wizard | `docs/guides/AGENT_BUILDING_INSTRUCTIONS.md` (written into the folder as `CLAUDE.md` / `AGENTS.md`) + `builder/routes/aiBundleRoute.js` (the code bundle and its fingerprint) |
| **Alfred** | Inside the Builder | `alfred/services/alfredContext.js` et al. |

When a fact about **how to work** changes (field types, where crews live,
what not to delete, the draft-vs-server choice), it usually needs saying
in both `entryDoc()` and `AGENT_BUILDING_INSTRUCTIONS.md`. They are
separate on purpose — one is read cold from a URL, the other sits beside a
draft file — so keep them consistent rather than merging them.

| When you change… | Also check… |
|---|---|
| The entry page's rules | `AGENT_BUILDING_INSTRUCTIONS.md` says the same thing |
| What files a folder user should have | `MANIFEST` in `aiBundleRoute.js`. Any change to a file in it changes the fingerprint and marks every folder copy stale — expected, but it happens on every deploy that touches `builder/` or `alfred/services/` |
| What the Builder's AI dialog says about this door | `MCP_NOTE` / `MCP_URL` in `aiSetupContent.ts` |
| The person-facing explanation | `docs/guides/WORK_WITH_CLAUDE_CODE.md` |
| The Claude Code skill | `.claude/skills/build-agent/SKILL.md` only points at the instructions file — keep it that way |

---

## 6. Verify

### The battery

```bash
cd aspect-agent-server
node scripts/test-builder-mcp.js
```

Exits `1` on any failure. What it covers:

- **Surface** — entry page status and content type, `text/plain`,
  URLs built from forwarded headers, `/addons` completeness, the `/code`
  allowlist refusing `services/` and `..` traversal.
- **Reads** — list, one agent, conversations, log, unknown-slug `404`.
- **Writes, on Claude's own test agent `zz-mcp-test`** (created if absent,
  kept afterwards) — a new version exists; **active moved**; published did
  not; the **working copy shows the edit**; the previous version is
  intact; same for a crew.
- **The phantom-dirty invariant** — replicates the client's
  `bodyOfAgent` / `bodyOfCrew` and asserts the Builder would show *no*
  unsaved changes: after a write, and on an agent created through
  `POST /agents` (that one is deleted afterwards).
- **Refusals** — malformed body `400`, unknown crew `404` with the real
  crew list.

It writes to the platform database (`.env`). It never touches an agent
other than `zz-mcp-test` and the throwaway `zz-mcp-born-clean`.

**The replicas in the script mirror client code.** If `bodyOfAgent` or
`bodyOfCrew` changes, update them, or the invariant test goes quietly
wrong.

### After deploying

```bash
B=https://lybi.ai/builder/mcp
curl -sI  $B                            # 302 → the Cloud Run URL
curl -sL  $B | head -5                  # "# Lybi — building agents"
curl -sL -o /dev/null -w '%{content_type}\n' $B      # text/plain
curl -sL  $B/addons | grep -c '## builder/addons/'   # = number of addons
```

### In a real chat

Paste the URL into ChatGPT and into Claude and ask for something that
exercises your change. This is the only test of whether the prose
actually teaches it — an endpoint can pass every check and still be one
the assistant never thinks to use.

---

## 7. Deploying

- **Server deploy** ships the door itself.
- **Client deploy** (`deploy:lybi-prod`) ships the lybi.ai redirect and the
  AI dialog's link card.
- Neither is ever done without Shlomi saying so.

---

## 8. Incident gallery — why each rule exists

| What happened | Root cause | Rule |
|---|---|---|
| A write returned 200 but the Builder showed the old agent | `saveAgentVersionAs` moves viewing; `hydrateProject` reports viewing as active | §4 writes move active |
| First agent built through the door opened with "unsaved changes" | Created without `cortex`, `domains`, `enums`, `parameters`, `snippets`; the client always emits them as `[]` | §3.1, §4 normalise |
| ChatGPT reached the page but would not display it | Served as `text/markdown` | §4 text/plain |
| A web chat gave up and asked the person to paste the addon folder | Eight fetches to answer one routine question | §3.6 `/addons` |
| The assistant refused to guess addon config keys and stalled | Right instinct, no single page to read them from | §3.6 |
| Codex on Windows concluded the server was down | Folder instructions used `curl -s`; in PowerShell `curl` is `Invoke-WebRequest` and `-s` swallows the URL | §5 — the instructions file now lists endpoints, no shell syntax |
| Folder copy flagged stale "with no deploy" | Another session deployed at 17:24 | §5 fingerprint note |
| Page links would have been `http://…` behind a proxy | `trust proxy` is not set app-wide | §4 `urls(req)` |

---

## 9. Known gaps

- **Folder + door in one session drift apart.** If an assistant edits the
  folder draft *and* posts to the server, the browser holds the old copy
  and the next Builder edit writes it back into the folder. Proposed: the
  entry page should say "pick one route per session"; a post made while a
  folder exists should also rewrite the draft file; the Builder should
  notice when the server's active version changes under it.
- **Plain web chats probably cannot POST.** Their browsing tools fetch;
  reading works everywhere, submitting likely needs Claude Code, Codex, a
  connector or a Custom GPT action.
- **No real MCP adapter.** Would let Claude.ai connectors attach natively.
- **The lybi.ai URL is a redirect**, not a same-domain page (§3.9).
- **`aiBundleRoute.collectDir` does not pass `exclude` into its recursive
  call.** Harmless today — the only `exclude` is on a non-recursive entry.

---

## 10. File map

```
aspect-agent-server/
  builder/routes/mcpRoute.js          THE DOOR — entryDoc, reads, /code, /addons, writes,
                                      normalizeAgentBody / normalizeCrewBody, urls(), sendText()
  server.js                           app.use('/builder/mcp', …)
  alfred/services/alfredTools.js      the readers it wraps + READABLE_PREFIXES (shared allowlist)
  builder/services/builderProjects.js hydrateProject · createProject · save*VersionAs · set*Active
  builder/routes/aiBundleRoute.js     folder route: code bundle + fingerprint (sibling)
  docs/guides/AGENT_BUILDING_INSTRUCTIONS.md   folder route's instructions (sibling)
  docs/guides/WORK_WITH_CLAUDE_CODE.md         person-facing guide
  scripts/test-builder-mcp.js         the battery

aspect-react-client/
  firebase.json                                       lybi.ai/builder/mcp → 302
  src/builder/components/FolderDrafts/aiSetupContent.ts   MCP_URL · MCP_NOTE
  src/builder/components/FolderDrafts/FolderDraftsModal.tsx  the link card
  src/builder/state/BuilderContext.tsx                bodyOfAgent / bodyOfCrew — what "unsaved" means
```
