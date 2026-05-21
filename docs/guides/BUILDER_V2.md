# Builder V2 — Plugin-Based Agent Builder

> **Status:** in active development (client-side only so far). Lives at
> `/<agent>/builder` in the React app. Reuses the existing server runtime
> (dispatcher, `CrewMember` base, LLM/KB/context services). Does **not**
> use the old `agents/*.config.ts` files.
>
> **Predecessor docs:** [CREW_CHAIN_ARCHITECTURE.md](./CREW_CHAIN_ARCHITECTURE.md)
> describes the runtime architecture; this doc describes the new builder
> that configures that runtime. The mockup at
> [CrewBuilderMockupPage.tsx](../../../aspect-react-client/src/pages/CrewBuilderMockupPage.tsx)
> was the visual reference but is **not** the implementation.

---

## What this is

A new tool for defining **projects, agents, and crews** in a fully
configurable, plugin-based way. The user can:

1. Build agents through a visual builder.
2. **Talk to an AI helper** (Builder Chat) that knows the full JSON
   shape, the current document, and the spec — and proposes edits.
3. **Preview the agent live** (User Chat) inside the same screen.
4. Configure every addon (extractor, talker, future steps) as a
   separate card with its own model + prompt.

The center of gravity is **brain & memory injection**, not visual
graph flow.

---

## Goals & non-goals

**Goals**
- One central place to configure project / agent / crew, with every
  knob exposed.
- **Plugin-based** addons so we can add new step types without
  touching the builder shell.
- **JSON-first storage** — each entity is one document. Builder reads
  / writes one document at a time; no relational joins to reassemble.
- **Chat-buildable** — the entire builder is consumable by an AI
  helper because the contract is just JSON.
- **Spec at every level** so the helper knows *intent* on top of
  *implementation*, and can keep both in sync as work happens.

**Non-goals (for now)**
- Replacing the existing runtime. The server keeps using `CrewMember`
  / dispatcher; new builder configs are converted to those at load
  time later.
- Building the AI helper LLM call (Builder Chat is a shell).
- Server-side persistence. Drafts live in `localStorage` until we
  wire `/api/builder/*` endpoints.
- Project versioning. Only **agent** and **crew** are versioned.

---

## Architecture overview

```
Project
  Spec (free text)
  └── Agent
        Name, Persona, Spec, Crew membership
        Has versions  (independent of crew versions)
        └── Crew
              Name, Spec
              Has versions  (independent of agent versions)
              └── Addons[]  ← the "Cortex"
                    Each addon = one chain step (extractor, talker, ...)
                    Each carries a plugin id + a per-instance lane + config blob
```

**Three tables / collections** (planned at storage layer): `projects`,
`agents`, `crews`. Each row holds **one JSON document**. The builder
fetches/saves one document per save action — no joins.

The addon **Repository** is a separate, cross-project service (see
below).

---

## Mental model

| Concept | What it is |
|---|---|
| **Project** | The top-level container. Has a spec. No versions. |
| **Agent** | A persona + a group of crews. Has versions. |
| **Crew** | A phase of conversation. Owns a **Cortex** (chain of addons). Has versions. |
| **Cortex** | The crew's reasoning surface — its chain of addons. Renamed from "Chain Reaction". |
| **Addon** | One step in the Cortex. Backed by a registered plugin. Carries its own config (prompt, model, fields, etc.). |
| **Plugin** | A class of addon (e.g. Field Extractor, Talker). Lives in code; declares its config shape and renders its own UI. |
| **Lane** | Where an addon runs: `main` (Blocking) / `background` / `offline`. **Per-instance**, chosen by the user. Plugins only suggest a `defaultLane`. |
| **Spec** | Free-text intent doc at each level. The AI helper reads it. Editing happens in a modal opened from a 📖 button. |
| **Repository** | Cross-project store of named, shareable addon configs. Copy-on-import — no live link back. |

### Crew has **no prompt** of its own

This was a late insight that reshaped things. The crew is a thin
container; the **Talker** addon owns the response prompt. Every new
crew comes with a default Talker. To change "what the crew says",
edit the Talker's config.

---

## Data model

Lives in [aspect-react-client/src/builder/types/index.ts](../../../aspect-react-client/src/builder/types/index.ts).

```ts
ProjectDoc {
  id, name, spec,
  agents: AgentDoc[]
}

AgentDoc {
  id, slug, name, spec, persona,
  defaultCrewId?,
  crews: CrewDoc[],         // outside the version body — each crew has its own history
  versions: AgentVersion[],
  activeVersionId,
  viewingVersionId
}

AgentVersion {
  id, number, description?, createdAt,
  body: AgentBody           // name, slug, spec, persona, defaultCrewId — NOT crews
}

CrewDoc {
  id,
  // ── working copy (what the UI edits — tracks the viewing version) ──
  name, description?, spec, persona?,
  addons: AddonInstance[],
  // ── versioning ──
  versions: CrewVersion[],
  activeVersionId,        // the version the runtime uses
  viewingVersionId        // the version currently loaded in the UI
}

CrewVersion {
  id, number, description?, createdAt,
  body: CrewBody       // immutable snapshot of editable fields
}

AddonInstance {
  instanceId,
  pluginId,         // refers to a registered plugin
  lane,             // 'main' | 'background' | 'offline' — per-instance, user-chosen
  enabled,
  config,           // plugin-defined blob
  context,          // universal reading-knobs (history, persona, memoryReads)
  outputType,       // 'text-to-user' | 'json-to-memory' (extensible)
  promptTemplate    // source-of-truth prompt template string with placeholders
}

AddonContext {
  history: { mode: 'none' | 'last_n' | 'full'; n?: number },
  persona: boolean,                       // default false
  memoryReads: Array<string | null>       // domain names; null = "(no domain)"
}

FieldDef {
  id, name,
  type:   'string' | 'int' | 'enum' | 'boolean',
  source: 'explicit' | 'inferred',     // user words vs. concluded
  howToExtract: string,
  enumValues?: string[],
  domain?: string                       // optional grouping tag; blank = "(no domain)"
}

// Plugin-specific configs:
FieldExtractorConfig { prompt, model, fields: FieldDef[] }
TalkerConfig         { prompt, model }
```

**Working copy vs. version snapshots.** The top-level `CrewDoc` fields
are the *currently editable* state. `versions` is the saved history.
Edits change the working copy; the working copy is **dirty** when it
differs from the active version's body. **Save** copies working →
active version. **Save As** creates a new version from the working
copy and sets it active. **Set Active** loads a version's body into
the working copy (prompts if dirty).

---

## Plugin system

`PluginDescriptor` lives in
[registry/plugins.ts](../../../aspect-react-client/src/builder/registry/plugins.ts):

```ts
PluginDescriptor<TConfig> {
  id, name, description, icon, color,
  defaultLane,                              // suggested only
  defaultConfig: () => TConfig,
  defaultContext?: Partial<AddonContext>,   // history/persona/memoryReads defaults
  fieldMode?: 'none' | 'extractor',         // does it produce fields?
  allowedFieldSources?: FieldSource[],      // limits the Source dropdown
  speaks?: boolean,                         // produces a chat response
  ConfigComponent: (props: { config, onChange, instance, agentId, crewId }) => JSX,
  DebugComponent?: (props: { config, activity?: any[] }) => JSX   // for live preview
}
```

Plugins **self-register** via import side effect in
[plugins/index.ts](../../../aspect-react-client/src/builder/plugins/index.ts).

### Built-in plugins

| Plugin | Default lane | `fieldMode` | `allowedFieldSources` | `speaks` | Default context |
|---|---|---|---|---|---|
| **Field Extractor** | main | `extractor` | `explicit`, `inferred` | no | last 3 msgs, persona off, no memory reads |
| **Talker** | main | `none` | n/a | yes | last 5 msgs, persona off, no memory reads |

Future plugins (in the order suggested by the mockup): Strategic /
Thinker (`fieldMode: extractor`, `allowedFieldSources: ['inferred']`),
Vibe Extractor (same), Summarizer, Transitioner, Formatter.

### Provider → Model registry

Single source of truth at
[registry/providerModels.ts](../../../aspect-react-client/src/builder/registry/providerModels.ts).
Every dropdown that picks a model reads from `PROVIDERS`. Adding a
model is one entry. Shared `ModelPicker` component renders it.

Hardwired constants:
- `BUILDER_HELPER_MODEL` = Claude Sonnet 4.6 (the Builder Chat).
- `DEFAULT_FAST_MODEL` = OpenAI GPT-4o mini.
- `DEFAULT_BALANCED_MODEL` = Gemini 2.5 Flash.

---

## Fields system

Fields are **owned by Field Extractor addons** (live inside the
plugin's config). But on the UI they're surfaced at the **crew
level** because they're consumed by many downstream steps later
(memory, talker, transitioner, …).

- **Crew Fields panel** (vertical column right of the Cortex)
  aggregates fields across every Field Extractor in the crew and
  **groups them by domain**. Named domains first; **`(no domain)`**
  collapsible group at the bottom.
- Each row shows: name · type pill · source pill · extractor chip · description.
- **Add field** is available from both:
  - the Crew Fields panel (with an explicit "Extracted by" picker — always shown, even with one option, so the relationship is visible),
  - the Field Extractor's own config (locked to that extractor).
- **Edit field** opens a modal and lets you re-parent to a different extractor. If the new owner doesn't allow the field's current source (e.g. moving from Field Extractor to Vibe Extractor), the source is coerced to the new owner's default and a note explains why.

### Fields are universal

Same `FieldDef` shape regardless of which extractor produces them
(Field Extractor today, Vibe Extractor / Thinker later):

- `name` — unique within the crew. A field name is its identity.
- `type` — `string` · `int` · `enum` · `boolean`.
- `source` — `explicit` (user literally said it) or `inferred`
  (concluded from patterns). Plugin descriptors declare
  `allowedFieldSources`; the Source dropdown filters by it. Vibe
  Extractor allows only `inferred`.
- `howToExtract` — free-text intent. **Do not list enum allowed
  values here** — they're auto-injected (see prompt template below).
- `enumValues` — required for `type: 'enum'`. **System-injected** as
  part of the field schema in the runtime prompt.
- `domain` — optional grouping tag. Blank = "(no domain)" → field
  is captured to a `general` bucket at runtime, still readable,
  just not in any named group.

When the crew has zero extractors and the user adds a field, the
modal auto-creates a Field Extractor with the field inside. Done in
one mutation so there's no batched-state race.

---

## Step inputs, memory, and prompt assembly

Every addon — regardless of plugin — runs against the same input
envelope. Plugin descriptors set sensible defaults; the user adjusts
inside the envelope.

### The five reading knobs

| Knob | Values | Default |
|---|---|---|
| **Prompt** | plugin-specific free text | — |
| **Model** | provider → model from the registry | plugin-defined |
| **History** | `none` · `last N` (`n: 3 \| 5 \| 10`) · `full` | `last 5` |
| **Persona** | inject agent persona | **off** (user opts in) |
| **Memory reads** | list of domain names; `null` = "(no domain)" | empty |

KB-as-a-knob is intentionally **out** for now. A future plugin (or a
universal addition) can bring it back if needed.

Universal knobs live on **`AddonInstance.context`** so they survive
version snapshots and roundtrips through the AI helper.

### Auto-behaviours (not configurable)

Plugins that produce fields (`fieldMode: 'extractor'`) automatically
inject two extra blocks into their prompt — **the field schema and
the current values of those fields**. Not user-toggleable. Surfaced
in the Output info block with `⚙ field schema` and `⚙ current values`
chips so the user can see it's happening.

For Talker (and any future `fieldMode: 'none'` plugin), there's
nothing to auto-inject — those plugins only read what's configured.

### Prompt template lives in the JSON

To avoid client/server drift, the prompt template is stored as a
string on each `AddonInstance` (snapshotted from
`PluginDescriptor.defaultPromptTemplate` at create time). The same
string is what the server reads and substitutes at runtime — no
code-driven assembly on either side. Each instance gets its own
copy at birth and is locked to it (plugin descriptor changes don't
auto-update existing instances).

Placeholders are listed in `KNOWN_PROMPT_PLACEHOLDERS` in
[types/index.ts](../../../aspect-react-client/src/builder/types/index.ts):

| Placeholder | Substituted with |
|---|---|
| `{{prompt}}` | the user-written `config.prompt` |
| `{{persona}}` | agent persona block (empty if Context · Persona is off) |
| `{{memory}}` | `## Memory` block built from `context.memoryReads` (empty if none) |
| `{{fields_schema}}` | `## Field schema` (extractor plugins only) |
| `{{fields_current}}` | `## Already collected` JSON (extractor plugins only) |

**History is NOT a placeholder.** Every LLM provider takes the
conversation transcript as a separate parameter (`messages`,
`contents`, etc.). We model it the same way: `context.history` is
respected at runtime to slice the conversation, and the result is
sent as the LLM's message-history parameter — never interpolated
into the prompt string. The latest user message is just the most
recent turn in that list, not a separate concept.

Click **📄 Prompt template** in any addon's config modal to see the
**prompt preview** — the assembled prompt with current config values
substituted, alongside a sidebar showing the configured history
count and where the runtime messages will appear.

### Default templates per plugin

Defined in each plugin's `index.ts`. The runtime assembly slots
content into the placeholders — `{{memory}}` collapses to nothing
when no domains are selected, etc.

```
[user-written prompt]

## Field schema                    ← extractor plugins only
- name (string): The customer's first name. Capture only when they
  introduce themselves.
- age (int): Age in years.
- employment_status (enum — one of: salaried, self_employed,
  unemployed, student, retired): Employment situation, as stated.
- income_range (string): Monthly net income range as the user
  describes it.

## Already collected               ← extractor plugins only
{
  "name": "Sara",
  "age": 32,
  "employment_status": null,
  "income_range": null
}

## Memory                          ← only if memoryReads is non-empty
### customer_profile
{ "name": "Sara", "age": 32, "employment_status": null,
  "income_range": null }

### user_persona
{ "user_type": "cooperative", "mood": "engaged" }

## Persona                         ← only if persona = true
[the agent persona text]

## Conversation                    ← per the history knob
[recent turns]

## Latest user message
…
```

**Notes:**
- `## Field schema` lists each field with `(type)` and the full
  allowed set for enums in parens. The user's `howToExtract` becomes
  the description after the colon.
- `## Already collected` includes nulls — explicit gaps work better
  than absence-by-omission for the LLM.
- `## Memory` blocks are markdown headers per domain + JSON value
  maps. Trade-off: precise (no ambiguity) but token-heavy. Plugins
  could later opt into a leaner format.
- The runtime injection is **not yet implemented** — it lands when
  we wire the LLM call. The data model and UI are in place; the
  assembly is the only piece left.

### Addon config modal layout

Every addon's config screen has three stacked sections, plus a
footer button for the prompt template viewer:

```
╭──────────────────────────────────────────────╮
│  Plugin-specific (top of modal)              │
│    Model, Prompt, Fields (for extractors)    │
╰──────────────────────────────────────────────╯
╭──────────────────────────────────────────────╮
│  Context        ▸  (closed by default)       │
│    History:  [None · Last 3 · Last 5 · …]    │
│    Persona:  [ ] Inject the agent persona    │
│    Memory:   [ ] customer_profile            │
│              [ ] user_persona                │
│              ───── (subtle divider) ─────    │
│              [ ] Include ungrouped fields    │
│    Auto:     "Every field defined on this    │
│               extractor (name, type, allowed │
│               enum values, description) plus │
│               its current captured value is  │
│               appended automatically."       │
╰──────────────────────────────────────────────╯
╭──────────────────────────────────────────────╮
│  Output  ▸  (closed by default)              │
│    Type:    [💬 Text — spoken to the user ▾] │
│             (or [{ } JSON — written to       │
│              memory ▾], or other types per   │
│              the plugin's allowedOutputTypes;│
│              dropdown disabled when only one)│
╰──────────────────────────────────────────────╯

Footer: [Remove] ········ [📄 Prompt template] [⬆️ Export] [Done]
```

- Context + Output are **collapsed by default** — too much
  informative real-estate when you already know the addon.
- Context header shows a one-line summary so collapsed state is
  still informative (e.g. `last 5 msgs · persona · memory: 2/3`).
- The `(no domain)` checkbox is replaced by a quieter
  **"Include ungrouped fields"** toggle below a dashed divider —
  semantically the same thing, less visual clutter.
- **📄 Prompt template** opens the read-only viewer described
  above, showing the exact string the runtime will assemble.

---

## Versioning

**Independent histories** on agent and crew. Each has its own
`versions[]`, an **active pointer**, and a **viewing pointer**.
Project has no versions.

**Agent and crew versions are independent.** An agent version
captures the agent shell (name, slug, spec, persona,
`defaultCrewId`). Crews are NOT part of the agent body — they live
at `agent.crews` outside the version history and have their own
versioning. So promoting an agent version doesn't disrupt crew
membership or any crew's internal state, and bumping a crew version
doesn't bump the agent.

```
[v3 ▾] Tuned talker · 2h ago    ⭐ Active     [Save] [Save as…]
       (or, if viewing ≠ active: [⭐ Set as active])
```

### Active vs. Viewing — they're separate

- **Active version** (`activeVersionId`) — the version the agent
  *runs* at runtime. Only changes when the user explicitly clicks
  **⭐ Set as active**. Never changes when the user switches the
  dropdown.
- **Viewing version** (`viewingVersionId`) — what the user is
  currently editing. Switches whenever they pick a different version
  from the pill dropdown (with a dirty-confirm if there are unsaved
  changes).

The top-level `CrewDoc` fields are always the working copy of
**whichever version is being viewed**. Save / Save As affect the
viewing version. Active is a separate pointer the user opts into.

| Action | Touches viewing | Touches active | Touches working copy |
|---|---|---|---|
| Switch version via dropdown | yes | no | reload from version |
| **Save** | yes (overwrites snapshot) | no | no |
| **Save as…** | yes (new version, switch viewing) | no | no |
| **⭐ Set as active** | no | yes (pointer flip) | no |
| Edit any field | no | no | yes (becomes dirty) |

### Where the active pointer lives at runtime

Stays inside the crew row's JSON document (`crew.activeVersionId`).
The server reads that field to know which version to execute.
When we move from localStorage drafts to server tables
(`projects` / `agents` / `crews`), this pointer is part of the JSON
column on the crew row — no separate table needed.

- **Save** — overwrite the *viewing* version's snapshot with the working copy.
- **Save as…** — create a new version from the working copy, switch viewing to it.
- **Switch viewing** — pick from the dropdown. Dirty-confirm if the working copy has unsaved changes.
- **⭐ Set as active** — flip `activeVersionId` to the current viewing version. Doesn't reload anything.
- **Dirty indicator** — pill turns amber, dot appears, sidebar pill shows it too.

> **Why not per-addon versions?** Considered but rejected as
> over-engineering. The crew snapshot already captures every addon's
> config inline. The **Repository** covers the sharing use case
> without coupling addons to a separate version history.

---

## Addon Repository (mock, cross-project)

A side service holding **named, shareable addon configs**. Lives at
[state/addonLibrary.ts](../../../aspect-react-client/src/builder/state/addonLibrary.ts)
(internal name; user-facing label is "Repository").

- Single localStorage key: `builder:addonLibrary`. Cross-project by
  design — not scoped per agent.
- Seeded on first load with two examples: "Banking onboarding
  extractor" and "Warm, conversational talker".
- **Export** — any addon's config modal has an `⬆️ Export to repository`
  button. Saves the current config with a name + description. The
  Add Step picker reflects new entries immediately via subscription.
- **Import** — Add Step modal has two tabs: **Blank** and
  **Repository**. Picking a repository entry creates a fresh addon
  instance with a **deep-cloned** config. No live link, no auto-updates.
- Once imported, the addon is yours to edit freely.

The "loss" (no live updates from upstream) is the trade that makes
everything else simple — no provenance tracking, no pin/follow
decisions, no merge conflicts.

---

## UI structure

### Three-panel layout

```
┌───────────────┬─────────────────────────────────┬──────────────┐
│ Sidebar       │ Center: Canvas                  │ Chat panel   │
│ Project       │   ProjectView /                 │   Builder    │
│ Agent         │   AgentView   /                 │   Chat       │
│ Crews (with   │   CrewView (Cortex + Fields)    │      ──      │
│  version pill │                                 │   User Chat  │
│  + dirty dot) │                                 │              │
└───────────────┴─────────────────────────────────┴──────────────┘
```

### Crew view (two columns)

```
[Welcome] [v3 ▾] Initial · 3h ago        [📖 Spec] [Save] [Save as…]

┌─────────────────────────────────┬──────────────┐
│ 🧠 Cortex                       │ 📝 Fields    │
│   Blocking                      │  (vertical   │
│     [Field Extractor] → [Talker]│   sidebar)   │
│   Background  (reserved)        │              │
│   Offline     (reserved)        │              │
└─────────────────────────────────┴──────────────┘
```

- Name input **auto-sizes** to its content (`size={name.length}`) so
  pill + description sit immediately to the right.
- Description + time inline next to the pill. Save buttons + Spec
  button on the right.
- Cards in the Cortex open the plugin's `ConfigComponent` in a modal
  — followed by the universal **Context** and **Output** sections.
- Fields panel rows are vertical cards (name · pills · description),
  not horizontal rows — fits a narrow column. Rows are **grouped by
  domain**, with `(no domain)` as a collapsible group at the bottom.

### Modals over inline

A captured user preference (see
[~/.claude/projects/c--workspace-aspect/memory/feedback_modals_over_inline.md](./../../../../../Users/shazbak/.claude/projects/c--workspace-aspect/memory/feedback_modals_over_inline.md)):

- Spec editor → modal (📖 button)
- Addon config → modal (clicking a card)
- Add field / Edit field → modal
- Add step → modal with **Blank** / **Repository** tabs
- Save As → modal
- Export to repository → modal
- Helper context preview → modal
- Custom **ConfirmModal** replaces `window.confirm()` everywhere
  (imperative API: `const ok = await confirm({...})`).

### The two chats (shells only)

- **Builder Chat** — fixed to Claude Sonnet 4.6 (`BUILDER_HELPER_MODEL`).
  "Show context" button opens a modal dumping the full `ProjectDoc`
  JSON the helper would receive. UI shell only — LLM wiring not built.
- **User Chat** — tabs alongside Builder Chat. Activity strip below
  the transcript lists every addon attached to the current crew with
  status (currently always `idle`). Wiring deferred.

---

## File layout

```
aspect-react-client/src/builder/
├── BuilderApp.tsx                Root composition; wraps everything in
│                                 BuilderProvider + ConfirmProvider; lazy-loaded.
├── index.ts                      Public exports.
├── types/
│   └── index.ts                  All JSON types (ProjectDoc, AgentDoc, CrewDoc,
│                                 AddonInstance, FieldDef, CrewVersion, …).
├── state/
│   ├── BuilderContext.tsx        Single source of truth: ProjectDoc + selection
│   │                             + every mutation (incl. version actions).
│   ├── draftStorage.ts           localStorage save/load + idempotent migrations.
│   ├── useCrewFields.ts          Hook: aggregate fields across extractors +
│   │                             add/update/move/remove field operations.
│   └── addonLibrary.ts           Mock cross-project Repository (in-memory +
│                                 localStorage; seed entries; subscribe API).
├── registry/
│   ├── plugins.ts                PluginDescriptor + registry (registerPlugin,
│   │                             getPlugin, listPlugins).
│   └── providerModels.ts         PROVIDERS list + DEFAULT_* + BUILDER_HELPER_MODEL.
├── plugins/
│   ├── index.ts                  Side-effect imports register all built-in plugins.
│   ├── fieldExtractor/           Field Extractor plugin (config UI + descriptor).
│   └── talker/                   Talker plugin (config UI + descriptor).
└── components/
    ├── BuilderLayout/            Three-panel shell.
    ├── TopBar/                   Top bar with back button + Reset draft.
    ├── Sidebar/                  Project / Agent / Crew nav (with version pill).
    ├── Canvas/                   ProjectView / AgentView / CrewView.
    ├── TitleBar/                 Single-row title (name + children + Spec button).
    ├── SpecEditor/               Reusable textarea.
    ├── SpecModal/                Hosts SpecEditor in a modal (📖 button).
    ├── ChainCanvas/              The Cortex (three lanes; cards open AddonModal).
    ├── AddStepModal/             Add-step picker (Blank / Repository tabs).
    ├── AddonModal/               Hosts plugin ConfigComponent + footer actions
    │                             (Remove, Export to repository, Done).
    ├── ModelPicker/              Provider → Model dropdown (shared).
    ├── FieldsPanel/              Crew Fields panel (grouped by domain) +
    │                             AddFieldModal + FieldEditorModal + DomainInput
    │                             (autocomplete + create-on-save).
    ├── AddonContext/             Universal Context section (History / Persona /
    │                             Memory reads) inside the addon config modal.
    │                             Closed by default; summary line on header.
    ├── AddonOutput/              Universal Output block inside the addon config
    │                             modal. For extractors: Writes destinations.
    │                             For others: placeholder until plugins surface
    │                             configurable output controls. Closed by default.
    ├── PromptTemplateModal/      Read-only viewer of an addon's promptTemplate
    │                             string with placeholders highlighted + legend.
    ├── ExportToLibraryModal/     Save current addon config to the Repository.
    ├── VersionMenu/              Toolbar row: description + time + Save + Save as.
    │   └── VersionPill.tsx       Compact `v3 ▾` chip + dropdown switcher.
    ├── SaveAsModal/              Prompts for optional version description.
    ├── ContextModal/             Read-only JSON dump for the helper.
    ├── Modal/                    Reusable frame.
    ├── Confirm/                  Custom confirm (provider + useConfirm hook).
    └── ChatPanel/                Builder Chat / User Chat tabs (shells).

aspect-react-client/src/pages/
└── BuilderPage.tsx               Thin page wrapper; reads agent slug from route.

aspect-react-client/src/App.tsx
└── adds <Route path="/:agent/builder" />  (lazy-loaded)
```

---

## Migrations

Old drafts in `localStorage` are brought forward on load by
[draftStorage.ts](../../../aspect-react-client/src/builder/state/draftStorage.ts).
Migrations are idempotent and forward-only:

1. **Addon without `lane`** → set to `'main'`.
2. **Addon without `context`** → seed with the global default
   (`history: last 5`, `persona: false`, `memoryReads: []`).
3. **Addon without `promptTemplate`** → seed with a frozen copy of
   the plugin's current default template (Talker / Field Extractor).
4. **Addon with `{{history}}` or `{{user_message}}` in its template**
   → refresh from the plugin's current default. Those placeholders
   were dropped — history is now a separate runtime parameter.
5. **Addon without `outputType`** → set to `'text-to-user'` for
   Talker, `'json-to-memory'` for everyone else.
6. **Crew with `prompt` field** → fold into a new Talker addon
   (unless one already exists), drop the field.
7. **Crew without `versions[]`** → wrap current state as `v1 — Initial`,
   set `activeVersionId` and `viewingVersionId`.
8. **Crew without `viewingVersionId`** → seed with `activeVersionId`.
9. **Agent without `versions[]`** → wrap shell fields (name, slug,
   spec, persona, `defaultCrewId`) into `v1 — Initial`; set
   `activeVersionId` and `viewingVersionId`.
10. **Agent without `viewingVersionId`** → seed with `activeVersionId`.

---

## What's built

- [x] Route + three-panel layout at `/:agent/builder` (lazy-loaded).
- [x] JSON types for project / agent / crew / addon / field / version.
- [x] Central provider→model registry.
- [x] Plugin registry + contract.
- [x] Field Extractor plugin (config UI).
- [x] Talker plugin (config UI).
- [x] Spec editor at every level (modal-hosted via 📖 button).
- [x] Three-lane Cortex with lane-as-instance, Blocking active, others reserved.
- [x] Add Step modal with **Blank** / **Repository** tabs.
- [x] Crew Fields panel with always-visible "Extracted by" picker;
      vertical-column layout to the right of the Cortex.
- [x] Add Field / Edit Field / re-parent fields between extractors.
- [x] Custom ConfirmModal (no `window.confirm`).
- [x] Mock cross-project Addon Repository (export + import, seeded).
- [x] Crew versioning: working-copy + versions[] + activeVersionId,
      Save / Save As / Set Active, dirty indicator, switch-while-dirty confirm.
- [x] Local draft persistence with idempotent migrations.
- [x] Builder Chat + User Chat shells (no LLM yet).
- [x] Field `domain` (optional, autocomplete + create-on-save).
- [x] Fields panel grouped by domain (with collapsible groups; `(no domain)` at bottom).
- [x] `AddonInstance.context` envelope (history / persona / memoryReads).
- [x] Plugin descriptor `allowedFieldSources`, `fieldMode`, `speaks`, `defaultContext`.
- [x] Universal **Context** section in the addon modal (collapsible, summarises when closed; **closed by default**).
- [x] Universal **Output** section (collapsible, **closed by default**; Writes for extractors, quiet placeholder otherwise).
- [x] `(no domain)` softened — no group header in the Fields panel (just a dashed tail), and a quiet **"Include ungrouped fields"** toggle in the memory picker instead of a parenthesised checkbox.
- [x] Per-addon **`promptTemplate`** string (snapshotted from plugin default) — single source of truth for client preview and server runtime.
- [x] **📄 Prompt template** viewer (placeholders highlighted + legend).
- [x] `AddonInstance.outputType` (configurable; dropdown in Output section; plugins declare `allowedOutputTypes`).
- [x] **Prompt preview** rewrite — shows the prompt assembled with **real config values** (not placeholders); history rendered on a sidebar with the configured count, separate from the prompt string (matches how the server sends it to the LLM).
- [x] Default templates dropped `{{history}}` and `{{user_message}}` — history is a separate runtime parameter, not part of the prompt.
- [x] FieldExtractor field rows compact and inline (name + pills on one row, description on hover).
- [x] Prompt preview copy trimmed (no intro paragraph, no history sidebar prose) — just the prompt + a `History` badge.
- [x] `{{fields_schema}}` lines now include the `source` (`explicit` / `inferred`) and skip the `: <text>` suffix when `howToExtract` is empty.
- [x] Output section dropped the **Writes** line — duplicated info; visible in the fields list already.
- [x] FieldExtractor rows are now **inline-flex cards** sizing to content (flex-wrap), not full-width thin rows.
- [x] FieldExtractor **Fields section is collapsible** (caret toggle, default open); cards have eased padding/gap.
- [x] **`viewingVersionId`** on `CrewDoc`, separate from `activeVersionId`. Switching the dropdown changes viewing; **⭐ Set as active** button promotes viewing → active.
- [x] Preview `## Already collected` and `## Memory` are empty `{}` at preview time (runtime injects only fields with values).
- [x] **Agent versioning** — same active vs viewing split, same Save / Save As / ⭐ Set as active controls. `AgentBody` snapshots shell fields only; crews live outside the version body with their own independent histories.
- [x] `VersionPill` and `VersionMenu` refactored to be **entity-agnostic**, fed by either `useCrewVersion(agentId, crewId)` or `useAgentVersion(agentId)`.
- [x] Sidebar agent row shows the active version pill + dirty dot.

## What's next

1. **Agent versioning** — same pattern as crew (working copy + versions
   + active pointer). Sidebar shows agent version pill too.
2. **Wire LLM calls + runtime prompt assembly** — assemble the
   `## Field schema` / `## Already collected` / `## Memory` /
   `## Persona` / `## Conversation` / `## Latest user message`
   sections per the template above. Needs a thin server proxy for
   the Builder Chat (Claude Sonnet 4.6) and a preview endpoint for
   the User Chat.
3. **Wire the User Chat** to actually run the in-progress agent.
   Likely via existing `/api/finance-assistant/stream` with an
   `overrideCrewMember` derived from the JSON, or a new preview endpoint.
4. **Live addon-activity** in the User Chat — replace the `idle`
   placeholders with real per-turn events (what the extractor pulled,
   which fields fired, etc.). Uses each plugin's `DebugComponent`.
5. **Server-side persistence** — once the JSON shape stabilises, add
   `projects`, `agents`, `crews` tables (or document collections);
   each row holds the JSON document. Drafts in `localStorage` move
   to "unsaved server state".
6. **More plugins** — Strategic / Thinker, Vibe Extractor, Summarizer,
   Transitioner, Formatter (from the mockup). Each is a new directory
   under `plugins/` + a `registerPlugin` call.
7. **Activate Background + Offline lanes** (currently reserved /
   add-disabled). UI is already there; just flip the `enabled` flag
   in `ChainCanvas` once a plugin needs them.

---

## Backlog / Future ideas

Captured here so they don't get lost. None of these are scheduled —
just parked for when the right moment comes.

### Domains as first-class entities (settings per domain)
Today a domain is just a string tag on a field. Promote it to an
object with its own settings:

- **TTL / retention** — how long values in this domain persist.
  Options likely: per-message (ephemeral), per-conversation, per-user
  (persists across conversations), never expires. Maps onto the
  existing user-level vs. conversation-level split in
  `context.service.js`.
- **Scope / visibility** — which crews can read this domain by
  default; whether it's exposed to the runtime context API.
- **Description** — short doc so Alfred (the Builder Chat helper)
  knows what the domain is for.

Implementation sketch: `crew.domains: DomainSpec[]` (or one level up
if domains end up agent-wide), with `DomainSpec = { name, ttl,
scope, description }`. The autocomplete in Add/Edit Field becomes a
proper picker into this list.

### Show `domain` in the Field Extractor config summary
The summary list inside the Field Extractor's config modal currently
shows `name · type · source`. Add a fourth column for `domain` so
the user can see — without leaving the modal — where each field
lands in memory.

### Comments / notes on every addon (for Alfred)
Free-text "notes" field on each `AddonInstance` (alongside `config`
and `context`). Renders as a textarea in the addon modal, probably
under the plugin's own UI. The Builder Chat helper reads it as part
of its injected context so it understands the *thinking* behind each
addon — not just the configuration. Spec at project/agent/crew level
covers higher-level intent; addon notes cover the local
decision-making.

### Agent-level addons (run on every crew)
A way to say "this addon runs on every crew of this agent" without
duplicating it. Two designs we sketched, leaning toward (b):

- (a) Move the addon onto `AgentDoc` itself — separate `agentAddons`
  list — and merge into each crew at runtime.
- (b) **Keep the addon on a crew, add an `allCrews: boolean` flag**
  (or "scope: crew | agent") on `AddonInstance`. UI: a checkbox in
  the addon modal: "Run this addon on every crew in this agent."
  Cleaner — same JSON shape, no special agent-level list, easy to
  toggle.

Either way, the Cortex on each crew shows shared addons with a
distinct visual treatment (chip "shared" or a subtle border) so
users know they can't tune that card in just one crew without
detaching it first.

---

## Open questions / Deferred decisions

- **Cross-project sharing of the Repository** — currently mock-local;
  server-side later. Same JSON shape, no client changes.
- **AI helper "Execute" flow** — tool-use schema for structured edits,
  diff preview, apply button. Designed but not built.
- **Whole-crew templates in the Repository** — same idea as addon
  entries but a chain instead of one config. Easy add later.
- **Pin vs. follow-latest** for any future live references — we chose
  copy-on-import, so this is moot for the Repository. Revisit if we
  ever introduce live links.
- **Cortex Library / templates** — "Cortex" is the per-crew chain
  name; if we want a library of *whole chains*, we'll need a separate
  concept and name to avoid overloading.

---

## Decisions journal (what we changed our minds about)

This is the most useful section for picking up cold. The current
design didn't appear at once — these are the inflection points.

### 1. Storage: JSON documents, not normalised tables
We started by thinking about a relational model (rows per crew, per
addon, per field). Replaced with: each entity is **one JSON document
per row**. Three collections (`projects`, `agents`, `crews`) and a
side service for the Repository. Reason: the builder reads/saves one
document; no joins to reassemble; the AI helper's contract is just
JSON; new fields are just new keys, no migrations.

### 2. New client vs. same client
Briefly considered a separate client app. Rejected — the chat
infrastructure (`useChat`, SSE, ChatContext, message components) and
the ability to **live-preview the agent under construction** in the
same session would have to be duplicated. Lazy-loading the
`src/builder/` tree solves the bundle-size concern.

### 3. Lane was per-plugin → now per-instance
The first cut had each plugin declare its lane. The user pointed out
that the same plugin (e.g. Field Extractor) can run in different
lanes in different crews. Moved `lane` onto `AddonInstance`; plugin
keeps a `defaultLane` suggestion. The user picks by clicking `+` on
the lane they want.

### 4. Crew prompt was a top-level field → now lives in a Talker addon
The biggest reshape. Originally the crew had a `prompt: string` and
a separate addons list. The user realised the crew is just an
orchestration concept — the response prompt belongs to the **Talker**,
which is just another addon. New crews come with a default Talker.
Old `crew.prompt` is migrated into a Talker on load.

### 5. Fields visibility
Fields started inside the Field Extractor's config (vertical list of
form rows). The user said "fields are essential, surface them at the
crew level". Now: fields live in the extractor's config blob
physically, but the Crew Fields panel aggregates them with explicit
"Extracted by" labels. Always-visible extractor picker in Add Field
keeps the relationship explicit even with one option.

### 6. Fields panel position
Initially under the Cortex (full-width row). The user said "long
vertical box to the side of prompt and cortex". Now a two-column
crew layout: prompt + Cortex on the left, Fields as a vertical
column on the right. Wraps to single column under 1100px.

### 7. Modal-first for editors
After a few inline panels, the user said inline editors feel "not
saved". Standing rule going forward: heavy / multi-field / list
editing uses a modal. Browser `confirm()` is banned — we have a
custom `ConfirmModal` with `useConfirm`. Captured as a memory entry.

### 8. Versioning scope
First inclination was per-addon versions ("rollback the talker
prompt alone"). The user pulled it back — too complex for our stage.
Settled on **per-crew + per-agent** versioning, with each version
snapshotting the whole entity. Sharing happens through a separate
service: the **Repository**.

### 9. Repository: copy-on-import (not live links)
The user explicitly chose: when you pull from the Repository, you
get a **fresh copy**. No live link back, no auto-updates. The
"loss" of upstream updates is what makes everything else simple —
no provenance tracking, no pin/follow decisions, no merge logic.
"Win from all worlds without losing anything."

### 10. Naming
- "Chain Reaction" → **Cortex** (per-crew chain — fits the
  brain & memory framing).
- "Library" / "From Library" / "Export to library" → **Repository** /
  "Export to repository" (user preferred the more common term).

### 11. TitleBar layout went through three iterations
1. Spec + version on first row, save/save-as on second. Felt
   disconnected.
2. Version + description + Save all on a second row "near the name".
   Still wrong — name input had `flex: 1` and pushed pill + meta to
   the right edge.
3. **Current:** name auto-sizes via `size={name.length}` so the
   version pill sits **immediately to the right of the name**, then
   description + time, then a spacer, then Spec / Save / Save as on
   the far right. Single row that wraps gracefully when narrow.

### 12. Memory and step I/O envelope
Long brainstorm reached this model:

- **Memory = typed fields, grouped into domains.** No separate
  "freeform" memory category. The summary that a future Summarizer
  produces is just a `string` field in a `conversation` domain.
- **Reads happen at the domain level**, not per field. Picking
  `customer_profile` gives the step every field in that group.
- **Domain is optional metadata** on each field. Blank = `(no domain)`
  → goes into a `general` bucket; still readable through the
  `(no domain)` row in pickers; never grouped under a custom name.
- **Field names are unique within a crew.** Domain is a tag, not a
  scope — you can't have two fields named `name` in different
  domains.
- **The extractor LLM only sees field names.** The runtime routes
  values into memory under the field's domain. No domain ever leaks
  into the LLM prompt unless the user reads memory in a downstream
  step.

### 13. Domainless fields go to `general`, not nowhere
We allow `domain` to be blank but **don't orphan the data**. Blank
fields are captured to a runtime `general` bucket and surfaced
through the `(no domain)` row at the bottom of every memory picker.
Reading is therefore guaranteed-possible; the field never
disappears because it wasn't tagged.

### 14. Plugin-locked field sources
First version had `source` on every field as a free pick. Pointed
out: a Vibe Extractor's outputs are always `inferred` by definition
— the dropdown shouldn't even offer `explicit`. Added
`allowedFieldSources` to the plugin descriptor; the Source picker
filters by it. Re-parenting a field to a stricter owner coerces
the source to the new owner's default with a small note.

### 15. Auto-injected schema + current values for extractors
For any plugin with `fieldMode: 'extractor'`, the runtime
automatically appends two blocks to the prompt: **`## Field schema`**
(static, including enum allowed values, types, and the user's
`howToExtract` as description) and **`## Already collected`**
(JSON of current values, nulls included).

Not user-toggleable — there's no good reason to ship without them
and the failure mode if missing is the "asks for things already
known" footgun. Surfaced in the UI under **Output** as `⚙ field
schema` and `⚙ current values` chips so the user can see it.

### 16. Enum values are schema, not polish
Initial plan was to leave enum allowed values up to the user's
`howToExtract` description. Wrong — enum values are first-class
**system-injected** schema. The `howToExtract` text describes
intent; the runtime adds the allowed list automatically.

### 17. Universal Context section + Output info on every plugin
Every addon's config modal now has three stacked sections: the
plugin's own UI (top), a collapsible **Context** block with the
universal reading knobs (history / persona / memory reads), and a
read-only **Output** info block. This makes it consistent across
plugins and means a new plugin only ships its own UI — Context and
Output are free.

### 18. KB knob: dropped (for now)
The first envelope sketch included a KB toggle. Out for now —
nobody's using it in this iteration and it would force every
plugin to think about it. Easy to bring back later by adding a
`kb` field to `AddonContext`.

### 19. Persona default: OFF
Originally proposed `persona: true` by default. Flipped to **off**
— the user said opt-in is more honest. The Talker (or anyone else
that needs the persona) ticks the box.

### 20. Context + Output collapsed by default
First version opened both by default. The user pushed back: "less
informative stuff — it's good for start then just takes place once
you already know." Flipped both to **closed by default**. Headers
still summarise their state in one line so a glance is enough.

### 21. `(no domain)` softened
First version used a regular row labelled `(no domain)` everywhere
— group header in the Fields panel, parenthesised checkbox in the
memory picker, faded pill on FieldExtractor rows. The user said
"looks ugly." Now: no group header in the Fields panel (ungrouped
fields appear as a quiet tail after a dashed divider); the memory
picker has an **"Include ungrouped fields"** toggle below a divider
instead of a checkbox; the domain pill is omitted from rows when
the field has no domain.

### 22. Auto section copy
Initial chips read `⚙ field schema` + `⚙ current values`. User said
this is jargon — the user doesn't need to know the word "schema",
they need to know **the fields and their settings** are injected.
Replaced both chips with one concrete sentence describing what gets
injected (name, type, allowed enum values, description, current
value). Same content; clearer for non-technical builders.

### 23. Output is for output, not for reads
First Output section listed everything the step does — speaks,
writes, what it reads (auto + memory). User: "this is a summary of
what it does, completely off — it should be the output." Moved
the reads-related info out of Output (auto-injections went into
Context; configured memory reads were already there). Output now
shows only writes, with a placeholder when there's nothing to
configure. Configurable controls land here as plugins surface them
(e.g. future "capture response into field" for Talker, output
schema editor for Strategic).

### 24. Prompt template lives in the JSON
The user spotted the obvious risk: if the client previews one
template and the server assembles another, they drift. Solution
chosen: store the **template string** on each `AddonInstance`,
snapshotted from `PluginDescriptor.defaultPromptTemplate` at
create time. The server reads this same string. Both sides do
identical placeholder substitution. Each instance is locked to its
template at birth — plugin descriptor changes don't auto-update
existing addons. Costs a bit of storage; eliminates a whole class
of inconsistency bugs.

### 25. FieldExtractor field list now grouped by domain
The flat-list-with-pills version felt heavy and inconsistent with
the main Fields panel. Restructured to mirror the panel: named
domains as grouped sections (small header + count), ungrouped
fields as a quiet tail after a dashed divider. Rows are smaller
(tighter padding, shorter font) so the modal stays manageable when
there are many fields. Later iteration: rows went **inline single-row**
(name + pills + remove button on one line; description on hover via
tooltip) so the modal scales to many fields.

### 26. Output is configurable now — `outputType`
First version of Output was informational only. The user wanted it
to be a real configurable surface. Added `outputType: OutputType` on
`AddonInstance`, with plugins declaring `allowedOutputTypes` and a
`defaultOutputType`. The Output section renders a dropdown.

For Talker (`allowedOutputTypes: ['text-to-user']`) and Field
Extractor (`allowedOutputTypes: ['json-to-memory']`) the dropdown
is single-option-disabled today — but the shape is right for future
plugins (Strategic, Summarizer, Formatter) that have real choices.
The Writes line under it shows derived destinations when the type
is `json-to-memory`.

### 27. History is NOT in the prompt — it's a separate LLM parameter
A foundational realisation: every LLM provider takes the
conversation history as a *separate* `messages` / `contents`
parameter, not as text inside the prompt. The "latest user message"
is just the most recent turn in that list. Earlier templates had
`{{history}}` and `{{user_message}}` placeholders — wrong model,
removed.

Templates now only carry:
`{{prompt}}`, `{{persona}}`, `{{memory}}`,
`{{fields_schema}}`, `{{fields_current}}`.

History is consumed at runtime via `context.history` (`none` /
`last_n` / `full`) and sent to the LLM as the message-history
parameter. Migration: any existing template with the dropped
placeholders is refreshed from the plugin's current default.

### 28. Prompt preview shows real values + a history sidebar
First version of the prompt viewer showed the template with
placeholders highlighted. The user pushed back: the whole point of
the preview is to see what the **actual prompt** will look like,
not the template form. Rewrite:

- Main column shows the assembled prompt with placeholders
  **substituted from current config** (the user's `config.prompt`
  goes into `{{prompt}}`, the persona text gets injected when the
  toggle is on, etc.). Empty values collapse their surrounding
  blank lines so the output isn't gappy.
- Sidebar shows the configured history count
  (`describeHistory(instance)` — e.g. "Last 5 messages") plus a
  placeholder block explaining that the runtime messages appear
  there at conversation time. Reinforces visually that history is
  a separate LLM parameter.

The runtime substitution lives in
[buildPromptPreview.ts](../../../aspect-react-client/src/builder/components/PromptTemplateModal/buildPromptPreview.ts) —
client-side, mirrors what the server will do, fed by the same
template string from the JSON.

### 29. `## Already collected` / `## Memory` show only fields with values
First preview pre-filled all fields as `null`. User: "this will
confuse the LLM — 'we already collected age = null'." Runtime
contract is now: include only fields that have been captured. At
preview time we don't have live values, so both blocks render as
empty `{}` — accurate to runtime behaviour and a clear visual cue
that nothing is collected yet.

### 30. Active vs Viewing version
First crew-versioning iteration conflated "what the user is editing"
with "what the runtime uses." User pulled them apart: switching
versions from the dropdown is for **viewing / editing**; making
something **active** is a separate, deliberate action. Added
`viewingVersionId` next to `activeVersionId` on `CrewDoc`. Save
overwrites the *viewing* snapshot, never the active one. Save As
creates a new version and switches viewing to it — never active.
A new **⭐ Active** badge / **⭐ Set as active** button next to
Save / Save As is the only path that mutates `activeVersionId`.

This mirrors how production agents work: editing happens on
branches, "active" is a deliberate promotion. The server reads
`activeVersionId` only.

### 31. FieldExtractor field list got a collapsible
Once you have many fields the modal body grows long, pushing the
Output and Context sections far below. Wrapped the fields area in
the same collapsible-section pattern used by Context and Output
(caret-toggleable header), default open. Cards also got slightly
larger padding/gap to feel less squished.

### 32. Agent versioning — same shape as crew, but the body excludes crews
Symmetry of design: agents version on the same active/viewing split
as crews. The `AgentBody` snapshot covers shell fields (name, slug,
spec, persona, `defaultCrewId`) and **intentionally excludes the
crews array**. Crews are their own versioned entities with their
own histories; promoting an agent version doesn't shuffle them.

Pragmatic consequence: the `VersionPill` + `VersionMenu` components
got generalised. They now take an `EntityVersionState` props blob
produced by either `useCrewVersion(agentId, crewId)` or
`useAgentVersion(agentId)`. Same UI, two entity types, no duplicated
component code.

---

## Quick reference: build a new plugin

```ts
// plugins/strategic/StrategicConfig.tsx
export function StrategicConfigComponent({ config, onChange }: PluginConfigProps<StrategicConfig>) {
  // ...render config UI
}

// plugins/strategic/index.ts
import { registerPlugin } from '../../registry/plugins';

export const strategicPlugin: PluginDescriptor<StrategicConfig> = {
  id: 'strategic',
  name: 'Strategic',
  description: 'Analyse the conversation and decide next move.',
  icon: '🧠',
  color: '#6366f1',
  defaultLane: 'main',
  fieldMode: 'extractor',                       // produces fields (strategy schema)
  allowedFieldSources: ['inferred'],            // never explicit user words
  speaks: false,                                // doesn't talk to the user
  allowedOutputTypes: ['json-to-memory'],       // dropdown contents in Output
  defaultOutputType: 'json-to-memory',
  defaultContext: {
    history: { mode: 'last_n', n: 10 },         // wider window than a Talker
    persona: false,                             // user opts in
    memoryReads: [],                            // user opts in
  },
  defaultPromptTemplate: `{{prompt}}

{{fields_schema}}

{{fields_current}}

{{memory}}`,
  defaultConfig: () => ({ prompt: '', model: DEFAULT_BALANCED_MODEL, /* ... */ }),
  ConfigComponent: StrategicConfigComponent,
};

registerPlugin(strategicPlugin);

// plugins/index.ts
import './strategic';   // ← register on import
```

That's it. The new plugin shows up in the **Blank** tab of the Add
Step modal, can be added to any crew lane, opens its `ConfigComponent`
in a modal when clicked, and inherits all the surrounding behaviour
(version snapshots include its config, Repository export/import works,
universal **Context** + **Output** sections appear under its config,
etc.). The Output section automatically lists the writes derived from
its `fields` and shows the `⚙ field schema` + `⚙ current values`
chips because of `fieldMode: 'extractor'`.
