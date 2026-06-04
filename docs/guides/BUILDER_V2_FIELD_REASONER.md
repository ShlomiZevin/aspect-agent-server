# Builder V2 — Field Reasoner

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first. Read
> [BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md) for the addon contract,
> and [BUILDER_V2_DYNAMIC_CONTEXT.md](./BUILDER_V2_DYNAMIC_CONTEXT.md)
> for the sibling mechanism that consumes the fields this addon
> produces.
>
> **Status:** planned (decisions locked 2026-06-04). No code yet.

---

## What it is

A new extractor plugin focused on **one field, complex reasoning**.

The existing **Field Extractor** is built for breadth: many fields,
each with a one-line how-to-extract description, one prompt for the
batch. **Field Reasoner** is the opposite: a single field, a long
authored prompt that can reference other fields by mention, run by a
stronger model, with a UI that puts the field declaration and the
collection prompt in the same modal.

The problem it solves: **Dynamic Context fires on field values, and
Dynamic Context is where the agent's real personality lives.** That
makes "how the field gets its value" a first-class authoring concern.
Today the only way to do thoughtful single-field inference is to write
a long Vibe Extractor prompt; nothing about the UI guides you toward
the multi-field-reasoning pattern that pairs cleanly with DC.

Field Reasoner is the **built-in primitive** for that pattern.

---

## Mechanical differences from Field Extractor

|  | Field Extractor | Field Reasoner |
|---|---|---|
| Field count per instance | Many | **Exactly one** |
| Field declaration | Lives in Schema panel; addon references existing fields by id | **Fused into the addon modal** — declaring the field IS opening the Reasoner |
| Default lane | `main` | `main` (synchronous — DC needs the value the same turn) |
| Default model | `gpt-4o-mini` | `claude-sonnet-4-6` (the point is to actually reason) |
| Default history | `last_n: 5` | `last_n: 8` |
| Default template | Schema-driven (`{{fields_schema}}`) | Single-field-driven (`{{this_field}}` + free reasoning) |
| `{{memory}}` in default | yes | **no** (rely on field mentions; cleaner default) |

Field Extractor stays as-is for the batch case. The two coexist.

---

## The fused modal — "one place to set up a field"

The key UX shift. Today the field declaration lives in the Schema
panel (`SchemaFieldModal`); the addon references it. Field Reasoner
breaks that decoupling **on purpose**: the field declaration form is
the first Config section of the addon modal.

Save → both writes happen in one `updateAgent` / `updateCrew`
transaction:

1. The `FieldDef` is added or updated in `agent.fields[]` or
   `crew.fields[]` (per the Scope picker).
2. The `AddonInstance` of `field-reasoner` is added or updated in the
   crew's cortex, with `config.extractsField: <fieldId>` (singular —
   not the array Field Extractor uses).

Reopening the modal hydrates both halves from the document — the
FieldDef lookup uses `config.extractsField` as the key.

### Modal shape — matches the standard addon modal

Per the user's instruction "make it as close to the current addon
structure as possible". The modal uses the same frame and section
layout as every other addon (Talker, Thinker, Field Extractor). The
only addition is that the **Config** section includes a field
declaration sub-block at the top:

```
┌─ Field Reasoner ─────────────────────────────────────[×]─┐
│                                                           │
│  Name (instance):    [auto: same as field name        ]   │
│                                                           │
│  ── Config ──────────────────────────────────────────     │
│  Output field                                             │
│    Field name:   [employment_status_inferred        ]     │
│    Type:         (•) String   ( ) Enum                    │
│    ↳ Enum vals:  [salaried, self_employed, unemployed]    │
│    Scope:        (•) Agent    ( ) Crew                    │
│    Domain:       [customer            ▼]                  │
│                                                           │
│  Reasoning prompt                                         │
│    [Large MentionTextarea — defaults to the template      │
│     below. All sigils available.]                         │
│                                                           │
│  ── Context ─────────────────────────────────────────     │
│    History:  [last_n=8 ▼]                                 │
│                                                           │
│  ── Model ───────────────────────────────────────────     │
│    [claude-sonnet-4-6 ▼]                                  │
│                                                           │
│  ── Prompt template  (advanced, collapsed) ─────────      │
│                                                           │
│                       [Cancel] [Save]                     │
└───────────────────────────────────────────────────────────┘
```

The Output section is **suppressed** for this plugin (via
`hideStandardSections.output`) — Field Reasoner has exactly one output
type. The Repository section is hidden likewise: the field declaration
and the reasoning prompt are tightly bound to the agent's schema, so
saving to the repository as-is doesn't make sense.

---

## Two new prompt tokens — **extractor-only**

Both are added to
`aspect-agent-server/builder/promptPlaceholders.json` under
`extractor_only`. They render empty outside a Field Reasoner instance.

### `{{this_field}}`

Renders the **literal field name** the current Reasoner is configured
to populate.

Use case: tell the LLM what it's being asked to infer.

```
You are inferring the value of `{{this_field}}`.
```

> **Why not `{{field:X}}`?** That token resolves to the field's *value*
> (current memory state). We want the *name* — different concept,
> different token.

### `{{enum_values}}`

Renders the current `enumValues` list of the field this Reasoner
populates. Empty for non-enum fields, so prose stays clean.

This is **the answer to the "where do the allowed values live" sync
problem**: they live in one place (the FieldDef on the schema), and
the prompt pulls them via a token. Edit the values in the modal →
the token re-renders. No divergence between a structured input and
a prompt copy.

```
Allowed values: {{enum_values}}
```

### Picker integration

Both tokens appear in the unified `/` and `{{` pickers, listed under
**"Extractor-only"** alongside `{{fields_schema}}` and
`{{fields_current}}`. They are **not** surfaced under single-sigil
pickers (`@`, `!`, `#`, `^`, `*`, `%`) because they don't belong to
any of those categories — they're extractor-instance meta.

---

## Default prompt template

```
{{persona}}

You are inferring the value of `{{this_field}}`.

How to decide:
[YOUR INSTRUCTIONS — describe the reasoning. Reference other fields
 inline with @, e.g. "if @intent is complaint and @tier is enterprise,
 lean toward...". This is the heart of the addon.]

Allowed values: {{enum_values}}

Output JSON only: { "{{this_field}}": <value> }
```

Notes:
- No `{{memory}}`. Per user direction — rely on field mentions instead.
  Authors can add `@memory` back manually if they need it.
- The `@intent`-style mentions in the example resolve to
  `{{field:intent}}` in the saved template — standard mention rules.
- `{{this_field}}` appears twice on purpose: once as a label in the
  prompt and once as the JSON key. Both re-render when the field is
  renamed.

---

## Delete semantics

Per user: **deleting the addon deletes the field too.**

Rationale: the modal *created* the field as part of its setup. Field
Reasoner is the field's owner. If the user wants to keep the field
declaration but drop the reasoner, they should declare a plain
`FieldDef` in the Schema panel separately.

Confirm modal copy (mirrors the existing wired-extractor warning):

> Delete "{{this_field}}"? This will remove the field declaration AND
> the reasoner that populates it. Dynamic Context cases or prompts
> referencing this field will stop resolving.

Confirm via the standard `useConfirm` modal — never the browser
`confirm()`.

---

## Schema panel — reasoner-owned chip

Fields whose declaration was *created from* a Field Reasoner show a
chip in the Schema panel row — analogous to the existing 🎯 Dynamic
Context chip. Clicking it opens the Field Reasoner modal directly
(skipping the generic FieldDef modal). Icon: 🧠.

The row visually distinguishes:
- Plain FieldDef (no extractor) → no chip.
- Wired to a Field Extractor → existing wiring chip.
- **Created by a Field Reasoner → 🧠 chip → opens the Reasoner modal.**
- Has a Dynamic Context → 🎯 chip (independent of the others).

A field can be Reasoner-owned AND have a Dynamic Context — both chips
coexist.

---

## Server runtime sketch

> Implementation notes for the next session.

### Files

```
aspect-agent-server/builder/
  addons/
    fieldReasoner.addon.json
  plugins/
    fieldReasoner/
      addon.fieldReasoner.js          ← server run() contract
  promptPlaceholders.json             ← register {{this_field}}, {{enum_values}}
  runtime/
    promptAssembler.js                ← extractor-context aware token sub
  types/index.ts                      ← FieldReasonerConfig
```

### Descriptor sketch

```jsonc
{
  "pluginId":           "field-reasoner",
  "displayName":        "Field Reasoner",
  "description":        "Infer one field from many signals with a custom prompt.",
  "purpose":            "Reach for this when one field needs careful reasoning across multiple other signals — typically the trigger field for a Dynamic Context. Pairs naturally with DC: Reasoner produces the value, DC switches on it. Use Field Extractor instead when you need to capture many fields cheaply in one pass; use Vibe Extractor for soft signals from raw chat. The modal fuses field declaration and collection prompt — saving creates both.",
  "icon":               "🧠",
  "color":              "#7c3aed",

  "defaultLane":        "main",
  "fieldMode":          "extractor",
  "speaks":             false,

  "allowedOutputTypes": ["json-to-memory"],
  "defaultOutputType":  "json-to-memory",

  "allowedFieldSources": ["explicit", "inferred"],

  "defaultContext": {
    "history": { "mode": "last_n", "n": 8 }
  },

  "defaultPromptTemplate": "{{prompt}}",

  "defaultConfig": {
    "prompt":         "<starter template — see Default prompt template above>",
    "model":          { "providerId": "anthropic", "modelId": "claude-sonnet-4-6" },
    "extractsField":  null,
    "fieldShape": {
      "name":         "",
      "type":         "string",
      "enumValues":   [],
      "scope":        "agent",
      "domain":       null,
      "source":       "inferred",
      "howToExtract": ""
    }
  },

  "hideStandardSections": {
    "output":     true,
    "repository": true
  }
}
```

The `fieldShape` sub-blob is **the staging area for the field
declaration inside the modal**. On save the runtime/UI splits it:

- creates/updates `FieldDef` on the chosen scope's `fields[]` using
  the values in `fieldShape`;
- sets `config.extractsField = <newOrExistingFieldId>`;
- clears `fieldShape` from the persisted config (it's a UI-side
  scratchpad — the field is the source of truth post-save).

This keeps the document shape clean: at rest, a Field Reasoner
instance is just an `extractsField: ID` reference, identical in
structure to how Field Extractor references fields. The runtime
plugin doesn't need to know about `fieldShape` at all.

### Assembler changes

`promptAssembler.assemblePrompt()` needs the running plugin context to
know *which field is `this_field`*. Pass it explicitly:

```js
assemblePrompt({
  ...,
  extractorContext: instance.pluginId === 'field-reasoner'
    ? { thisFieldId: instance.config.extractsField }
    : null,
});
```

Substitution rules added:

- `{{this_field}}` → `fieldDefById(thisFieldId).name`. Empty if
  `extractorContext` is null.
- `{{enum_values}}` → `fieldDefById(thisFieldId).enumValues?.join(', ') ?? ''`.

### Validation

`bodyValidator.js` (Alfred) gains:

- A Field Reasoner instance must reference an existing FieldDef on
  the same agent (agent-scope) or its own crew (crew-scope).
- That FieldDef must be `type: 'string' | 'enum'`. (No int/boolean
  for v1.)
- If the prompt template contains `{{enum_values}}`, the referenced
  field must be `type: 'enum'`. Warn-only — the token renders empty
  for non-enum and the prompt still works.

---

## Phases

**Phase 1 — descriptor + server plugin + tokens.**
- Ship `fieldReasoner.addon.json`, the server `run()`, and the two
  new tokens. No UI yet — author can hand-edit a crew body to add the
  instance and reference an existing field by id.

**Phase 2 — client plugin + fused modal.**
- React `ConfigComponent` with the merged field declaration + prompt
  form. Save splits into FieldDef + AddonInstance writes.

**Phase 3 — Schema panel integration.**
- 🧠 chip on Reasoner-owned fields. Click → opens the Reasoner modal.
- Delete-with-field semantics + confirm copy.

**Phase 4 — Alfred awareness.**
- `validateFieldReasoners(crewBody)` checks.
- System-prompt copy: *"Reach for Field Reasoner when one field needs
  cross-signal inference; use Field Extractor for batch capture."*

---

## Open questions

1. **Crew vs agent scope at create time.** The modal lets the author
   choose, but is the default agent or crew? Default guess: **agent**
   — Reasoners are typically populating a field that drives a Dynamic
   Context, and DC lives at agent scope.
2. **Multiple Reasoners writing the same field.** Forbid. One field,
   one Reasoner. Surface as a validation error in the modal AND in
   `bodyValidator`.
3. **What happens to a Field Reasoner if the user changes its
   `extractsField` to a different field via the modal?** The previous
   field is left declared but unowned (becomes a plain FieldDef). The
   delete-with-field semantics applies only to delete — not to "swap
   to a different field".