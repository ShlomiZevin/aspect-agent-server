# Builder V2 — Dynamic Context

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first. Read
> [BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md) for the addon contract,
> and [BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md) for JSON shapes.
> **This doc replaces the retired `BUILDER_V2_TRIGGERED_CONTEXT.md`.**

## What this is

**The deterministic alternative to KB.** Knowledge Base is vector-similarity
guessing — the LLM may or may not surface the right passage at the right
time. Dynamic Context is exact: *"when field X has value Y, render EXACTLY
this text in place of the `{{dynamic:X}}` token."* No similarity search,
no model interpretation in the routing.

Use this when you know which guidance applies under which condition and
you don't want the LLM doing the matching for you.

Examples:
- `intent == 'complaint'` → de-escalation guidance.
- `mood == 'stubborn'` → empathy-first framing.
- `tier == 'enterprise'` → escalation playbook.

## Shape

Dynamic Context is **not** an addon. It is **agent-level data** declared
on the `AgentDoc` and consumed by *any* addon's prompt via a single token.

### AgentDoc shape (excerpt)

```ts
interface AgentDoc {
  // ...
  dynamicContexts?: DynamicContextDef[];
}

interface DynamicContextDef {
  id:        ID;
  fieldId:   ID;                    // points to an enum FieldDef
  cases:     DynamicContextCase[];  // value → text
  fallback?: string;                // rendered when no case matches
}

interface DynamicContextCase {
  value: string;  // one of the field's enumValues
  text:  string;  // free text injected when value matches
}
```

The switch is keyed by **the current memory value of `fieldId`**. Only
`enum` fields are eligible (a closed set of values is required for the
switch).

### Prompt consumption

Any addon's `config.prompt` may use the token:

```
{{dynamic:NAME}}
```

…where `NAME` is the **field name** (not the DC id). The assembler:

1. Looks up the agent's `DynamicContextDef` for that field name.
2. Reads the current memory value for the field.
3. Finds the case whose `value` matches. Renders its `text`.
4. If no case matches: renders `fallback` (or empty if no fallback).

Substitution happens during `promptAssembler.assemblePrompt()` — same
pass that resolves `{{memory}}`, `{{thinking}}`, `{{field:X}}`, etc. The
runtime emits an `addon.dynamic.resolved` SSE event per substitution so
the UI can show *which* case fired this turn.

### Sigil

`*` opens the Dynamic Context picker in MentionTextarea. The picker
lists every declared DC (one row per field). Typing the field name
filters. `{{` and `/` also surface DC entries in the unified picker.

## Why no brain section?

Earlier "Triggered Context" wrote pre-scripted guidance to a `triggered`
brain section that the Talker had to opt into reading. That was an
indirection: data lives in memory → addon reads memory → emits text.
Dynamic Context skips the middleman: the *text* is the data, keyed by a
*field value*, resolved inline. No new brain section, no new addon, no
plumbing between read and consume.

## UI — promoted to a full screen (v2)

Dynamic Context is the single highest-leverage authoring surface in the
builder. The first cut was a modal. **It is being promoted to a full
screen with URL navigation** because (a) it deserves room to breathe,
(b) authors want to deep-link to a specific case, and (c) we're adding
a third hierarchy level (**sections** — see next section) that doesn't
fit a modal.

### Route + navigation

A new selection level `dynamic-context` joins the existing
`project / agent / crew`. Routes:

```
/<agent>/builder/dynamic-context
/<agent>/builder/dynamic-context/:fieldName
/<agent>/builder/dynamic-context/:fieldName/:value
/<agent>/builder/dynamic-context/:fieldName/:value/:section
```

Every level is bookmarkable and shareable. The Schema panel's 🎯
"Dynamic" chip becomes a `<Link>` to the right route.

A **breadcrumb** at the top of the screen mirrors the URL —
`Builder › Agent › Dynamic Context › mood › sad › how-to-address` —
each segment clickable.

### Two view modes — toggle in the top right

The user prefers a **tree** for everyday authoring but should be able
to switch to a **columns** layout when scanning a wide schema. Both
views are over the same data; the toggle is local UI state (no doc
mutation).

**Tree view (primary, default):**

```
mood
  ▾ sad                                            ┌──── Editor ────┐
      [umbrella prompt]            ●  ← selected   │ sad / umbrella │
      ▾ Sections                                   │                │
          how-to-address                           │ [MentionText]  │
          what-to-avoid                            │                │
          opening-line                             │                │
       + Add section                               └────────────────┘
  ▸ happy
  ▸ angry
  ↳ Fallback
intent
  ▸ ...
```

**Columns view (secondary):**

```
Fields ──────┐  Values (mood) ─┐  Sections (sad) ─┐
• mood     ● │  • sad        ● │  • [umbrella]  ● │
• intent     │  • happy        │  • how-to-address│
• tier       │  • angry        │  • what-to-avoid │
             │  ↳ fallback     │  + Add section   │
─────────────┘  ─────────────────  ─────────────────
┌───────────  Editor  ──────────────────────────────┐
│ sad ▸ umbrella prompt                              │
│ [MentionTextarea]                                  │
└────────────────────────────────────────────────────┘
```

Either view exposes the same authoring actions: rename a value inline,
add/remove a section, edit the umbrella prompt or a section body in
the right-hand editor.

### Authoring rules — unchanged from v1

- Only enum fields can host a Dynamic Context.
- Adding a value to a case **commits to the underlying field schema
  immediately** (adding a value to an enum is a field-shape change).
- Editing prompt bodies uses local draft state — saved on commit
  signals, not per keystroke.
- The full `MentionTextarea` (all sigils) is available inside every
  prompt body, so case/section text can reference memory, fields,
  parameters, or even other dynamic contexts.

---

## Third hierarchy level — **sections** (v2)

Pure switch-by-value rapidly hits a ceiling. A single value (e.g.
`mood == sad`) often needs **multiple discrete chunks of guidance for
different consumers**: "how to address the user", "what to avoid",
"opening line". One blob jammed into a single prompt loses the
ability to inject only the relevant slice into a downstream addon.

We add a third level called **sections**. The shape:

```
Field
  Value
    Umbrella prompt   (optional)
    Sections          (optional, ordered)
      name + prompt
      name + prompt
      ...
```

Both the umbrella prompt and the sections list are optional and
additive. Existing data with only `text` (umbrella) keeps working.

### Updated data shape

```ts
interface DynamicContextCase {
  value:      string;
  text?:      string;                  // umbrella prompt (was `text` in v1)
  sections?:  DynamicContextSection[]; // NEW
}

interface DynamicContextSection {
  name: string;   // snake-case, unique within the case
  text: string;
}
```

### Updated tokens

| Token | Resolves to |
|---|---|
| `{{dynamic:FIELD}}` | The **umbrella prompt** of the case matching the current value of `FIELD`. Falls back to the case's `fallback` umbrella when no case matches. |
| `{{dynamic:FIELD:SECTION}}` | The named section's body under the matching value. Empty when the matching case has no such section. |
| `{{dynamic:FIELD:*}}` | All sections under the matching value, joined under `### name` headings. The convenience "give me everything" form. |

`FIELD` is the field's `name` (not its id). `SECTION` is the section's
`name`.

### Picker integration

The `*` sigil's picker is updated to show the section level:

- Top of the list: each declared DC field (`mood`, `intent`, …) →
  inserts `{{dynamic:FIELD}}` (the umbrella).
- Indented under each: every section declared under any value of that
  field (deduped) → inserts `{{dynamic:FIELD:SECTION}}`.
- "All sections" entry under each field → inserts
  `{{dynamic:FIELD:*}}`.

The unified `{{` / `/` pickers surface the same entries.

### Migration

Pure additive — `text` stays the umbrella, `sections` defaults to
undefined/empty. No write migration needed; reads tolerate missing
`sections`. Existing `{{dynamic:FIELD}}` consumers continue to resolve
to the umbrella prompt with no behavior change.

## Migration from Triggered Context

There are no live deployments of Triggered Context. The migration was a
clean delete:

- Removed: `triggeredContext.addon.json` descriptor, server & client
  plugin folders, `TriggeredPanel` UI, `TriggeredContextConfig` types,
  the `triggered` brain section, the `{{triggered}}` token,
  `AddonContext.triggeredReads`, and all matching code paths.
- `migrateAddonContext.js` runs idempotently on read and strips any
  legacy `triggeredReads` keys it encounters.
- `builderMemory.normalizeBlob` tolerantly drops legacy `triggered` keys
  from existing memory blobs so older conversation rows still load.

If you are touching docs or code that still says "Triggered Context",
replace it with Dynamic Context (or delete entirely if it referred to
the dead plumbing).
