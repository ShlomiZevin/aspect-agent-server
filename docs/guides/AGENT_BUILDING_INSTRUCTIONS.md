# Building Lybi agents

> **What this file is.** Instructions for an AI assistant working on Lybi
> agents. Deliberately generic: no special format, no frontmatter, no
> tool-specific filename, nothing to install.
>
> **To use it:** put it in the folder you work in and start by telling your
> assistant to read it —
> *"Read `lybi-agent-instructions.md` in this folder and follow it."*
> That works with any assistant, present or future.
>
> **Optional:** if your tool auto-loads a particular filename (`AGENTS.md`
> for Codex, Cursor, Copilot and Windsurf; `CLAUDE.md` for Claude Code),
> save it under that name as well and you can skip the opening line. The
> contents never change either way.

You build **agents** for the Lybi platform. An agent is a JSON body stored
on the server — not code. You read the current state over the API, write
your changes to a **draft file** on this machine, and the person you're
working with loads that draft in the Builder and saves it when they're
happy.

You do not deploy anything, restart anything, or change platform source.

---

## The three hard rules

1. **Only ever send GET requests.** The API has endpoints that create and
   save versions. Never call them. Every change you make goes into the
   draft file, and the Builder is the only thing that saves. This is what
   makes your work safe to undo — if you save directly, there is nothing
   to review and nothing to revert.

2. **Edit the draft file in place, in small targeted edits.** Do not
   re-emit the whole agent JSON each turn. The user watches the Builder to
   see what changed; a full rewrite makes every change look like every
   other change, and they lose the thread. Change the thing you're
   changing and leave the rest of the file byte-identical.

3. **Never edit platform source, and say so when something cannot be
   built.** Some requests need a capability that does not exist yet — a
   new addon type, a new field type, a runtime behaviour nobody has
   written. You cannot add those; they are code changes, and they are
   Shlomi's to make. When you hit one, say plainly what is missing and
   what the closest thing the platform *can* do is. Never invent an addon
   name or a config key to make a request look satisfied: it will either
   fail validation or, worse, save cleanly and silently do nothing at
   runtime.

---

## How the work flows

```
   server  ──pull once──►  draft file  ──she loads──►  Builder  ──save──►  server
                             ▲     │
                             └─────┘
                          you edit here,
                       many times, in place
```

**Pull once at the start of a conversation, then stay in the file.** The
user will often talk through one version for a long time — twenty messages
about the same agent. The draft file is the working state for that whole
conversation. Do *not* re-fetch before each edit: the server holds the last
*saved* state, so re-fetching mid-conversation would throw away everything
you have built so far in the draft.

Re-pull only when:
- you are starting work on an agent you have not pulled yet, or
- the user explicitly asks ("pull the current version", "I saved in the
  builder, get it again").

If the user saved in the Builder mid-conversation, pull again — otherwise
you are editing a stale draft.

### Draft files

One file per agent, named by slug:

```
drafts/<agent-slug>.json
```

Shape:

```jsonc
{
  "_meta": {
    "agentSlug": "freeda",
    "pulledFromVersion": 12,     // version number you pulled
    "pulledAt": "2026-09-15T10:00:00Z"
  },
  "agent": { /* AgentBody */ },
  "crews": [ { "crewId": "crew_x1", "body": { /* CrewBody */ } } ]
}
```

Keep `_meta` accurate — the Builder uses it to tell the user which version
the draft came from, so they can see at a glance that they are looking at
a local draft rather than what is saved.

---

## Reading from the API

Everything you need is a plain HTTP GET. There is no database password, no
connection string, and nothing to install.

**Base URL** — the same server the Builder itself talks to:

```
https://aspect-agent-server-1018338671074.europe-west1.run.app
```

**`ownerUserId`** — most endpoints need it. It identifies whose agents to
return, and it lives in the user's browser. Theirs is in
`.lybi/config.json` next to the drafts folder; if it is missing, ask them
to open the Builder's "Work with Claude Code" page, which shows it.

Use `curl` and save what you need. Pretty-print with `jq` if it helps.

### The agent itself

```bash
curl -s "$BASE/api/builder/projects?agentSlug=freeda&ownerUserId=$OWNER"
```

Returns the whole nested project in one call — the agent body **and** all
its crews, already assembled. This is the thing you write into the draft
file. (Server-side this is `hydrateProject()` in
`aspect-agent-server/builder/services/builderProjects.js`, which is the
definitive read logic if you ever need to know exactly what it assembles.)

### Every agent

```bash
curl -s "$BASE/api/builder/projects/list?ownerUserId=$OWNER"
```

Reading other agents is encouraged. When the user asks for something that
exists elsewhere ("like the one in account-opening"), go and read that
agent and copy the real structure rather than inventing one.

---

## Debugging what an agent actually did

When the user says "it didn't work", do not guess from the JSON. Go and
look at the run.

**1. Find the conversation.** `source=live` for real customer chats,
`builder-preview` for tests run inside the Builder:

```bash
curl -s "$BASE/api/agents/freeda/conversations?ownerUserId=$OWNER&source=builder-preview"
```

**2. Read the transcript:**

```bash
curl -s "$BASE/api/agents/freeda/conversations/<convId>/messages"
```

**3. Read what each addon actually saw and produced** — this is the one
that answers the question. `runData` holds the fully assembled prompt
exactly as the model received it, the raw output, the parsed output, and
the memory writes:

```bash
curl -s "$BASE/api/agents/freeda/messages/<messageId>/runs"
```

Take the `messageId` of the assistant message that came out wrong. Start
with any run whose `status` is `error`, then read the `runData` of the step
that misbehaved.

Most "the agent ignored my instruction" reports turn out to be a prompt
that never contained the instruction, or a field that was never filled —
both plainly visible here and nowhere else.

**Also available when you need them:**

| What | Endpoint |
|---|---|
| The conversation's memory (fields by domain) | `/api/agents/:slug/conversations/:convId/memory` |
| Live Brain panels and their runs | `/api/agents/:slug/conversations/:convId/live-brain[/runs]` |
| Profiler output and its runs | `/api/agents/:slug/conversations/:convId/profiler[/runs]` |
| History of changes to an agent, and why | `/api/builder/alfred/agents/:agentId/log` |

---

## Everything known about Builder V2, and where it lives

There is no single document. What the platform knows is spread across
three places, and they do not carry equal weight:

> **code > Alfred's brief > the guides**
>
> Code is what actually runs. Alfred's brief is curated and kept current.
> The guides are the richest on *why*, but they can lag behind the code —
> when a guide and the code disagree, the code is right.

All paths below are from the repo root.

### 1. Alfred's brief — start here

`aspect-agent-server/alfred/services/alfredContext.js`

This is the single best description of Builder V2 that exists: the system
prompt for Alfred, the in-builder assistant. Months of accumulated,
corrected knowledge, deliberately kept in step with the code. **Read it
before the guides** — it is faster and more current than anything else.
Its sections:

- Available addon types (the full catalogue, with what each is for)
- Prompt-template placeholders — every `{{...}}` token and what it renders to
- Parallel steps in the Blocking lane (`joinsPreviousStep`)
- Parameters · Field types · Fields filled by any JSON-emitting addon
- **Choice vs Targeted KB — the decision rule** (the most common mistake)
- Rules addon — deterministic if/then, no LLM
- Live Brain and Profiler (the two panel surfaces)
- Triggers — the agent speaking first
- Knowledge bases (KB) · Pinned files

Also in `aspect-agent-server/alfred/services/`:

| File | Why you'd read it |
|---|---|
| `bodyValidator.js` | **The rules that decide if a body is legal.** Read before inventing structure — this is what rejects a bad agent. |
| `alfredTools.js` | How Alfred reads agents, runs and conversations |
| `changeLog.js` | History of what was changed across agents, and why |

### 2. The code — the truth

| What | Where |
|---|---|
| `AgentBody` / `CrewBody` — canonical shapes | `aspect-agent-server/builder/types/index.ts` |
| Every addon's config, defaults, options | `aspect-agent-server/builder/addons/*.addon.json` |
| `{{...}}` tokens | `aspect-agent-server/builder/promptPlaceholders.json` |
| What each addon *does* at runtime | `aspect-agent-server/builder/plugins/<name>/` |
| The engine that runs an agent | `aspect-agent-server/builder/runtime/BuilderRunner.js` |
| How addon output is parsed into memory | `aspect-agent-server/builder/runtime/outputParser.js` |
| Conditions and formulas on steps | `aspect-agent-server/builder/runtime/conditionMatcher.js`, `formulaEval.js` |
| Reading/writing agents (definitive) | `aspect-agent-server/builder/services/builderProjects.js` |
| Triggers | `aspect-agent-server/builder/triggers/` |

Plugins available: `talker`, `thinker`, `fieldExtractor`, `fieldInterviewer`,
`fieldReasoner`, `kbRetriever`, `rules`, `summarizer`, `transitionRouter`,
`liveBrainPanel`, `vibeExtractor`.

`builder/types/index.ts` is the source of truth for structure. If you are
unsure whether a property exists, open it — never invent a field name.

### 3. The guides — background and worked examples

In `aspect-agent-server/docs/guides/`:

| Topic | File |
|---|---|
| The whole builder, end to end | `BUILDER_V2.md` |
| Addons in depth | `BUILDER_V2_ADDONS.md` |
| Data model / versioning rationale | `BUILDER_V2_SCHEMA.md`, `BUILDER_V2_RUNTIME_PLAN.md` |
| Targeted KB and Choice | `BUILDER_V2_TARGETED_KB.md` |
| Triggers | `BUILDER_V2_TRIGGERS.md` |
| Live Brain panels | `BUILDER_V2_LIVE_BRAIN.md` |
| Fields — reasoner, tags | `BUILDER_V2_FIELD_REASONER.md`, `BUILDER_V2_FIELD_TAGS.md` |
| Dynamic context, prompt editor, snippets | `BUILDER_V2_DYNAMIC_CONTEXT.md`, `BUILDER_V2_PROMPT_EDITOR.md`, `BUILDER_V2_SNIPPETS.md` |
| Summarizer | `BUILDER_V2_SUMMARIZER.md` |
| **A complete worked agent** | `BUILDER_V2_EXAMPLE_CARDLY.md` |
| Building agents generally | `AGENT_BUILDING_GUIDE.md` |
| Profiler, KB internals, playground | `../features/profiler.md`, `kb-system.md`, `playground.md` |

Ignore `BUILDER_V2_BACKLOG.md`, `BUILDER_V2_NEXT_SESSION_PROMPT.md`,
`BUILDER_V2_PHASE_B_ALFRED_HANDOFF.md` and `ALFRED_UPDATE_PROTOCOL.md` —
internal process notes, not how the product works.

### Where to look for a given question

| Question | Go to |
|---|---|
| "Which addon should do this?" | Alfred's brief → Available addon types |
| "What can this addon be configured with?" | the addon's `.addon.json`, then its `plugins/` folder |
| "Choice or Targeted KB?" | Alfred's brief → the decision rule (then `BUILDER_V2_TARGETED_KB.md`) |
| "What token puts X in a prompt?" | `promptPlaceholders.json` |
| "Will this body be accepted?" | `bodyValidator.js` |
| "What does a finished agent look like?" | `BUILDER_V2_EXAMPLE_CARDLY.md`, or read a live agent |
| "Why did it behave that way at runtime?" | the `/runs` endpoint above, then `builder/runtime/` |

Two things that are easy to get wrong:

- A field's `type` is exactly one of `string`, `int`, `enum`, `boolean`.
  It is `int` — never `integer` or `number`. In the UI these read String,
  Integer and Boolean; an `enum` field shows as a Choice or a Targeted KB.
- Crews are separate entities, not nested inside the agent body. Adding a
  crew means adding an entry to `crews[]` in the draft, not a key inside
  `agent`.

---

## How to talk to the user

She is not a developer, and she is looking at the Builder screen while you
work. Name things the way that screen names them — String, Integer,
Choice, Targeted KB, Talker, Field Extractor — not their JSON spellings.
Keep the JSON in the file, not in the conversation.

When a request is large, do not try to build it in one move. Build the
first piece, tell her what you did in one sentence, and let her look at it
in the Builder before continuing. When something in the request is
ambiguous, ask before building — a question costs one message, a wrong
agent costs the afternoon.

Say plainly when you have not checked something. "I haven't looked at that
conversation yet" is always better than a confident guess about why an
agent misbehaved.
