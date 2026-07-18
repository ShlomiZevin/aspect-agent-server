# Builder V2 — Live Brain (Spec, minimal)

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first, plus
> [BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md) (addon envelope) and
> [LYBI_LIVE_CHAT_PLAN.md](./LYBI_LIVE_CHAT_PLAN.md) (the customer chat that
> hosts the panel).
>
> **Status:** **Phase 1 (authoring UI) + Phase 2 (server runtime) built** —
> 2026-07. Phase 1: the authoring screen, `agent.liveBrain` config
> (versioned on the agent body), built-in renderers, live preview. Phase 2:
> panels now compute during a chat — text panels resolve their tokens every
> turn, AI panels run on their cadence via the non-blocking addon path and
> write to `brain.panels`; a bad/misshapen answer clears the slot so the
> panel hides; runs are tagged `pluginId: 'live-brain-panel'` and logged to
> `addon_runs` + `llm_usage`. Resolved panels are served by
> `GET /api/agents/:slug/conversations/:convId/live-brain`.
> **Phase 3 (render on the customer surface + builder run inspector) is
> built too.** Everything typechecks / builds / loads; a live end-to-end
> smoke test (running server + DB + LLM) is the remaining verification.

### Phase 3 — what shipped (client)
- Customer `/:agent/live`: `SidePanel` (brain) now renders the real panels via
  `components/BrainPanels.tsx` + `useLiveBrain.ts` — fetches on load, refetches
  after each turn, has a Refresh button. Runs the same version as the chat
  (published).
- Builder `LiveBrainScreen`: the preview shows **live values** (joined by panel
  id, "● live" chip) for the current preview conversation, plus a **run
  inspector** (which panel ran · duration · model · input prompt · output),
  fetched from the endpoints below.
- `builderApi.ts`: `fetchLiveBrain`, `fetchLiveBrainValues`, `fetchLiveBrainRuns`.
- Server: `GET .../memory` now also returns raw `panels`; new
  `GET .../live-brain/runs` (recent `live-brain-panel` runs, newest first).

### Phase 2 — what shipped (server)
- `builderMemory.js` — new `panels` brain section (flat `{ [panelId]: entry }`),
  `applyWrites` `kind:'panel'` (set / clear), `getPanel` / `listPanels`.
- `runtime/panelShapes.js` — strict validator per render type (bad shape → null → hide).
- `plugins/liveBrainPanel/addon.liveBrainPanel.js` — internal plugin: LLM call →
  validate → write/clear the slot. No client mirror / no Alfred descriptor.
- `runtime/liveBrainDispatcher.js` — resolves text panels + cadence-gates AI panels,
  reusing `promptAssembler`, `offlineTriggerState`, and `addonRunner`.
- `BuilderRunner.js` — invokes the dispatcher after the offline lane.
- `runtimeRoute.js` — `GET .../live-brain` (filter → hide, read `brain.panels`).

## Smoke test (quick end-to-end check)

A shallow "does it actually work" run — drive the feature once, top to bottom.

1. **Start it up** — server (`cd aspect-agent-server && npm start`, with LLM API
   keys set) + client (`cd aspect-react-client && npm run dev`).
2. **Author 2 panels** — in the builder, open an agent → **Live Brain**. Add:
   - a **Text** panel (plain text, or a `{{field:…}}` token);
   - an **AI** panel — render **Bars**, prompt e.g. *"rate the user's mood as
     calm / anxious / hopeful, 0–100"*, **Runs: every 1 message**.
   Then **Save → Set Active → Publish**.
3. **Chat** — in the User Chat (right), send a couple of messages.
4. **Watch it fill (builder)** — the Live Brain preview flips to **"● live"** and
   shows real values; the **run inspector** lists the AI run — open it for the
   input prompt + output.
5. **Customer view** — open **`/<agent>/live`**, open the brain panel: panels
   render; send a message → they update; **Refresh** works.
6. **Usage** — the LLM usage dashboard shows the run tagged **`live-brain-panel`**.
7. **Negative check** — make an AI panel return junk for its shape → that panel
   simply **doesn't appear** (the "bad answer hides it" rule).

Two gotchas: the **customer** surface uses the **published** version (so Publish),
while the builder preview reflects your working copy.

---

## Final decisions (v1)

- **Where:** a separate URL inside the builder — **`/:agent/builder/live-brain`**
  (same agent JSON + same components, so `bind` sees your fields and the
  prompt editor's `/` tokens + field-rename cascade work). Not a separate app.
- **Scope:** agent-level, applies to all crews. Crew-level override/append is later.
- **Sources:** `bind` (a token) and `prompt` (a non-blocking addon that computes),
  authored with the same `MentionTextarea` + `ModelPicker` as every other addon.
- **Rich content:** a **built-in renderer library** — `text` · `markdown` ·
  `keyvalue` · `goals` · `bars` · `donut`. Each has a FIXED data shape, so a
  prompt source is just told to return that shape. **Custom HTML / a design
  builder + a saved-designs Repository are deferred** (the "how do we know what
  to return" problem is dodged entirely by fixed shapes).
- **Storage:** `agent.liveBrain` inside the versioned agent body. Free field
  sharing, drafts, versions, publish-to-active. Nothing external. Runtime output
  (`brain.panels` + `addon_runs`) is per-conversation like all addon output.
- **Run visibility:** shown in the Live Brain builder's **run inspector**, next
  to the customer preview — **never** in the chat transcript.
- **Naming:** customer-facing stays "Live Brain"; the builder's debug snapshot
  → "Brain Inspector" (rename deferred).

### Phase 1 — what shipped
- `LiveBrainDef` / `BrainPanel` / `PanelSource` / `PanelRender` on `AgentDoc`
  (+ `AgentBody`), synced client-side. `bodyOfAgent` snapshots `liveBrain` only
  when it has panels, so existing agents never read as dirty.
- `updateAgent` accepts `liveBrain`; edits autosave + version like any agent edit.
- `LiveBrainScreen` at the route above + a "Live Brain" chip in `AgentSetupArea`.
- Six built-in renderers + a live preview (sample data) + a run-inspector placeholder.

> The sections below are the original design brief; the rich-HTML
> template machinery in them is the **deferred** path, kept for reference.
> v1 ships the built-in renderers instead.

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
