# Noa builds agents herself, with Claude Code

Give Noa a local Claude Code that reads the real agents and the real
conversations, edits a **draft file** on her machine, and lets her review
and save it in the Builder. Replaces the "ask Alfred and hope" loop for
big, complex agent work.

**Status:** designed, not started. Skill and setup guide are written; the
Builder work and the wizard are not.

---

## Why — the problem, with evidence

Alfred is not failing because the model is weak. He is failing because
**reading is agentic but writing is a single capped one-shot.**

Measured from `llm_usage` (90 days):

| Step | Shape | What the numbers show |
|---|---|---|
| `alfred-brainstorm` | agentic loop, 7 read tools | 238 calls · avg **37,518 in → 648 out** · max **439,969 in** |
| `alfred-apply-consolidator` | one-shot | 73 calls · output pinned at exactly **2048** (the old cap) |
| `alfred-apply-patch` | one-shot, forced tool | 71 calls · hit exactly **8192** twice · max 10,824 |
| `alfred-change-validate` | barely wired | **1 call, ever** |

So Alfred can explore, but he cannot act → check → correct. The write is
one forced shot with a ceiling, and then the validator either accepts it
or throws a 422 at the user.

That breaks precisely on Noa's requests. Her Alfred usage is bimodal:

- 222 requests under 200 characters
- then **5 requests over 2,000 characters — the longest is 16,531**

The long ones are full feature specs ("set up the relevant addon…") that
must be emitted as an entire crew in one capped call. We can see them
truncating at the caps.

Noa (`builder-owner-letw5667-mpo9fmy6`) is the heaviest user by far: 33
chats, 145 messages, across `freeda`, `account-opening`,
`onboarding-foreign`, `deposits`, `credit-solutions`. She is building real
client agents, not experimenting.

Claude Code fixes this by writing in small verified increments and asking
when something is ambiguous — which is exactly what a 16k-character spec
needs.

---

## The shape of the solution

```
   server  ──pull once──►  draft file  ──she loads──►  Builder  ──save──►  server
                             ▲     │
                             └─────┘
                        Claude Code edits here,
                        many times, in place
```

Claude Code never writes to the server. The Builder stays the only writer.
Nothing is real until she presses save, and revert covers the rest.

---

## Decisions made

| # | Decision | Why |
|---|---|---|
| 1 | **Claude Code desktop app** | No terminal, no IDE. Not claude.ai (no filesystem). Not Claude Code web — it runs on a remote VM and cannot see her local draft files. |
| 2 | **Sparse checkout, not a repo split** | `git sparse-checkout` gives her only `builder/`, `alfred/`, `docs/`, `.claude/` from the existing repo, and `git pull` still works. Nothing to fork or maintain. |
| 3 | **Claude Code sends GET only** | It has HTTP reach to the write endpoints, so "read-only" has to be an explicit rule, not an assumption. |
| 4 | **Changes land in a draft file, not the DB** | Keeps the Builder as sole writer → review and revert always work. |
| 5 | **No database credentials at all** | Everything she needs is already an open HTTP endpoint (see below). There is no secret to hand over, and nothing to rotate. |
| 6 | **Two states, not three** | The folder draft is a *source* for the existing browser draft — "Load from folder" pulls it in, then the normal Apply/save/version flow is unchanged. A third independent state would be one concept too many. |
| 7 | **Pull once, then edit in place** | She talks through one version over many messages. Re-fetching mid-conversation would wipe in-progress work with the last *saved* state. |
| 8 | **Targeted edits, never full rewrites** | If the whole JSON is re-emitted each turn, she can't see what changed and the Builder diff is useless. |
| 9 | **Mark local-vs-saved clearly; rely on revert** | Instead of conflict machinery: the Builder shows plainly that it is displaying a local draft and which version it came from. Revert handles mistakes. |
| 10 | **Only the agents she's working on** go in the folder | Not a mirror of everything. One file per agent: `drafts/<agent-slug>.json`. |

**Rejected:** building a custom MCP tool layer. A curated tool surface
would be a worse copy of what Claude Code already does with the real code,
and would fail on exactly the long-tail requests that make it useful.

---

## What already exists

### Written and ready

| File | What it is |
|---|---|
| `.claude/skills/build-agent/SKILL.md` | The skill. How to read agents over the API, the pull-once/edit-in-place workflow, how to debug a conversation, the three hard rules, and a map of every place Builder V2 knowledge lives. |
| `aspect-agent-server/docs/guides/WORK_WITH_CLAUDE_CODE.md` | Her setup guide — 6 steps with links. This is the content the wizard should present interactively. |

### API endpoints — already built, no work needed

All unauthenticated today, so Claude Code needs only the base URL
(`https://aspect-agent-server-1018338671074.europe-west1.run.app`) and her
`ownerUserId`.

| Purpose | Endpoint |
|---|---|
| The agent **and all its crews**, assembled | `GET /api/builder/projects?agentSlug=&ownerUserId=` |
| Every agent | `GET /api/builder/projects/list?ownerUserId=` |
| Conversations (`source=live` or `builder-preview`) | `GET /api/agents/:slug/conversations?ownerUserId=&source=` |
| Transcript | `GET /api/agents/:slug/conversations/:convId/messages` |
| **Addon runs — assembled prompt, raw + parsed output, memory writes** | `GET /api/agents/:slug/messages/:messageId/runs` |
| Conversation memory | `GET /api/agents/:slug/conversations/:convId/memory` |
| Live Brain / Profiler | `GET /api/agents/:slug/conversations/:convId/live-brain[/runs]`, `/profiler[/runs]` |
| Change log | `GET /api/builder/alfred/agents/:agentId/log` |

The runs endpoint is the one that makes debugging real — it is the only
place you can see the prompt exactly as the model received it.

---

## What needs building

### 1. Builder — folder drafts (the core work)

Use the **File System Access API** (`showDirectoryPicker`). She grants
access to her `lybi` folder once; persist the handle in IndexedDB so it
survives reloads.

It must be **bidirectional** — Claude Code needs to read current state
before it can edit:

- **Write out:** dump the hydrated agent to `drafts/<slug>.json` in the
  agreed shape (see below), so Claude Code has something to edit.
- **Read in:** detect a changed draft file and offer "Load from folder",
  which replaces the **browser draft** (decision 6) — after that, the
  existing Apply/save/version flow is untouched.
- **Mark it:** while a local draft is loaded, show clearly that this is a
  local draft and which version it came from (`_meta.pulledFromVersion`)
  rather than what is saved (decision 9).

Draft file shape:

```jsonc
{
  "_meta": {
    "agentSlug": "freeda",
    "pulledFromVersion": 12,
    "pulledAt": "2026-09-15T10:00:00Z"
  },
  "agent": { /* AgentBody */ },
  "crews": [ { "crewId": "crew_x1", "body": { /* CrewBody */ } } ]
}
```

**Caveat:** File System Access API is Chrome/Edge only. Either accept that
(she's one user) or add a drag-the-file-in fallback.

### 2. Builder — the "Work with Claude Code" wizard

Follow the existing guide-modal pattern exactly — see
`src/builder/components/TriggersGuide/`:

```
src/builder/components/ClaudeCodeGuide/
  ClaudeCodeGuideModal.tsx
  claudeCodeGuideContent.ts
  ClaudeCodeGuideModal.module.css
  index.ts
```

Open it from `TopBar.tsx`, where `PromptGuideModal` already lives
(`<ClaudeCodeGuideModal open={...} onClose={...} />`).

Content is `WORK_WITH_CLAUDE_CODE.md` turned into steps. The wizard earns
its keep by doing the fiddly parts **for** her — it runs in her browser, so
it already knows things she'd otherwise have to hunt for:

- **Her real `ownerUserId`**, read from `localStorage['builder:ownerUserId']`,
  with a Copy button — no DevTools.
- **The ready-made `.lybi/config.json`** with her id already filled in.
- **The Step-3 paste block** as one copy button (clone + sparse-checkout +
  mkdir in a single command).
- **Download the skill file** (see 3).
- Per-step checkmarks so she can see where she is.

Goal: the only thing she types is one paste-block.

### 3. Serve the instructions file for download

**The instructions are one plain markdown file, and nothing else.** No
skill format, no frontmatter, no tool-specific filename. Canonical copy:

```
aspect-agent-server/docs/guides/AGENT_BUILDING_INSTRUCTIONS.md
```

It is used by putting it in the working folder and opening the session
with one line — *"Read `lybi-agent-instructions.md` in this folder and
follow it."* That works with any assistant, which is the point: nothing
here is tied to Claude Code, Codex, or anything that comes next.

Optionally it can also be saved as the filename a given tool auto-loads
(`AGENTS.md` for Codex/Cursor/Copilot/Windsurf, `CLAUDE.md` for Claude
Code) to skip the opening line. Same bytes; confirmed that Claude Code
does **not** read `AGENTS.md`, so the filename is the only difference
between tools.

The wizard hands her the file plus that one-line opener on a copy button.
Bundle it as a static asset in the client, or serve it from an endpoint —
an endpoint means she gets updates without a redeploy.

`.claude/skills/build-agent/SKILL.md` in this repo is a **thin pointer**
to the canonical file, not a copy, so our own sessions pick it up with no
risk of drift.

### 4. Access

- Add Noa's GitHub account to the repo — it is **private**, so Step 3 of
  the guide fails without it.
- Claude Code requires a **claude.ai subscription seat** (Pro/Max/Team/
  Enterprise). It is *not* available on API-key/Console billing. Budget
  per-seat, not per-token.

---

## Open questions

1. **`.lybi/config.json`** — invented convention. The wizard and the skill
   must agree on it; change both together if you'd rather it lived
   elsewhere.
2. **The 16k-character spec dump** — do we want the tooling to *support*
   that habit (decompose it), or to push back early and teach her to go in
   smaller steps? This changes both the skill's wording and the wizard's
   advice. Currently the skill leans toward decompose-and-check.
3. **Repo scope** — she gets `builder/`, `alfred/`, `docs/`, `.claude/`.
   Widen or narrow as you prefer; sparse-checkout is a convenience, not a
   hard boundary (she can disable it).

---

## How to verify

1. Noa goes from nothing to a saved agent change **without asking for
   help**, using only the wizard.
2. No credential is handed to her at any point.
3. She asks Claude Code why an agent misbehaved in a real conversation,
   and gets an answer grounded in the actual run data.
4. A draft she doesn't like is discarded, or reverted after saving, with
   nothing lost.
5. She sends one of her long specs and gets a built, checkable result
   instead of a 422.

---

## Related

- Alfred's own fix for the same root cause (moving the write into the
  loop) is the alternative path if this proves too loose — same diagnosis,
  different client. The tool/knowledge work is shared either way.
- `docs/guides/WORK_WITH_CLAUDE_CODE.md` — the setup content.
- `.claude/skills/build-agent/SKILL.md` — the skill itself.
