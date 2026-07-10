# Builder V2 — Live Brain (Spec, minimal)

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first, plus
> [BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md) (addon envelope) and
> [LYBI_LIVE_CHAT_PLAN.md](./LYBI_LIVE_CHAT_PLAN.md) (the customer chat that
> hosts the panel).
>
> **Status:** design agreed, not built. Deliberately minimal — v1 only.

---

## What it is

The customer-facing chat (`/:agent/live`) has a **Live Brain** side panel that
is a placeholder today ([SidePanel.tsx](../../../aspect-react-client/src/live-chat/components/SidePanel.tsx),
`which="brain"`). This makes it a **configurable page of panels**, authored in
the builder on a new Live Brain setup page.

The point: a *wow* surface that shows the business (and the end customer) **why
the agent did what it did** — strategy, goals, emotional read, live numbers —
and it's fully WYSIWYG, like everything else in the platform.

**Additive. No existing agent is affected** — no config → the panel keeps its
current neutral empty state.

---

## The spine

A Live Brain is a list of **panels**. A panel is a **title + one content
source**. A source is one of two kinds:

```ts
interface LiveBrainDef { panels: BrainPanel[]; }

interface BrainPanel {
  id: ID;
  title: string;
  icon?: string;
  source: BindSource | AddonSource;
}

// (1) Bind — render an existing brain token. NO compute. Reuses whatever a
//     Thinker/Extractor already wrote. Cheapest path; use it whenever the
//     value already exists in the brain.
interface BindSource {
  kind: 'bind';
  token: string;                 // e.g. "{{field:strategy}}", "{{summary:main}}", "{{memory:profile}}"
  render: 'text' | 'markdown' | 'keyvalue';
}

// (2) Addon — a dedicated Live-Brain addon computes the content.
interface AddonSource {
  kind: 'addon';
  addon: LiveBrainAddon;
}
```

Stored on `AgentDoc.liveBrain?: LiveBrainDef` — a new optional key, same
additive pattern as `dynamicContexts?` / `enums` / `tags`.

**Why two kinds.** The downside of "every panel is an addon" is duplicate
work: if `strategy` already exists from a Thinker, we'd re-run an LLM to get
it. `bind` avoids that — point a panel at the existing field. Only reach for
`addon` when there's no existing value to lean on, or the panel needs its own
fresh reasoning / rich HTML.

---

## The Live-Brain addon

**It is a normal addon** and reuses the *entire* addon envelope — nothing
dropped:

- Model picker.
- Prompt editor: `MentionTextarea` with every sigil/token
  (`{{field}} {{memory}} {{summary}} {{dc}} {{tag}} {{param}} {{persona}}` …),
  `/` picker, snippets, prompt-template preview.
- `AddonContext`: history mode (`none` / `last_n` / `full` / `since_*`),
  persona toggle, memory-domain reads.

It differs from a chat addon in three ways:

1. **Always non-blocking** — never on the reply path (see Lanes below).
2. **Its "when" is a trigger** — `message_done` (default) · `every_n_messages`
   · `field_set:<name>` · `client_event:refresh`. (Time/cron triggers are out
   of v1 — they need a background worker that doesn't exist yet.)
3. **Output is a panel payload**, not a chat reply. Two output modes:

```ts
interface LiveBrainAddon extends /* the shared addon envelope */ {
  output: TextOutput | HtmlOutput;
}

interface TextOutput { mode: 'text'; }          // LLM returns text/markdown, rendered as-is

interface HtmlOutput {
  mode: 'html';
  template: string;                              // author-approved static HTML with {{slot}}s
  schema: SlotDef[];                             // the value contract (below)
  fillPrompt: string;                            // runtime instructions: "return exactly this JSON"
}

interface SlotDef {
  name: string;                                  // matches a {{slot}} in template
  type: 'string' | 'int' | 'enum';
  description: string;
  enumValues?: string[];
  fallback: string;                              // shown when the value is missing/invalid
}
```

Runtime writes the panel's result to a dedicated brain slot,
`brain.panels[panelId]` (rolling-replace): `{ text?, values?, ranAt }`.

---

## Rich HTML — two phases

The safety story. **Never let an LLM emit HTML at runtime.** The LLM only ever
fills a typed form; the HTML is fixed and author-approved.

### Design-time (builder, once, iterative)

The author describes the panel → a generator (Claude) returns **three things in
one pass**:

1. **`template`** — HTML with named `{{slot}}` placeholders.
2. **`schema`** — the slot list (name, type, description, enum?, fallback).
3. **`fillPrompt`** — derived from the schema; the runtime instruction that says
   "return exactly this JSON, these keys only."

A **live preview** renders the template with sample values. The author
**iterates on the same panel** — "make the bar taller", "add a trend arrow" —
which regenerates template + schema + fillPrompt, keeping the schema stable
where it can. Save when it looks right → the three fields land on the panel.

### Runtime (per conversation, on the trigger)

1. The addon runs `fillPrompt` through the normal envelope (history / memory /
   tokens / model) → LLM returns JSON.
2. Server **validates JSON against `schema`** — unknown keys dropped, missing/
   wrong-typed slots replaced by the slot's `fallback`.
3. **Deterministic inject**: values are HTML-escaped and substituted into the
   template's text/class slots. No markup from the model ever reaches the DOM.
4. Store `{ values, ranAt }` in `brain.panels[panelId]`.

A malformed model response can, at worst, show fallbacks — it can never break
the layout, inject script, or fight the theme.

---

## Rendering (client)

- The Live Brain page reads `agent.liveBrain.panels` (config) + the live
  `brain.panels` values.
- **bind / text panels**: resolve the token/text server-side (reuse
  `promptAssembler`'s resolvers — the client preview can't resolve live values
  on its own) and hand back a string.
- **html panels**: the client injects the validated `values` into the saved
  `template` (sanitized).
- **Live update**: subscribe to the SSE the runtime already emits
  (`addon.output` / a `panels.updated` event) and re-render only changed panels.
- **Refresh button** on the panel fires `client_event:refresh` → re-runs the
  panels' addons off the reply path.

---

## Lanes cleanup (non-breaking, enables the trigger model)

Today the schema has three lanes; `background` is **dead code** (no runtime
path ever selects it). Collapse to two:

- **blocking** (today's `main`) — the reply path.
- **non-blocking** (today's `offline`) — carries a `trigger`. Live-Brain addons
  live here.

Idempotent load-migration maps `main→blocking`, `offline→non-blocking`,
`background→non-blocking`; runtime keeps accepting the old values during the
transition. Existing agents run unchanged.

The trigger union extends the existing one (`every_n_messages`,
`on_transition`) with **`field_set:<name>`** and **`client_event:<name>`** —
both fire synchronously (a field-set happens inside a turn; a client event is
its own request), so **no background worker is needed** for v1.

---

## Setup page (builder)

New route `/:agent/builder/live-brain`.

- Reorderable list of panels + live preview of the whole page.
- **Add panel** → choose source kind.
- **Edit panel** (modal): title, icon, source.
  - `bind`: single-token picker + `render` mode.
  - `addon · text`: the full addon config (prompt / model / context / trigger).
  - `addon · html`: the same addon config **plus** the design-time generator/
    iteration surface (describe → generate → preview → refine → save).

---

## Files (where work lands)

| Area | File(s) |
|---|---|
| Types (client + server mirror) | `builder/types/index.ts` — `LiveBrainDef`, `BrainPanel`, `LiveBrainAddon`, `SlotDef`; extend `OfflineTrigger`; lane rename |
| Brain slot | `builder/runtime/builderMemory.js` — `panels` section + `applyWrites` |
| Runtime | `builder/runtime/BuilderRunner.js` / `offlineDispatcher.js` — non-blocking dispatch, `field_set` + `client_event` triggers |
| HTML validate + inject | new `builder/runtime/panelRenderer.js` (schema validate, escape, inject) |
| Generator | new endpoint under `alfred/` (design-time template+schema+fillPrompt) |
| Resolve for client | extend `GET /:slug/conversations/:convId/memory` (or a `.../live-brain` resolve endpoint) |
| Client — customer | `aspect-react-client/src/live-chat/components/SidePanel.tsx` → real panel renderer + `LiveBrainPanel` components |
| Client — builder | new `aspect-react-client/src/builder/components/LiveBrainScreen/` |

---

## Non-goals (v1)

- Time / cron triggers (need a background worker).
- Any LLM-authored HTML at runtime.
- Per-panel versioning (agent versioning covers it).
- Interactive controls inside a panel beyond the single Refresh event.
