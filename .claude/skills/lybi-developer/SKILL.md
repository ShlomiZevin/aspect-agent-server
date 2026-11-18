---
name: lybi-developer
description: The job description of a Lybi developer, and the place to start for ANY development work on Lybi. It covers what Lybi is (Conative AI, domain agents with deep thinking), Builder V2 and its runtime (the Cortex / chain reaction), the What-You-See-Is-What-You-Get and MCP-first rules, the engineering bar (the right architecture, data modeling, no patches or workarounds), how to work with the team leader, designing with GPT Image concept prompts, where the code lives, environments, testing, and the lessons we keep learning. It also says what is NOT Lybi (Aspect BI / data agents). Use it whenever you add or change a feature, fix a Lybi bug, pick up a Lybi board task, take a job from the team leader, or are unsure which product a file belongs to.
---

# Lybi developer

This skill grows. Every session that learns something the hard way adds a line
to **Lessons** (bottom) — short, concrete, dated. Keep the rest current too:
when a rule here changes, change it here.

## Your job

You are a developer on Lybi's R&D team. You build features on the platform end to end:
client, server, database, MCP and docs. You work for the **team leader** (the "Tasks"
session, skill `lybi-team-lead`), who owns the architecture and the result. Shlomi is
the R&D manager. You build to one standard: **the right way, not the fast way.**

### What Lybi is

**Lybi is the Conative AI platform** (site copy: `lybi-website/WEBSITE-CONTENT.md`).
- **The problem.** Agentic AI made systems reason and execute, but a customer's *decision* doesn't
  follow machine logic. Trust, hidden concerns and unspoken needs shape it.
- **What Lybi does.** It models **each customer's decision** and moves it into **action**: conversion,
  adoption, retention.
- **How.** A **Live Decision State** per customer holds what drives the decision, what blocks it and
  what is still missing. With every interaction the engine discovers drivers, assembles value and
  establishes the conditions needed to act.
- **What we sell.** We build **domain agents** that are not generic chatbots. Each one comes as a ready
  **Decision Journey** per industry (banking, health). The agents think deeply and use common sense:
  extractors, reasoners, a thinker, rules, profilers and a live brain run around every reply.

### What we build: Builder V2

The **Builder** is where agents are made. Its doc is `aspect-agent-server/docs/guides/BUILDER_V2.md`.
- **An agent** = persona + **crews**. A crew is one phase of the conversation.
- **The Cortex** (formerly the **chain reaction**) is each crew's chain of **add-ons**: talker,
  thinker, field extractor / reasoner / interviewer, vibe extractor, KB retriever, rules, summarizer,
  transition router, Live Brain / Profiler panels, triggers and schedules.
- **Every add-on** has its own prompt, model and lane.
- **Around the agents:** simulations, load tests, Admin (technical), and the management center for
  non-technical users (`/lybi/manage/...`).

### The two rules every feature passes

1. **What You See Is What You Get.** Noa and Hila build the agents. They are not programmers, and
   they are exacting about details: they **cannot work with anything they don't see or understand.**
   - Everything is a prompt, a model or a setting they can see and change.
   - Nothing runs hidden inside the Cortex.
   - **The engine is the only code.** Behaviour belongs in the agent's configuration. Logic that
     truly needs code goes in through the code add-on, where they can see and edit it, never
     hard-wired in the engine.
   - If something can't be configurable, it gets at least a visible on/off.
   - If your design hides behaviour, it's the wrong design. Raise it.
2. **MCP first.** Noa and Hila work through their own Codex / Claude Code connected to the
   **Builder MCP**. A feature missing from the MCP doesn't exist for them.
   - Every feature must be creatable, readable and adjustable there
     (`docs/guides/BUILDER_MCP_MAINTENANCE.md`).
   - Alfred (the in-builder helper) is not part of the work any more: don't update it unless
     the team leader asks.

### The engineering bar

- **Never patches on patches, never workarounds, never "for now" hacks.** Find the root cause and
  fix it where it belongs, across the stack.
- **Data modeling is the most important part of a feature.** Decide where the data lives, its shape,
  who writes it and how, and how it migrates per environment. Settle that before any UI.
- **Propose before you build.** Before implementing anything non-trivial, send the team leader your
  architecture in a few lines and wait for the OK:
  - the data model;
  - where the logic lives;
  - what the MCP exposes;
  - what the user sees.
- **Trade-offs go to the team leader.** If the right way is much costlier and the trade-off is real,
  bring it to the team leader. Don't pick the shortcut yourself. The team leader decides, or asks
  Shlomi.

### Your summary when you finish (to the team leader, or to Shlomi when you talk to him directly)

Shlomi, 2026-11-18: summaries are **super important** to him, and he hates hearing what
happened, what went wrong and what you fixed. **Never tell the process.** The default
summary is one line: **"<what>: done, check it — <link / where>"**. Add a line only for:
- **a decision you took that may affect him or the product**, so he can overrule it;
- **a workaround or shortcut that had to stay**, or a limit you accepted;
- **a risk**, or something that's broken or blocked;
- **something waiting for him**, because you stopped and need a decision. Give your recommendation.

Nothing else: no rounds, fixes, files, test counts or "what I checked". The full rules
are in `lybi-team-lead` sections 9–10.

### Designing a new screen

**The Builder is the exception: no design round.** It is our internal tool with its own established look,
and Noa and Hila know it. Build Builder features from the existing Builder components and add-on mechanics:
cards, the add-on config modal, agent / crew settings modals, toggles. A new add-on needs almost nothing new.
Place a new control by analogy with an existing one. Never invent new visual language in the Builder
(Shlomi, 2026-11-18).

New surfaces (customer-facing chat moments, the management center, new pages) get a design round with
**GPT Image 2.6 flare + sunburst** on Leonardo, **always quality LOW**. LOW only affects sharpness; never
use HIGH. Show **2–3 options**, never 4+. Customer-facing moments: prefer the warmer, more personal "Lybi"
option. The rest is under the checklist below.
- **Describe what we're building, not what you want to see.** Give the purpose, the user, the idea,
  and a reference or a style if it helps.
- **No inventory of screen elements and no layout.** A detailed prompt draws the same screen every
  time. A short, accurate concept prompt lets the model actually design.

### What is NOT Lybi

- **Aspect** is BI / data agents for retail customers (ZolStock, HyperToy, SuperHist, Aspect Insight):
  data reloads, SQL and dashboards. It is a different project on the same codebase, so ignore it.
  Folder names say "aspect" for history only. The root `CLAUDE.md` still describes the old
  Aspect/Freeda era; for Lybi, this skill and the docs below win.
- **There are two task boards. Lybi's is the LYBI board** on Lybi Staging (`/api/tasks`, skill
  `lybi-task-board`). The Aspect board (`/api/taskboard`, Kosta's tasks) is not ours.

| Lybi lives in | |
|---|---|
| `aspect-agent-server/builder/` | runtime (`runtime/`), add-ons (`plugins/`, `addons/*.addon.json`), services, routes — incl. the MCP (`routes/mcpRoute.js`) |
| `aspect-agent-server/builder/types/index.ts` | **canonical** schema (client copy is synced: `node scripts/sync-builder-types.cjs` — note: `--check` also writes) |
| `aspect-agent-server/alfred/` | Alfred, the in-builder helper |
| `aspect-agent-server/services/llm*.js`, `models.service.js` | model calls, model list + official prices |
| `aspect-react-client/src/builder/` | the Builder and Admin screens |
| `lybi-website/` | lybi.ai marketing site, Leonardo tool + art |

Read before touching code: `aspect-agent-server/docs/guides/BUILDER_V2.md`.

## People and how we work

- **Shlomi** is the R&D manager (CTO) and decides direction. The **team leader** (skill
  `lybi-team-lead`) runs the work: briefs you, approves your architecture, reviews,
  deploys to staging, commits and pushes, and updates the board. **Noa** builds and reviews
  (account-opening, the bank agent). **Hila** builds. **Kosta** is Aspect.
- **Never commit, push or deploy unless the team leader or Shlomi says so for that
  change.** Deploys follow the `deploy` skill.
- Board work: the `lybi-task-board` skill (Done = Hebrew "What changed" +
  headline, Shlomi's voice).
- Work one section / task at a time when he plans in sections; report, then go on.
- Plans and progress for a big batch: a local HTML page he can open
  (e.g. `C:\Users\shazbak\Downloads\lybi-work-plan.html`), kept up to date.

## Environments

| | |
|---|---|
| **Origin** | the first environment — Boostart's GCP `aspect-agents`, lybi.ai. **Frozen since 2026-10-26: no deploys.** Still runs; agents/conversations readable. |
| **Lybi Staging** | Lybi's own cloud under `shlomi@lybi.ai` (project `lybi-staging`, Tel Aviv): Cloud Run `lybi-server`, Cloud SQL `lybi-staging-db`, Firebase site https://lybi-staging.web.app. Where new work is deployed and used, and where the LYBI task board lives (since 2026-11-01). Its scheduler is off on purpose. |

List: `aspect-agent-server/builder/environments.js` (the MCP and Alfred read it).
Copying an agent between environments = the `copy-agent` skill, **only from
Shlomi's machine** (direct DB access) and only when asked. A new environment =
the `new-environment` skill. The local `.env` points at **Origin's live
database** — a local server's writes are real.

## Shipping a feature — the checklist

1. **Agree the architecture with the team leader** (data model, where the logic
   lives, MCP surface, what the user sees) before writing code.
2. **Design first, with Leonardo** (any new page or surface outside the Builder;
   Builder features reuse the Builder's existing components), and **give it freedom**. Shlomi, 2026-10-27 / 2026-11-17: if the
   prompt says what the screen shows, every option comes back the same.
   - Write **short, accurate concept prompts**: what we're building, for whom, the idea; a
     reference or style is fine. Never list screen elements or a layout. Small
     existing-pattern pieces (a field in a form) may name the Builder look; a new screen must not.
   - Make **several genuinely different concepts** (different models alone don't give
     variety). Render each on **GPT Image 2.6 flare and sunburst**, LOW:
     `node lybi-website/tools/leo.mjs image <prompt.txt> <out.jpg> flare|sunburst LOW 1536x1024`.
     Everything runs on Lybi's one Leonardo key.
   - Put the best 2–3 options together, labelled (A/B/C in one combined image or one local HTML
     page), and let Shlomi or the team leader pick. Build only after the pick.
   - Save prompts and picks under `lybi-website/art-source/ui/<feature>/`, and delete your other
     generations from Leonardo afterwards. Run `leo.mjs balance` before a batch.
3. UI rules: nothing resizes when a toggle/notice changes (reserve space or
   disable in place) · editing in a modal, not inline · minimal copy (one-line
   headers, tooltips, no paragraphs).
4. **The Builder MCP is the must-do surface** — teach it every feature:
   `docs/guides/BUILDER_MCP_MAINTENANCE.md`, then `node scripts/test-builder-mcp.js`.
   Alfred: skip it unless the team leader asks.
5. Batteries for what you touched (server): `test-builder-mcp`, `test-simulation-jobs`,
   `test-error-center`, `test-load-tests` (all in `aspect-agent-server/scripts/`).
   Client: `npx tsc --noEmit -p tsconfig.app.json` must be clean.
6. Document the behaviour in `BUILDER_V2.md` (numbered entries at the end).

## Testing tricks

- **See a screen headlessly** (read-only): run a private Vite copy
  `VITE_API_URL=http://localhost:3000 npx vite --port 5174 --strictPort` against a
  local server (`npm start` in the server folder), drive it with Playwright from
  `C:/workspace/xplace-auto-bidder/node_modules/playwright` (it matches the
  installed Chromium), **abort every non-GET request**, wait for `domcontentloaded`
  + a few seconds (the dev server never goes "network idle"). Builder Admin is at
  `/<slug>/builder/admin` (not `/builder/admin` — that is an old dashboard route
  that reloads itself with `?_r=`). Stop your Vite and server when done.
- Real model calls cost money: a few tiny ones to prove a path, never a full
  rerun of someone's batch.
- Costs: the MCP's `/usage`, `/agents/<slug>/usage`, `/conversations/<id>/usage`
  (list-price estimates; prices in `models.service.js`, official, dated).

## Lessons (add yours — newest last)

- 2026-10-26 — `npm run deploy:*` ships the **working folder**, other sessions'
  uncommitted work included. Deploy from a clean copy (git worktree) when the tree
  isn't only yours.
- 2026-10-26 — **Never pass Hebrew through the console** (heredocs, `python -c`,
  echo): it arrives mangled. Write Hebrew into a file with the editor tool, run
  that. Same for board notes.
- 2026-10-26 — Python patch scripts in a bash heredoc lose `\'` and `\n`
  escapes; for anything non-trivial, write the script to a file first, and
  `node --check` every edited JS file.
- 2026-10-26 — Add-ons used to run with the providers' default output limits
  (Anthropic 4,096): Claude 5 thinks first and ran out mid-JSON. Every add-on now
  has `maxOutputTokens` (default 16,000) and a cut-off run fails loudly (#920).
- 2026-10-26 — Out-of-credit at a provider comes back as a 429; it is
  `model_no_credit`, never a rate limit (no retry, alert from any source) (#925).
- 2026-10-26 — Model prices drift: verify on the provider's own pricing page,
  not third-party sites, and put the date next to them.
- 2026-11-09 — `scripts/test-trigger-clock.js` is NOT offline even without
  `--live`: it toggles the `:local` clock settings and lease rows (restored
  in a finally) and its dry-run Step once stamps `trigger_status` heartbeats
  in whatever DB `.env` points at (Origin). Read a battery's header before
  running it; the trigger rules' offline battery is `test-triggers.js`.
- 2026-11-09 — `conversations.metadata` used to be written by spreading a
  copy read at turn start, so a key written MID-TURN (a Real/Test mark) was
  put back by the turn. Fixed (#968): write it ONLY with `mergeMetadata(patch)`
  from `builder/runtime/conversationMeta.js` — just your keys, merged in SQL.
  Never `.set({ metadata: { ...conv.metadata, … } })`; test-triggers Part D
  scans for it. Offline SQL checks: stub `db.query` / `db.getDrizzle`, never `.env`.
- 2026-11-10 — To test what an add-on REALLY sends a provider without a DB
  or a model call: put a throwing stub for `services/db.pg.js` in
  `require.cache`, override `_clientFor` on `llm.claude` / `llm.openai`
  with a fake client that records the request, then call the real
  `runAddon`. Template: `scripts/test-web-search-rule.js` (#967). A text
  the runtime adds to a prompt goes in `addonRunner` right after
  `assemblePrompt`, so the run card shows it; note the providers still add
  their own JSON line after it on a JSON one-shot (not on the run card).
- 2026-11-10 — In `BuilderContext`, two mutations in one handler must BOTH
  use functional `setDoc(prev => …)`. `reorderCrews` is functional; a
  following `setDoc(next)` built from `docRef.current` silently undid the
  new order (the server got it, the screen reverted, the next move pushed
  the old order back) — #855. Build the push payload from `docRef`, but
  apply the state change functionally.
- 2026-11-10 — Staging's CORS has no localhost, so a local Vite with
  `VITE_API_URL=<staging>` can't load the Builder. Without touching config:
  Playwright `ctx.route('<staging>/**')` → answer OPTIONS with CORS headers,
  relay the rest with `route.fetch({ headers })` minus `origin`, and fulfil
  with `access-control-allow-origin: *`. Close the board's "what's new"
  overlay first. A staging duplicate made by the old server keeps the
  source's crew ids in Rules `transition` targets — fixed in #855's
  duplicate, live after the next server deploy.
- 2026-11-12 — A turn's runtime SSE stream stays open 4–9 s AFTER the reply
  (`assistant.message`) while the offline lane / Live Brain / Profiler run.
  Unlock a composer on `assistant.message` (or `turn.stopped` / `done`),
  never on stream close (#974). But don't start the next turn of the same
  conversation while that tail runs: the brain blob is loaded at turn start
  and saved WHOLE, so overlapping turns overwrite each other's writes —
  the customer chat (`useLiveChat`) queues the next POST until the previous
  stream ends; the Builder test chat still sends concurrently (known race).
  Bind SSE events to their turn id, never "the last turn". To drive a local
  Vite against staging with live SSE timing, use a tiny Node streaming CORS
  relay (Playwright `route.fetch` buffers the whole stream).
- 2026-11-12 — Model speed for a live chat = time to the first word, and a
  short "hi" lies: Claude 5.x (adaptive thinking, always on) and GPT-6.1 /
  6 Astra (default reasoning effort) start in 0.5–2 s on a trivial question
  but 3–9 s on a real judgement turn; Claude 4.x / GPT-5.6 Terra / GPT-4o
  don't think first and stay under ~2.5 s. Measure through `runAddon` with
  a realistic prompt (template: stub db.pg + historyService +
  addonRunsStore + usageLogger like `test-web-search-rule.js`, but keep
  the REAL provider clients and staging keys). `test-builder-mcp.js`
  needs a live DB (it can't run with a dead DB_HOST); check the entry page
  offline by mounting `mcpRoute` alone. Staging's Gemini key ran out of
  prepaid credit (402) — #975.
- 2026-11-17 — A fake SDK only proves what WE send; check the real SDK's wire
  too. Intercept `globalThis.fetch` (answer 418) + a fake Google auth client
  and read the URL/headers — no network (`test-vertex-route.js` section F).
  It caught two bugs fakes could not: `@anthropic-ai/vertex-sdk` 0.19 on our
  sdk 0.74 sent `/v1/v1/messages` unauthenticated (pin the vertex SDK to the
  core SDK's era — 0.14.4 — and bump them together), and the Vertex / OpenAI
  clients read `ANTHROPIC_API_KEY` / `OPENAI_ORG_ID` from env and would send
  them to Google (pass `apiKey: null`, `organization: null`). Also: an SDK
  that starts an auth promise in its constructor rejects UNHANDLED without
  credentials — that exits our server (error center) — pre-handle it (#984).
- 2026-11-17 — Staging often runs APPROVED work that isn't committed yet
  (other sessions deploy from the shared working folder). So a "clean copy"
  deploy (last commit + only your files) ROLLS BACK live work — #984's did:
  the management center lost its save endpoint and /tasks/center and the Bank
  Jerusalem page vanished. Before any staging deploy, tell the Tasks session
  (team lead): either deploy from the shared working folder, or get everything
  that's live committed first. This replaces the 2026-10-26 "deploy from a
  clean copy" advice.
- 2026-11-18 — A Python `open(p, 'w')` patch on Windows rewrites the WHOLE
  file with CRLF endings (most server files are LF; the docs are CRLF), and a
  `'\n'` meant for JS lands as a real newline. Patch with the Edit tool or a
  small Node script written to a file; check `grep -c $'\r$'` before and after.
- 2026-11-18 — Correction: most server AND client files are CRLF in this
  working tree (BuilderContext.tsx, mcpRoute.js, runtimeRoute.js, types…).
  `sed -i` in Git Bash silently rewrites a CRLF file to LF — a whole-file
  diff. Use the Edit tool or a Node `split/join` on the exact substring;
  `git diff --stat` must show only your lines (#986).
- 2026-11-18 — Port 5174 is often another session's Vite (`--strictPort`
  fails and your screenshot shows THEIR code). Pick a free port (e.g. 5179),
  check the Vite output says it started, and kill only your own PID after.
  A local Vite against staging works read-only with a Playwright route that
  aborts every non-GET and answers CORS itself.
