# Targeted KB — design notes (planned)

The current "Enum Bible" concept is graduating into a structured
knowledge base. This doc captures the brainstorm output so the spec
doesn't get lost between sessions.

> **Status**: planned, not implemented. Sibling to
> [BUILDER_V2_FIELD_TAGS.md](./BUILDER_V2_FIELD_TAGS.md).
> Authoring owner: TBD.

---

## What this is

Today's `EnumTypeDef` already supports a three-level tree:

```
EnumType (name)
├── value 1 (umbrella prompt + per-value section bodies)
├── value 2 …
└── value 3 …
```

It's been used as a vocabulary picker so far. We're now treating it
as a first-class knowledge structure with:

- A **doc-shaped reader/editor view** (the current value-list editor
  stays — same data, second renderer).
- **Tables** inside section bodies (and umbrella prompts).
- **Pinned fields** — fields whose value is set at agent-config time,
  not collected from the conversation. Lets one agent run as "Bank
  Hapoalim" vs "Bank Discount" vs "Bank Leumi" with the same chain
  and different KB context.

Differentiator vs RAG: this is **discrete + addressable + exact**
(one value selected → that branch returned wholesale). No semantic
search, no chunking. Hence "Targeted KB."

---

## Naming

| Concept | UI name | Internal type |
|---|---|---|
| Enum bible | **Targeted KB** | `EnumTypeDef` / `enum` |
| Enum field | (unchanged) field with `type: 'enum'` | FieldDef |
| Pinned enum field | **Pinned Field** | FieldDef + `source: 'pinned'` |

URL paths (`/builder/enums/...`) and tokens (`{{enum:...}}`,
`{{dc:...}}`) stay verbatim — no backwards-compatibility shims, just
a UI label change. The doc / token references in the codebase stay
on `enum` until/unless a separate rename pass is justified.

---

## 1) Tables

### Storage

**Pure-text. Markdown pipe tables embedded directly in the section
body / umbrella string.** Zero data-model change.

```
Here's the deal:

| Plan  | Fee | APR    |
|-------|----:|-------:|
| Basic | $0  | 19.9%  |
| Plus  | $5  | 16.9%  |

Choose accordingly.
```

The assembler doesn't need to know tables exist — it forwards the
section body as-is. LLMs read pipe tables natively. `{{field:foo}}`
inside a table cell still resolves (the existing `{{...}}` regex
catches it anywhere in the string).

### Editor

A large **modal** opens on click of an existing table OR when the
author presses "Insert table" in the doc-view toolbar.

Feature list = **whatever v1 dynamic-KB had, no more, no less**.
Known v1 baseline (to confirm against actual v1 code before build):

- Editable grid with cell-level click-to-edit
- Add / delete row + column
- Drag-reorder rows + columns
- Import CSV / TSV via paste
- Import XLSX via file upload (SheetJS)
- Export to CSV
- Save → serializes back to MD pipe-table at the cursor position
- Cancel → no write

**Out of scope for v1**: merged cells (not representable in MD pipe
tables anyway), table caption (unless v1 had it — confirm), column
alignment beyond what v1 used.

### Scope

**v1: enum bodies only** — section bodies + umbrella prompt. Future
expansion: snippets, personas, addon prompts. Done by opening the
same modal from those surfaces' editors — table feature is editor-
side, not enum-side.

---

## 2) Doc view

### Concept

Same data (`EnumTypeDef.values[]` + `sections[]` + `sectionTexts`),
second renderer. Authors toggle between the existing list view (best
for "compare one section across values") and the doc view (best for
"read everything about one value in context").

**No data shape changes.** Switching views shows the same content
with different chrome.

### Layout (all values stacked, doc-style)

```
# Cards                                ← KB header (read-only)

## poalim                              ← inline-rename value
   <umbrella prompt, rendered MD>

   ### credit                          ← inline-rename section
   <section body, rendered MD; tables inline>

   ### terms
   <body>

## discount
   <umbrella>
   ### credit
   <body>
   ### terms
   <body>

## leumi
   ...
```

**All declared sections are shown for every value** — even empty
ones. The doc reads as a fixed template the author fills in. Empty
bodies render as faded placeholder text ("Empty — click to add
content.") so the structure is always visible.

### Editor

WYSIWYG via **TipTap** (ProseMirror underneath). Markdown is the
round-trip format — same string in `umbrellaText` / `sectionTexts`,
the editor reads + writes it transparently.

Behaviors:
- Click any body block → block enters edit mode in place (full
  WYSIWYG, including the table modal trigger).
- Click any header (value or section name) → inline rename (cascades
  through tokens via the existing rename infrastructure).
- Right-click on value header → Add section / Rename / Delete /
  Duplicate.
- Right-click on section header → Rename / Delete (warn about per-
  value data loss) / Move up / Move down.
- Drag handles on value + section headers for reorder; edits the
  existing `values[]` / `sections[]` arrays.
- Sticky left-side TOC; click → scroll-and-focus.

### List ↔ Doc toggle

Top-right segmented control on the enum page:

```
Cards   [List | Doc]                 [+ Add value]
```

One click. URL reflects state so it's bookmarkable + survives
reload (e.g. `/enums/cards/doc` vs `/enums/cards`).

### Scope

The WYSIWYG editor lives **only in enum doc view** for v1.
Snippets, personas, addon prompts keep MentionTextarea. Expanding
scope later is a future PR; data shape stays compatible since the
underlying body is a string everywhere.

---

## 3) Pinned Fields

### Concept

A field with a pre-set value instead of one that's collected at
runtime. Use case: same agent runs as Bank Hapoalim vs Bank Discount,
swap the active value to flip the KB context.

### Data

One new `source` variant + one new optional field on `FieldDef`:

```ts
interface FieldDef {
  // existing...
  source: 'explicit' | 'inferred' | 'pinned';  // 'pinned' is new
  defaultValue?: string;                       // only used when source === 'pinned'
}
```

Everything else is identical to a regular field:
- Same agent JSON storage (`agent.fields[]`)
- Same `{{field:NAME}}` / `{{dc:NAME:SEC}}` tokens
- Same rename cascade
- Same mention picker entry

**No new top-level concept, no new entity, no new resolver.** A pin
is "a field with a default value and no collector wired to it."

Crew-scoped pins (`crew.fields[]`) are theoretically possible but
v1 defaults to **agent-scoped only** — pins are organizational by
nature.

### Runtime

At conversation start, the server walks pinned fields and seeds
`memory[domain][name] = defaultValue` for each. Token resolution
afterwards is identical to a collected field. Override flow:
writing `memory[domain][name] = <other-value>` mid-conversation
flips the active KB branch for that conversation — exactly how
existing conversation memory overrides work today.

### Authoring — two entry points, same outcome

**(a) Pinned Fields page (focused / discoverable)**

Dedicated page at `/<agent>/builder/pinned-fields` (or similar).
Layout:

```
Pinned Fields
─────────────────────────
+ Add pin

🎯  cards     (Cards KB)     → poalim      ▼
🎯  region    (Region KB)    → emea        ▼
```

`+ Add pin` opens a wizard:

1. **Pick a Targeted KB** — dropdown of `agent.enums`.
2. **Pin name** — pre-fills with the KB's slug (e.g. `cards`).
   Editable; validated against existing field names; collisions
   auto-suggest `cards_2` etc.
3. **Default value** — dropdown of the KB's values with a small
   umbrella preview per option; required.

On save → creates a FieldDef:

```ts
{
  id: <new>,
  name: "cards",
  type: "enum",
  source: "pinned",
  enumType: <CardsId>,
  defaultValue: "poalim",
  howToExtract: ""  // pinned fields have no extractor — left blank
}
```

Each row's value dropdown is the swap-value affordance for changing
the agent-wide default after creation.

**(b) Fields page (general entry point)**

Declare field → pick `type: enum + <KB>` → pick `source: pinned` →
value picker appears with KB's values → pick default → save. Same
result.

### Discoverability

- **Fields page row**: 🎯 badge on the field, source column reads
  "pinned", "extracted by" column reads "—".
- **Mention picker (`@`)**: pinned fields render with a 🎯 prefix
  (or a small "Pinned" sub-group); description line says
  `Pinned to <KB> · default: <value>` so the author knows which
  KB they're consuming. Token inserted is still `{{field:cards}}`
  — uniform with every other field.
- **Live memory (brain panel)**: pin's value displayed with the
  same 🎯 badge so testers can tell it wasn't collected.

### Mid-conversation swap

The builder chat preview header gets a row of pin chips:

```
🎯 cards: poalim ▾    🎯 region: emea ▾
```

Click → dropdown of the KB's values → swap → writes to
conversation-level memory only (the agent's default
`defaultValue` is untouched). Testers can flip "act as Hapoalim"
to "act as Discount" without leaving the chat.

Customer-facing chat: equivalent surface, scoped to debug/admin
mode. **Out of scope for this codebase** — implemented in the
customer-facing-chat session. We just need to make sure the data
is reachable: the customer chat reads `agent.fields[]` filtered
by `source === 'pinned'` to know which selectors to render.

### Multi-pin scenarios

Two pins bound to the same KB (e.g. `current_bank` and
`comparison_bank`, both → Cards) is supported — just two FieldDefs
with different names and the same `enumType`. The wizard's
auto-name uniquifier handles the conflict on the second one.

### Rename / delete

Falls out of the existing field rename cascade and field-delete
flow. Zero new cascade code. Pinned-Fields page can have its own
inline-rename + delete-confirm affordance for ergonomics, but
they call the same mutators.

---

## 4) Per-value branding (deferred)

The KB value (`EnumValueDef`) is the right home for presentation
metadata — same value carries the same brand regardless of which
pinned field references it.

```ts
interface EnumValueDef {
  // existing...
  display?: {
    label?: string;       // human label different from the canonical `value`
    logoUrl?: string;
    accentColor?: string;
  };
}
```

Pure presentation. The agent runtime / assembler ignores it. Read
by the customer-facing chat when rendering the pinned-value picker
and branding the conversation UI.

**Deferred**: per the brainstorm, while we're still in demo mode,
UI configuration lives on the customer-facing chat side, not in the
agent config. We'll lift it into `EnumValueDef.display` once we
ship to customers and need brand metadata to travel with the agent
across deployments. Until then: don't add the field.

---

## Build order

Each step independently useful and shippable:

1. **Targeted KB rename** (UI label only — chip, page title, picker
   group, doc strings). Zero data changes.
2. **Doc view** + List/Doc toggle. TipTap WYSIWYG in enum bodies
   only. No new data, just a new renderer.
3. **Tables**: pure-text MD-table storage + the large modal editor
   reachable from the doc view. v1 functional parity.
4. **Pinned Fields**: `source: 'pinned'` + `defaultValue` on
   FieldDef; Pinned Fields page + wizard; Fields-page parity; mention
   picker + brain panel badges; builder-chat-preview swap chips.

Each step picks up the cascade / token / rename infrastructure
that already exists — no new resolver, no new entity, no new
storage layer.

---

## Open questions to revisit before build

1. **Table caption** — does v1 have it? If yes, ship; if no, skip.
2. **Table column alignment** — same: only if v1 had it.
3. **Doc view persistence cadence** — debounced per-keystroke vs
   on-blur. Leaning debounced ~300ms so the editor feels alive but
   the autosave queue isn't spammed.
4. **TipTap markdown extension choice** — `tiptap-markdown` is the
   canonical, but worth a tiny spike before committing.
5. **Sections-shown-empty behavior on the LIST view** — today the
   list view only shows sections that have content for a given
   value. Should we mirror the doc-view "always show all sections"
   behavior here too, or leave the list view as-is? Probably leave
   it — list view = compact; doc view = template.
6. **Crew-scoped pinned fields** — agent-only is the v1 default.
   Confirm before build there's no organization-by-crew scenario
   that needs it.
