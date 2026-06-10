# Builder V2 — Summarizer

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first.
> Read [BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md) for the addon contract,
> [BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md) for JSON shapes, and
> [BUILDER_V2_DYNAMIC_CONTEXT.md](./BUILDER_V2_DYNAMIC_CONTEXT.md) for
> the sibling "consumed via a token" mechanism on the read side.
>
> **Status:** design locked. Ready to build (Phase 1 below). No code yet.
>
> **History:** this doc was rewritten on 2026-06-09 after a brainstorm
> that significantly reshaped the design. The earlier plan put
> Summarizers on a standalone `agent.summarizers[]` array with a
> separate scheduler. The new plan unifies them as **offline-lane
> addons** that share a generic "When" trigger contract with any
> future event-driven addon. This rewrite reflects the new model;
> the old text is gone — read git history for the prior version.

---

## TL;DR

A **Summarizer** is a regular **addon** that lives on the *offline lane* of
a crew (or the agent cortex). It fires on a configurable trigger
(`every_n_messages`, `on_transition`, etc.) — **after** the user-facing
response streams, never blocking it. Each run reads its own slice of
chat history and writes:

- a **synthesis** under `brain.summary[NAME]` — consumable from any
  prompt via `{{summary:NAME}}`,
- a **watermark** — the highest message index the summarizer
  consumed, which enables a new `since_summarizer: NAME` history mode
  for downstream addons.

This both compresses long conversations cheaply and gives authors a
crisp way to express *"only the messages since the last checkpoint."*

---

## Why we need it

- **Cost & latency.** A 50-turn chat that distills to 8 sentences
  shrinks every downstream Thinker/Talker prompt dramatically.
- **Signal density.** Raw transcripts are noisy. A summary keeps
  declared intents, decisions, named entities, unresolved threads;
  it drops greetings, repetition, mid-stream corrections.
- **Composable handoff.** When crew A wraps up and crew B starts, B
  rarely wants A's full transcript — just *"here's where things
  stand."* The summarizer's output IS that handoff payload.
- **Bounded recency.** "Since the last checkpoint" becomes a
  first-class history mode, so a Thinker can read exactly the new
  messages without redoing context the summary already covers.

---

## Mental model

Three things go together — internalise them and the rest of the doc
falls out:

### 1. The offline lane is for event-driven work

The cortex chain has three lanes today:

| Lane | When it runs | Blocks reply? |
|---|---|---|
| **Blocking** (`main`) | Every turn | Yes — Talker speaks at the end |
| **Background** | Every turn | No — fire-and-forget per message |
| **Offline** | On a trigger (every N messages, on transition, …) | No — fires *after* the reply |

Today the offline lane is `enabled: false` in `ChainCanvas`. Building
the Summarizer means turning it on. Future offline addons (telemetry
roll-ups, async memory consolidation, …) ride the same scaffolding.

### 2. Every offline addon has a "When"

Just as a blocking addon picks `context.history` to choose what it
reads, an offline addon picks a **trigger** to choose *when* it
fires. The first two trigger kinds:

- `every_n_messages: N` — fires after the N-th user-message-plus-reply
  pair on the conversation.
- `on_transition` — fires after a crew transition completes (optional
  per-crew filter later).

`when_field_equals` and `time_elapsed` are obvious next entries — the
discriminated-union shape leaves room.

### 3. A Summarizer is just an offline addon

No separate config surface. No `agent.summarizers[]` array. Adding a
Summarizer means dragging the "Summarizer" plugin into the offline
lane like any other addon, and configuring its prompt + bound output
name + history slice.

---

## Offline lane contract

Shared by every offline addon. Lives on `AddonInstance.context.trigger`
(new field — sibling of `context.history`).

```ts
type OfflineTrigger =
  | { kind: 'every_n_messages'; n: number }
  | { kind: 'on_transition' }                     // any transition
  // Future:
  // | { kind: 'when_field_equals'; field: string; value: string }
  // | { kind: 'time_elapsed'; minutes: number };

interface AddonContext {
  history: HistoryMode;
  trigger?: OfflineTrigger;   // required when the addon sits on the offline lane
}
```

**Runtime semantics:**

1. The user turn happens.
2. The blocking lane runs; Talker streams the response.
3. The `message.done` event is emitted.
4. The engine evaluates each offline addon's trigger:
   - Increments per-(conversation, addon) counter.
   - If the trigger fires, schedules the addon's `run()`.
5. All triggered offline addons in a given turn run **in parallel**.
   Order between them is not specified — they share no read/write
   ordering guarantees with each other.
6. Each completion writes to the brain and emits an `addon.completed`
   SSE event so any open UI panels can refresh.

If a new user turn starts before an in-flight offline addon finishes,
the in-flight call is allowed to complete; downstream addons consume
*whatever was last written* — the staleness window is at most one
turn.

---

## Summarizer addon spec

### Descriptor

`aspect-agent-server/builder/addons/summarizer.addon.json` — same
shape as every other addon descriptor.

```json
{
  "pluginId":          "summarizer",
  "displayName":       "Summarizer",
  "description":       "Distill chat history into a compact checkpoint. Other addons read it via {{summary:NAME}}.",
  "purpose":           "Use when long conversations bloat downstream prompts, or when you need a clean handoff payload between crews. Pairs naturally with the `since_summarizer` history mode — a Thinker can read just the new messages since this checkpoint last fired.",
  "icon":              "📝",
  "color":             "#0891b2",

  "defaultLane":       "offline",
  "fieldMode":         "none",
  "speaks":            false,

  "allowedOutputTypes": ["json-to-memory"],
  "defaultOutputType":  "json-to-memory",

  "defaultContext": {
    "history": { "mode": "last_n", "n": 25 },
    "trigger": { "kind": "every_n_messages", "n": 8 }
  },

  "defaultPromptTemplate": "{{prompt}}",

  "defaultConfig": {
    "name":  "main",
    "model": { "providerId": "openai", "modelId": "gpt-4o-mini" },
    "prompt": "<starter prompt — see below>"
  }
}
```

### Config shape

```ts
interface SummarizerConfig {
  /** Token name. Used in `{{summary:NAME}}` AND in `since_summarizer: NAME`
   *  history mode. Free-form, lowercase + underscores by convention.
   *  Unique per agent (validator enforces). */
  name: string;
  /** Synthesis prompt. Mention-aware; standard tokens available
   *  (`@memory`, `!thinking`, `#parameters`, `^persona`, `*dynamic`,
   *  `/summary` to reference other summarizers). */
  prompt: string;
  model: ModelRef;
}
```

There's no `displayName` — the chain card uses `config.name` (the
token name itself), since seeing the token at a glance is what the
author needs.

### Output shape

Each run writes one slot in `brain.summary`:

```ts
interface Brain {
  memory:   { [domain: string]: Record<string, any> };
  thinking: { [domain: string]: Record<string, any> };
  summary: {                                                    // NEW
    [name: string]: {
      text:      string;   // the synthesis (rolling = replace)
      watermark: number;   // highest message index consumed this run
      ranAt:     number;   // epoch ms — for the brain viewer
    };
  };
}
```

Writes are **rolling-replace**: each run overwrites the slot (same
contract we just locked in for Thinker / Field Interviewer thinking
domains).

**Watermark = highest message index** the run included in its history
slice. Examples:

| Conversation has | History mode | Watermark |
|---|---|---|
| 50 messages | `all` | 50 |
| 50 messages | `last_n: 10` | 50 |
| 50 messages, last transition at msg 30 | `since_transition` | 50 |
| 50 messages, summarizer X last fired with watermark 30 | `since_summarizer: X` | 50 |

The watermark is *always* the highest index in the slice the
summarizer read, regardless of how the slice was defined.

### Starter prompt

```
{{persona}}

You are summarising a conversation so that other parts of the system
can work with a compact view of what's happened.

What you know:
{{memory}}

Style:
- Bullet structure when the chat has multiple distinct threads;
  paragraph when it has one continuous arc.
- Keep declared intents, decisions, named entities, and unresolved
  questions. Drop greetings, repetition, mid-stream corrections.
- 6–12 lines target. Hard cap 25 lines.
- Refer to the user as "the user". Refer to the assistant as "the agent".

Return a JSON object: { "text": "<your synthesis>" }

Output JSON only — no preamble, no markdown fences.
```

The server reads `parsed.text` and writes it to
`brain.summary[name].text`. The watermark is computed by the runner
from the message slice that was passed in — not from the LLM output.

---

## History modes (refactored — touches every addon)

Today `AddonContext.history` is one of `{ mode: 'none' | 'last_n', n? }`.
We extend it:

```ts
type HistoryMode =
  | { mode: 'none' }
  | { mode: 'all' }                                  // NEW — full conversation
  | { mode: 'last_n'; n: number }                    // existing
  | { mode: 'since_transition' }                     // NEW — since last crew change
  | { mode: 'since_summarizer'; summarizerName: string };  // NEW — since watermark
```

All four modes apply to **every** addon, not just summarizers. A
blocking Thinker can read `since_summarizer: main` to see only the
new messages a checkpoint hasn't covered yet.

**Resolution rules:**

| Mode | Slice |
|---|---|
| `none` | `[]` |
| `all` | every message in the conversation |
| `last_n: N` | last N messages by index |
| `since_transition` | messages with index > last crew-transition index; falls back to `all` if no transition yet |
| `since_summarizer: NAME` | messages with index > `brain.summary[NAME].watermark`; falls back to `all` if the summarizer has never fired (or no longer exists) |

The fallback rule for unknown / never-fired summarizers means
authoring a `since_summarizer` reference doesn't crash the runtime
when the referenced summarizer is missing — the addon just sees
everything until the summarizer catches up.

---

## Picker integration

`{{summary:NAME}}` lives in the same mention picker every other token
uses. The author types `/` (or `{{`) and the picker exposes a
"Summary" group:

- One "All summaries" entry → `{{summary}}` (joins every summarizer's
  text under `## Summary` with `### NAME` blocks per slot).
- One entry per declared summarizer → `{{summary:NAME}}`. The
  description shows `name`, the current trigger summary, and watermark.

Sigil: TBD. The author cares about discoverability via `/`, which is
already universal. A dedicated `%` sigil is nice-to-have but not load-
bearing — if anything we can lump summaries under the `@` (memory)
group as a subgroup, since semantically a summary IS a synthesised
memory blob. Final call when we wire the picker.

History-mode picker also needs to surface declared summarizers:
the `since_summarizer: NAME` option in the history-mode dropdown of
every addon lists each summarizer in the agent.

---

## UI

### Where you author summarizers

Like any other addon: drag the **Summarizer** plugin from the picker
into the **Offline** lane of any crew (or the agent cortex), open the
modal, set name + prompt + model + trigger + history.

No separate "Summary" page on the agent. The offline lane is the
home.

### Where you see the output

**Brain runtime viewer** — the existing panel that shows fields, DC
hits, and thinking domains gains a **Summarizers** section. Each row:

- Name + the current `every_n_messages: 8 · last fired at message 32`
  trigger / watermark summary.
- Collapsed text body; expand to read.
- "Force run now" button (dev only) — manually triggers the addon
  without waiting for the natural trigger.

The brain viewer is where authors will look first; no need to mint a
second surface.

### Chain card

The Offline lane card for a Summarizer shows:

- Icon (📝), name (the `config.name` token), trigger summary.
- Like every other card — same drag, same modal-on-click semantics.

---

## Server runtime sketch

### Files

```
aspect-agent-server/
  builder/
    addons/
      summarizer.addon.json              ← descriptor
    plugins/
      summarizer/
        addon.summarizer.js              ← plugin run() — reads history slice, calls LLM,
                                            writes { text, watermark, ranAt } to brain.summary[name]
    runtime/
      offlineScheduler.js                ← evaluates triggers per turn, dispatches
      historyService.js                  ← extend with `all` / `since_transition` /
                                            `since_summarizer` resolvers
      builderMemory.js                   ← add SECTION_SUMMARY + applyWrites support for it
      promptAssembler.js                 ← {{summary}} + {{summary:NAME}} substitution
      BuilderRunner.js                   ← hook offlineScheduler after message.done
    types/index.ts                       ← Brain.summary, SummarizerConfig,
                                            extended HistoryMode + OfflineTrigger
    promptPlaceholders.json              ← register the new tokens
```

### Brain blob changes

```js
// builderMemory.js
const SECTION_SUMMARY = 'summary';
// normalizeBlob: tolerate missing summary key, treat as {}.
// applyWrites: writes with `kind: 'summary'` land in this section keyed by `name`
//   (not domain — summary is a single-key-per-name structure, no domain layer).
```

### Assembler changes

```js
// promptAssembler.js — substitute order stays:
//   {{prompt}} → sections → parameterised
template = template.replace('{{summary}}', renderAllSummaries(brain.summary));
template = template.replace(/\{\{summary:([\w-]+)\}\}/g,
  (_, name) => brain.summary?.[name]?.text ?? '');
```

`renderAllSummaries` produces:

```
## Summary

### main
<text>

### onboarding_checkpoint
<text>
```

### Scheduler shape

```js
// offlineScheduler.js
async function evaluateAndDispatch({ agentDoc, conversationId, turnInfo, emit }) {
  const offlineAddons = collectOfflineAddons(agentDoc);   // walks cortex + every crew
  const triggered = [];
  for (const { instance, owner } of offlineAddons) {
    if (await shouldFire(instance, conversationId, turnInfo)) {
      triggered.push({ instance, owner });
    }
  }
  // Parallel — order between offline addons in the same turn is unspecified.
  await Promise.all(triggered.map(t => runOfflineAddon(t, emit)));
}
```

Counter state for `every_n_messages` lives in `context_data` at
conversation scope, keyed by `(conversationId, instanceId)`.

For `since_transition`: the historyService needs to know "what was
the index of the last crew transition in this conversation." We
already persist transitions in `messages` metadata — add a query.

For `since_summarizer`: the historyService reads
`brain.summary[name].watermark` and filters messages with `index >
watermark`.

### History mode resolvers

Today `historyService.loadHistory` accepts `historyMode`. Extend it:

```js
switch (historyMode.mode) {
  case 'none':              return [];
  case 'all':               return allMessages(conversationId);
  case 'last_n':            return lastN(conversationId, historyMode.n);
  case 'since_transition':  return sinceLastTransition(conversationId);
  case 'since_summarizer':  return sinceWatermark(conversationId,
                              brain.summary?.[historyMode.summarizerName]?.watermark ?? 0);
}
```

### SSE events

Reuse the standard addon events:

```
addon.start       { instanceId, pluginId, lane: 'offline' }
addon.completed   { instanceId, pluginId, durationMs, tokens }
addon.error       { instanceId, error }
```

For the brain viewer's live updates, a `brain.updated` event already
exists (used by fields / thinking). It fires when `summary` changes
too — no new event type needed.

---

## Examples

### Example 1 — single rolling summary on the main crew

Crew "general" gets a Summarizer on its offline lane:

- `config.name`: `main`
- `context.trigger`: `{ kind: 'every_n_messages', n: 8 }`
- `context.history`: `{ mode: 'all' }`
- Prompt: the starter prompt.

Then the crew's Thinker is configured:

- `context.history`: `{ mode: 'since_summarizer', summarizerName: 'main' }`
- Prompt includes `{{summary:main}}` for the long-term context plus
  the raw recent messages from `historyMessages`.

Result: every 8 turns the summary refreshes; the Thinker always sees
the summary + the handful of messages added since the last refresh.

### Example 2 — handoff between crews

Two crews: `onboarding` and `support`. A Summarizer sits on the
agent cortex (not in either crew) so it runs across both:

- `config.name`: `customer_state`
- `context.trigger`: `{ kind: 'on_transition' }`
- `context.history`: `{ mode: 'all' }`
- Prompt asks the LLM to capture: stated needs, blockers, agreed
  next steps.

The `support` crew's Talker prompt references `{{summary:customer_state}}`
near the top. When the user transitions from onboarding to support,
the summarizer fires; the support crew's first response opens with
full context without re-asking anything.

### Example 3 — chained summaries

`coarse` summarizer runs every 20 messages, reads `all`.
`fine` summarizer runs every 5 messages, reads `since_summarizer: coarse`.

The `fine` checkpoint captures recent state cheaply; the `coarse`
checkpoint captures long-arc state at lower cadence. A Talker can
reference both: `{{summary:coarse}}` for the arc, `{{summary:fine}}`
for the immediate.

No special chaining mechanism is required — `fine` just uses the
history mode that points at `coarse`'s watermark.

---

## Locked decisions

1. **Summarizer is an offline-lane addon.** Not a standalone agent
   config surface. Same authoring flow as every other addon.
2. **Offline lane gets a generic `trigger` config.** Shared by every
   offline addon today and in the future.
3. **Offline addons run after the reply, in parallel.** Never block
   the user-facing response. No ordering guarantees between offline
   addons triggered in the same turn.
4. **Per conversation.** Trigger counters AND output blobs are
   per-conversation. Cross-conversation accumulation is out of scope.
5. **Free-form `name`.** The author picks it; it's the token name AND
   the history-mode reference. Validator enforces uniqueness per
   agent.
6. **One trigger per addon.** Want both "every 5 steps" and "after
   transition"? Make two summarizers — they're cheap.
7. **Rolling replace.** Each run overwrites
   `brain.summary[name]`. No append-only history log in v1.
8. **Watermark = highest message index consumed in the run.**
   Same regardless of which history mode the summarizer used.
9. **Fallback when `since_summarizer` references a missing summarizer:**
   read `all`. No crash, no error — graceful degradation.
10. **Counter does NOT reset on crew transitions.** Per-crew cadence
    is what placing the summarizer on a specific crew's offline lane
    is for.

---

## Implementation phases

### Phase 1 — bare runtime (no offline UI yet)

Goal: prove the pipeline end-to-end via hand-edited agent bodies.

- [ ] Types: add `Brain.summary`, `SummarizerConfig`, extended
      `HistoryMode`, `OfflineTrigger`.
- [ ] `builderMemory.js`: `SECTION_SUMMARY` + `applyWrites` handles
      `kind: 'summary'` writes.
- [ ] `historyService.js`: implement `all`, `since_transition`,
      `since_summarizer` resolvers.
- [ ] `promptAssembler.js`: substitute `{{summary}}` and
      `{{summary:NAME}}`.
- [ ] `promptPlaceholders.json`: register the new tokens.
- [ ] `summarizer.addon.json` descriptor.
- [ ] `addon.summarizer.js` plugin runner — reads history slice,
      calls LLM, writes brain, computes watermark.
- [ ] `offlineScheduler.js` — evaluates triggers after
      `message.done`, runs offline addons in parallel.
- [ ] `BuilderRunner.js` — invoke the offline scheduler at the end
      of each turn.
- [ ] Hand-edit an agent body to add a Summarizer on a crew's
      `offline` lane; verify it fires every N messages, brain
      gains the summary, a downstream Thinker reading
      `since_summarizer: NAME` sees the right messages.

### Phase 2 — offline lane in the builder UI

- [ ] Enable the offline lane in `ChainCanvas` (currently `enabled:
      false`). Lane-rendering tweak: no arrows between offline
      addons since they don't pipeline.
- [ ] Trigger config UI — a small section in AddonModal shown only
      when the addon's `defaultLane === 'offline'` (or when the
      user explicitly moves an instance to the offline lane).
- [ ] Summarizer config component (Name + Prompt + Model — minimal,
      mirrors Thinker).
- [ ] Mention picker: surface `{{summary}}` / `{{summary:NAME}}`
      under `/` and (optionally) a sigil.
- [ ] History-mode picker: surface `since_summarizer: NAME` per
      declared summarizer.

### Phase 3 — brain runtime viewer

- [ ] Add a Summarizers section to the existing brain viewer.
- [ ] Per-row: name, trigger summary, watermark, last-fired
      timestamp, collapsible text.
- [ ] "Force run now" dev button.

### Phase 4 — Alfred awareness

- [ ] `bodyValidator.js` — `validateSummarizers(agentBody)` checks
      name uniqueness and `since_summarizer` references resolve.
- [ ] Alfred system prompt paragraph explaining the offline lane
      and the `since_summarizer` history mode.

---

## Open items (small)

- **Sigil for the picker.** `%` was the original suggestion. Could
  instead go under the existing `@` group as a `Summaries` subgroup.
  Decide when wiring `useMentionOptions.ts`.
- **`since_transition` semantics when chaining crews.** Does a sub-
  transition count, or only top-level crew changes? Current
  assumption: any transition emitted in the conversation. Revisit
  if confusion comes up.
- **What if `every_n_messages: N` triggers on the SAME turn as a
  transition?** Both triggers can fire on different summarizers in
  the same turn; they run in parallel; no special interaction.
- **Multi-conversation accumulation.** Decision 4 says we don't ship
  this in v1. If a use case shows up later, add a `persistence:
  'conversation' | 'user'` field to the descriptor — no migration
  required because the default is conversation.
