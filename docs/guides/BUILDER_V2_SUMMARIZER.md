# Builder V2 — Summarizer

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first. Read
> [BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md) for the addon contract,
> [BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md) for JSON shapes, and
> [BUILDER_V2_DYNAMIC_CONTEXT.md](./BUILDER_V2_DYNAMIC_CONTEXT.md) for
> the sibling agent-level mechanism that uses the same "consumed via a
> token" pattern.
>
> **Status:** planning. No code yet.

---

## What this is

A **Summarizer** is a configurable LLM step whose job is to read a
window of chat history and produce a compact running synthesis — a
"checkpoint" of what's happened. Other addons can then be configured to
*see only the summary* instead of (or alongside) raw history.

Why we need it:

- **Cost & latency**: long conversations bloat every downstream addon's
  prompt. A 50-turn chat that distills to 8 sentences cuts every
  subsequent Thinker/Talker call dramatically.
- **Signal density**: raw transcripts are noisy. A summary keeps the
  *meaningful* state (decisions, declared intents, unresolved threads)
  and drops greetings, repetition, mid-stream corrections.
- **Cross-crew handoff**: when crew A finishes and crew B starts, B
  often doesn't want A's full transcript — just *"here's where things
  stand."* The summarizer is that handoff payload.

---

## The hard call: where does the summary go?

The user explicitly raised this question: at the technical provider
level (every provider takes `prompt + history messages`), does the
summary land in the **prompt** or in the **history messages**?

**Decision: in the prompt, via a `{{summary[:NAME]}}` token.**

Reasoning:

1. **It's authored content, not transcript.** The history messages
   array is a record of what was actually said. Injecting a synthetic
   assistant message that says *"summary: …"* lies about the
   conversation's structure and confuses providers that distinguish
   roles strictly (e.g. Anthropic's strict alternation rules).
2. **Prompts are where context-by-token already lives.** `{{memory}}`,
   `{{thinking}}`, `{{dynamic:X}}` are all synthesised values rendered
   into the prompt at assemble time. `{{summary}}` is the same shape.
   Same substituter, same rules, same audit trail.
3. **It composes cleanly with history.** An addon that wants
   *summary-only* sets `context.history.mode = 'none'` and writes
   `{{summary:NAME}}` into its prompt. An addon that wants
   *summary + last 5 messages* sets `history.mode = 'last_n', n: 5` and
   adds the token to its prompt. Orthogonal knobs.
4. **It avoids a new history mode.** Earlier sketches had a
   `history.mode = 'summary'` option that would swap raw messages for a
   summary inside `historyMessages`. That conflates two concepts —
   prompt-authored context and chat transcript — and constrains the
   author: you can have raw OR summary, never both. Token-based
   consumption is strictly more flexible.

So at runtime: `promptAssembler.assemblePrompt()` substitutes
`{{summary[:NAME]}}` from the conversation's `brain.summary` blob, the
same way it substitutes `{{memory}}`. No new history mode. No synthetic
messages.

> Forward-pointer comment already in `types/index.ts` on `HistoryMode`
> hinted at a `summary` mode. **That comment will be removed** —
> summary consumption is a prompt token, not a history mode.

---

## Brain blob — third section

Today `brain = { memory, thinking }`. The Summarizer adds a **third
section**:

```ts
interface Brain {
  memory:   { [domain: string]: Record<string, any> };
  thinking: { [domain: string]: Record<string, any> };
  summary:  { [name:   string]: string };   // NEW
}
```

Each summarizer instance writes to its own `summary[name]` key. The
`name` is configured on the instance and is the consumption key:

```
{{summary}}        → all summaries joined under a ## Summary heading,
                     each as a ### NAME block.
{{summary:NAME}}   → just that one summarizer's current output.
```

Tokens are added to `aspect-agent-server/builder/promptPlaceholders.json`
under `sections` and `values`, with a new **sigil**.

### Sigil

`%` opens the Summary picker in MentionTextarea. Mnemonic: percentage /
compression / digest. Listed in `SINGLE_TRIGGERS` alongside
`@ ! # ^ *`. The unified `{{` and `/` pickers also surface summary
entries.

---

## Multi-level: agent and crew

The user wants summarizers at **two scopes**:

| Scope | Lives on | Reads | Persistence |
|---|---|---|---|
| **Agent-level** | `agent.summarizers[]` | All messages across all crews | User-level (carries across conversations, like agent memory). |
| **Crew-level**  | `agent.summarizers[]` (with `crewId` set) | Only messages produced inside the targeted crew | Conversation-level (resets per conversation). |

**Both live on the agent doc.** The user's instruction was *"summarizer
you add it to the agent on the agent level"* — there is one editing
surface for summarizers, on the agent. Each instance carries a `scope`
that determines what it reads and where its output is persisted:

```ts
interface SummarizerDef {
  id:           ID;
  name:         string;        // canonical token key
  displayName?: string;        // for the panel header
  scope:        'agent' | 'crew';
  crewId?:      ID;            // required when scope === 'crew'
  triggers:     SummarizerTrigger[];
  config:       {
    prompt:        string;     // mention-aware
    model:         ModelRef;
    history:       HistoryMode;        // what THIS summarizer reads
    promptTemplate?: string;
  };
}

type SummarizerTrigger =
  | { kind: 'message_count'; everyN: number }
  | { kind: 'crew_finished'; crewId?: ID };   // optional filter
```

Triggers are configurable per the user's spec:
- `message_count` — runs after every N messages (default 8).
- `crew_finished` — runs after a crew transition; optionally scoped to
  a specific crew. (Useful for crew-level summarizers: "summarize crew
  A whenever A wraps up.")

Both trigger kinds can be added to the same summarizer; the union
fires.

**Future trigger kinds** the schema accommodates:
- `time_elapsed` (every N minutes of conversation).
- `field_value` (when field X reaches value Y).
- `addon_finished` (after a specific addon instance runs).

The user said *"maybe more in the future"* — the discriminated-union
shape leaves room without breaking existing data.

### Why not crew-owned crew-level summarizers?

A crew-level summarizer *could* have lived on `CrewDoc.summarizers[]`.
We don't put it there because:

1. The user wants a single place to manage summarization across the
   agent: "summarizer you add to the agent on the agent level."
2. Forward-compat: when **agent-level cortex chains** ship (see
   below), the agent will own a chain that includes summarizers.
   Keeping summarizers on the agent now means we only have to lift
   them into the chain, not migrate them across documents.

---

## Forward compatibility — agent-level chains

The user flagged: *"eventually we would have also agent-level chains —
so when adding the summarizer take this into account; the agent-level
summarizer will serve us more as a crew member when we have the chain
reaction."*

Translation: today, addons (Talker, Thinker, Field Extractor, …) live
on `CrewDoc.addons[]`. A future iteration adds `AgentDoc.cortex` — an
agent-scoped chain of addons that runs around / across crew chains.

**Plan for the migration when agent-level chains arrive:**

- The `Summarizer` becomes a regular plugin (`pluginId: 'summarizer'`)
  in `aspect-agent-server/builder/addons/summarizer.addon.json`.
- Agent-scope summarizers move from `agent.summarizers[]` to
  `agent.cortex[]` as `AddonInstance` entries.
- Crew-scope summarizers continue to live on the agent (still added
  there) but project into the relevant crew's runtime sequence.

To keep that path cheap, **we author the Summarizer's run logic as if it
were a plugin already** — same `ctx` shape, same `run()` return shape,
same memoryWrites contract. The only difference for now is the
*scheduler*: instead of being invoked by the per-turn cortex loop, the
engine invokes it by trigger.

The migration becomes "switch the invoker, move the array." The
descriptor JSON, the React `ConfigComponent`, the prompt template, the
mention picker integration, the SSE event names — none of that changes.

---

## Runtime placement — when does it fire?

The user was explicit: *"runs only after. It's like a checkpoint."*

So:

1. The user turn happens.
2. The cortex runs (main lane → background lane → offline lane).
3. The Talker streams its response.
4. **After the turn is fully written** (message persisted, SSE
   `message.done` emitted), the engine evaluates every summarizer on the
   agent in order:
   - Increment per-summarizer message counter on the conversation.
   - For each `message_count` trigger: if counter ≥ everyN, fire.
   - For each `crew_finished` trigger: if a crew transition was emitted
     this turn (and matches the trigger's `crewId` filter, if any), fire.
5. Firing = schedule the summarizer's `run()` on the **background lane**.
   It does **not** block the next user turn.
6. When it finishes:
   - Its output is the new summary text.
   - Written to `brain.summary[name]` with persistence per `scope`
     (user-level for agent scope, conversation-level for crew scope).
   - An SSE event `summarizer.completed` is emitted so the UI can update
     the "Summary" panel and any open prompt previews.

Because step 5 is on the background lane, even slow summary models
(e.g. a Claude/Opus call) never delay the user-facing response. If a
new turn starts before the summary finishes, the in-flight summary is
allowed to complete; downstream addons consume *whatever was last
written* — the staleness window is at most one turn.

---

## Default strategy: leave it to the user

User: *"leave it to be configured."*

The descriptor ships with a sensible **starter prompt** and a
no-magic strategy:

```
{{persona}}

You are summarizing a conversation so that other parts of the system can
work with a compact view of what's happened.

What you know:
{{memory}}

Produce a JSON object:
{
  "summary": "<your synthesis>"
}

Style:
- Bullet structure when the chat has multiple distinct threads;
  paragraph when it has one continuous arc.
- Keep declared intents, decisions, named entities, and unresolved
  questions. Drop greetings, repetition, mid-stream corrections.
- 6–12 lines target. Hard cap 25 lines.
- Refer to the user as "the user". Refer to the assistant as "the
  agent".

Output JSON only — no preamble, no markdown fences.
```

Defaults:
- `defaultLane: 'background'` (the only lane it ever runs in).
- `history.mode: 'last_n'`, `n: 25` for the summarizer's *own* read of
  history. The user can move to `full` for very accurate summaries at
  cost, or `last_n` smaller for fast checkpoints of *recent* state.
- `model: { providerId: 'openai', modelId: 'gpt-4o-mini' }` — cheap and
  good enough for compression. Easy to swap.

There is **no built-in strategy mode** (no "extractive vs abstractive"
toggle, no schema of required keys). The prompt *is* the strategy.

---

## UI

### Where the user manages summarizers

A new **Summary** section on the **agent** page (alongside Persona,
Schema, Crews). Single entry: a list of `SummarizerDef` rows, "+ Add
summarizer" at the bottom.

Each row shows:
- Icon (`%`).
- `displayName` (or `name`).
- Scope chip: `agent` or `crew · CrewName`.
- Trigger summary: `every 8 msgs · after crew A finishes`.
- Row click → opens a modal.

### Summarizer modal

Reuses the standard addon modal frame (same component family as the
Talker / Thinker modal). Sections:

1. **Name + display name + scope** (with crew picker if scope is `crew`).
2. **Triggers**: add/remove rows. Each row is a trigger kind + its
   params. (`message_count` → number input. `crew_finished` → optional
   crew dropdown.)
3. **History** (what this summarizer reads): the standard `HistoryMode`
   selector.
4. **Prompt**: standard `MentionTextarea` with all sigils available —
   you can reference `@memory`, `!thinking`, `#parameters`,
   `^persona`, `*dynamic`. Self-reference via `%` IS allowed
   (rolling summary: *"refine the prior summary"*).
5. **Model**: standard model picker.
6. **Prompt template**: advanced — only show if user expands.

### Where the output shows up

Summaries can be long. The user said: *"as it might be long you will
see the 'level name' and you will be able to open it to see the
summary."*

Two surfaces:

**A. Cortex run timeline (UserChat).**
A `summarizer.start` / `summarizer.completed` event renders a collapsed
card on the timeline, sized just like an addon card, captioned with the
summarizer's displayName. Click to expand → shows the summary body in a
read-only `MentionTextarea`.

**B. A "Summary" panel** on the agent page (mirrors the Schema panel
shape). Per-summarizer card, showing:
  - Name & scope chip.
  - "Last fired: X" timestamp.
  - Collapsed body. Expand → full text.
  - For dev: "Force run now" debug button.

### MentionTextarea integration

`%` is added to `SINGLE_TRIGGERS` and to the unified `{{` / `/`
pickers. `useMentionOptions` returns one entry per declared summarizer
(by `name`) plus the "All summaries" entry.

---

## Server runtime sketch

> Not implementing in this PR — capturing so the next session can pick
> it up without re-deriving.

### Files (anticipated)

```
aspect-agent-server/
  builder/
    addons/
      summarizer.addon.json              ← future, when it becomes an addon
    runtime/
      summarizers/
        summarizerScheduler.js           ← evaluates triggers per turn
        summarizerRunner.js              ← invokes the LLM, writes brain
      builderMemory.js                   ← add SECTION_SUMMARY
      promptAssembler.js                 ← {{summary}} + {{summary:NAME}}
      BuilderRunner.js                   ← hook scheduler after message.done
    promptPlaceholders.json              ← register the new sigil & tokens
    types/index.ts                       ← Brain.summary, SummarizerDef
```

### Brain blob changes

```js
// builderMemory.js
const SECTION_SUMMARY = 'summary';
// normalizeBlob: tolerate missing/legacy summary key.
```

### Assembler changes

```js
// promptAssembler.js — substitute order stays:
//   {{prompt}} → sections → parameterised
// New section token:
out = out.replace('{{summary}}', renderAllSummaries(brain.summary));
// New parameterised:
out = out.replace(/\{\{summary:([\w-]+)\}\}/g,
  (_, name) => brain.summary?.[name] ?? '');
```

### Scheduler shape

```js
// summarizerScheduler.js
async function evaluateTriggers({ agentDoc, conversationId, turnInfo }) {
  for (const s of agentDoc.summarizers ?? []) {
    if (shouldFire(s, conversationId, turnInfo)) {
      backgroundLane.schedule(() => runSummarizer(s, conversationId));
    }
  }
}
```

Called by `BuilderRunner` right after the turn's
`message.done` SSE event is emitted. Counter state lives in
`context_data` (user or conversation level depending on `scope`).

### SSE events

```
summarizer.started      { summarizerId, name, scope }
summarizer.completed    { summarizerId, name, scope, durationMs, tokens }
summarizer.failed       { summarizerId, name, error }
```

---

## Consumption from other addons

A Thinker that wants *summary-only* context:

```jsonc
{
  "pluginId": "thinker",
  "context":  { "history": { "mode": "none" } },
  "config": {
    "prompt": "{{persona}}\n\n## What's happened so far\n{{summary:main}}\n\nWhat should the talker do this turn?\n..."
  }
}
```

A Talker that wants summary + recent messages:

```jsonc
{
  "pluginId": "talker",
  "context":  { "history": { "mode": "last_n", "n": 5 } },
  "config": {
    "prompt": "...\n## Background\n{{summary:main}}\n## Persona\n{{persona}}\n..."
  }
}
```

Same orthogonal knobs the rest of the system already exposes — no new
configuration concept introduced.

---

## Alfred awareness

Once Summarizer is implemented:

- The descriptor JSON (when it ships) is auto-discovered by
  `alfred/services/patchGenerator.js` like every other addon.
- `bodyValidator.js` gets a `validateSummarizers(agentBody)` check
  (name uniqueness, scope+crewId consistency, trigger validity).
- The Alfred system prompt gets a paragraph: *"Summarizers live on the
  agent body in `summarizers[]`. They are checkpoints — they only run
  after a turn finishes. To make a Thinker/Talker see only the summary,
  set its `history.mode = 'none'` and place `{{summary:NAME}}` in its
  prompt."*

For the planning phase, Alfred remains unaware. We can hand-edit the
agent body to add summarizers and the runtime will pick them up.

---

## Decisions locked in (review session 2026-06-04)

1. **Counter does NOT reset on crew transitions.** Per-crew cadence is
   what crew-scope summarizers exist for.
2. **Everything is per conversation.** Both the trigger counter AND the
   output persistence are per-conversation for now. Cross-conversation
   accumulation is out of scope. (Earlier sketches had agent-scope
   output persisting user-level; we walked that back to keep the model
   one shape.)
3. **Structured auto-derived names** instead of free-form. The `name`
   field used in `{{summary:NAME}}` is derived from scope + trigger:
   - agent-scope, `message_count: N` → `h-N-steps`
   - crew-scope,  `message_count: N` → `h-crew-N-steps`
                                       (or `h-crew-CREWNAME-N-steps` for
                                        a specific crew)
   - `crew_finished` (any)            → `h-crew`
   - `crew_finished` of named crew    → `h-crew-CREWNAME`
   `displayName` stays free-form for the panel header.
4. **One trigger per summarizer.** Cleaner names, cleaner mental model.
   If you want both "every 5 steps" and "after crew finishes", make two
   summarizers.
5. **Rolling = replace.** Each run overwrites
   `brain.summary[name]`. No append-only history log in v1.

## Parked — composition with history

Discussed but the user found the design space too confusing in one
sitting. Park until basic Summarizer ships. Notes for the next round:

- **The overlap problem.** When an addon consumes
  `{{summary:NAME}}` in its prompt AND sets `history.mode = 'full'` (or
  a `last_n` window that overlaps the summarized range), the same
  content is in the prompt twice — once compressed, once raw.
- **Possible mitigation: `since_last_summary` history mode.** Each
  summarizer run records the index of the last message it consumed; a
  new history mode reads messages strictly *after* that cutoff.
  Composes cleanly with the prompt token.
- **Also wanted: crew-scoped `last_n`.** Today `last_n: 10` walks back
  across crew transitions. Needs a `crewScope: 'all' | 'current'`
  flag to stop at the last transition. Independent of Summarizer —
  useful on its own.
- **Enforcement?** Don't enforce. Optional inline UI warning. Annotate
  the rendered summary block with its window
  (`## Summary (covers messages 1–10)`) so the LLM can dedupe on its
  own.
- **Goal for the next pass:** find a single simple knob that captures
  the common "summary + recent" composition without exposing all four
  history modes plus a summarizer-coupled mode. The current option
  set is too many decisions for the prompt author.

---

## Implementation phases (proposed)

**Phase 1 — bare runtime (no UI).**
- Add `SummarizerDef` to types and `brain.summary` to the blob.
- Add `{{summary[:NAME]}}` tokens to the assembler and the placeholder
  spec.
- Stand up `summarizerScheduler` and `summarizerRunner`. Hand-edit
  agent docs to test.

**Phase 2 — UI.**
- Summary section on the agent page.
- Summarizer modal.
- Timeline card in UserChat.

**Phase 3 — mention integration.**
- `%` sigil in MentionTextarea, unified picker entries.

**Phase 4 — Alfred awareness.**
- Validator + system-prompt copy.

**Phase 5 — migration to agent-level chains (when those ship).**
- Author `summarizer.addon.json` descriptor.
- Move `agent.summarizers[]` into `agent.cortex[]` as `AddonInstance`
  entries. Crew-scope summarizers stay agent-managed but project into
  crew runtime sequence.
