# Session prompt — Lybi Builder V2 stability: error center (#903) + load tests (#902)

Paste this to a new Claude Code session opened in `c:\workspace\aspect`.

---

> **This work is about Lybi — the Builder V2 agent platform.** The repository also holds
> a second product, Aspect (data agents, BI, Insights, Otto); that is not what you are
> building for. Keep your focus, your screens and your tests on Lybi.

## Who you are working for

Shlomi, the CTO. He decides; you build. Talk to him plainly and briefly — he is not
reading code, he is reading results.

## Which product this is — read carefully

This repository holds **two different products** that share code, a server and a
database. Do not mix them up:

| | **Aspect** | **Lybi** |
|---|---|---|
| What | Data agents for Israeli retailers — BI, Insights, Otto, data chat over customer schemas | **An agent-building platform** — the **Builder V2**: people design conversational agents (crews, add-ons, fields, Targeted KB…) and run them |
| Where in the code | `aspect-agent-server/` `bi/`, `insights/`, `otto/`, `modules/`, most of `services/` | `aspect-agent-server/builder/`, `alfred/`, `builder/routes/mcpRoute.js`; client `aspect-react-client/src/builder/` |
| Task board | the Aspect board — **not yours** | **the LYBI board — yours** |

**Your work is Lybi, Builder V2.** The tasks are designed for it: the Errors tab and the
Load tests view live in a Builder agent's Admin, and load tests run against Builder
agents.

**Shared code is fine.** Some files serve both products — e.g. the model-call files
`services/llm.*.js` and the server-wide catch-all in `server.js`. If a hook there also
catches Aspect's errors, that is a bonus, not a problem; just don't go out of your way
to build anything for Aspect, and (as everywhere) recording an error must not change
how anything behaves.

## What you are doing

Two planned tasks on the LYBI board, both assigned to Claude, both **todo** and not
started. Both serve one goal: a stable platform.

- **#903 — Error center.** Catch every error on the conversation path (a turn, any
  add-on, model calls, offline add-ons, triggers, simulations), keep it, group repeats,
  show it in an Errors tab in the agent's Admin, and later decide per kind what the
  platform does (retry, fallback model, polite message, alert by email).
- **#902 — Load tests.** Run several simulated conversations at once (up to ~10–20,
  $20 cap per run) against an agent, measure turn times and errors against a
  single-conversation baseline, and show it in a Load tests view in the agent's Admin.

**The tasks are the spec.** Read both in full before anything else — they hold the
decisions Shlomi already made, the map of where errors are caught in the code, and the
step order:

```bash
BOARD=https://aspect-agent-server-1018338671074.europe-west1.run.app/api
curl -s "$BOARD/tasks/903"      # description is HTML
curl -s "$BOARD/tasks/902"
curl -s "$BOARD/tasks/903/comments"; curl -s "$BOARD/tasks/902/comments"
```

## How Shlomi wants it built

- **One step at a time.** Each task lists numbered steps. Build step 1, prove it works,
  show him, then the next. Load tests start with ONE conversation, then two, then five,
  then ten — not ten on day one. Only combine steps if splitting them makes no sense.
- **Ask before you start which task goes first.** Suggestion to offer: #903 step 1
  first (the error record + Errors tab + the failed-turn hook), because every error a
  load test causes should land there.
- **Recording an error must never change or break a conversation.**
- Keep costs small — load tests spend real tokens. Respect the caps in the task.

## Where things live (start here, learn the rest yourself)

- `CLAUDE.md` at the repo root and in `aspect-agent-server/` / `aspect-react-client/`.
- `aspect-agent-server/docs/guides/BUILDER_V2.md` — the Builder V2 canonical doc.
- `aspect-agent-server/docs/guides/BUILDER_MCP_MAINTENANCE.md` — the MCP link (the door
  outside AIs use), including the **simulation** sections you build on.
- The simulation base (#894, #897 — done, not deployed yet):
  - `builder/services/mcpConversations.js` — start a conversation, one turn, state, the simulated user's next line.
  - `builder/services/simulationJobs.js` — a simulation job that runs on the server by itself (stored in `test_runs`, `type = 'simulation'`).
  - `builder/routes/simulationsRoute.js` — `/api/simulations`.
  - Client: `src/builder/components/AdminDashboard/SimulationsTab.tsx` (Admin → Simulations).
- The conversation path the error map points at: `builder/routes/runtimeRoute.js`,
  `builder/runtime/` (addonRunner, offlineDispatcher, triggerDispatcher,
  profilerDispatcher, liveBrainDispatcher), `services/llm.*.js`.
- After shipping a Builder V2 feature: `docs/guides/ALFRED_UPDATE_PROTOCOL.md` and the
  MCP maintenance guide say how Alfred and the MCP learn it — but **only after Shlomi
  approves the feature**.

## Testing

- `node scripts/test-builder-mcp.js` — the MCP battery (real database; uses the test agent `zz-mcp-test`).
- `node scripts/test-simulation-jobs.js` — offline battery for simulation jobs.
- `tkb-demo` is a demo agent that is safe to test on.
- Client: `npx tsc -b` and `npx eslint <file>`; check screens in a real browser.
- The local server must be **restarted** to pick up server changes. The database is
  reached by IP — if it times out, the machine's IP is probably not on the database's
  allowed list; tell Shlomi rather than working around it.

## Rules that are not negotiable

- **Never git commit, push or deploy** unless Shlomi says so explicitly.
- **The task board:** load the `lybi-task-board` skill (`.claude/skills/lybi-task-board/`).
  One task at a time. No comments on tasks. Move a task to Done (with the Hebrew
  "What changed" + headline the skill describes) **only when Shlomi says**. Never mark
  anything deployed — releasing is his.
- **UI:** nothing may change size or jump when clicked (reserve space, disable instead
  of hide); nothing blinks; editing happens in modals with the app's own confirm dialog;
  minimal explanatory text (short labels + tooltips, not paragraphs). Match the
  existing Admin screens (Conversations / Simulations) in look.
- Report honestly: what you tested, what you could not, and why.
