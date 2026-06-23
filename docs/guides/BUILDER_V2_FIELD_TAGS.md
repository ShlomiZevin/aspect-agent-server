# Field Tags (planned)

Orthogonal grouping for fields. Domain is the canonical structural
bucket (e.g. `customer_profile`); a tag lets you cluster fields
across domains for ad-hoc reference (e.g. `emotional_signals`
spanning marital_status, mood, recent_loss). A field's domain
doesn't change when you tag it — the tag is just another label.

> **Status:** plan only — not yet implemented. Owner: see [BUILDER_V2.md](./BUILDER_V2.md).

---

## Token shapes (three variants, all unambiguous)

Resolved by `aspect-agent-server/builder/runtime/promptAssembler.js`,
matching the same case-sensitive identifier rules as every other
token. Walks fields in the current scope: `agent.fields` + the
active crew's `fields`. Crew-scoped fields tagged X are invisible
from other crews.

| Token | Resolves to | Example output |
|---|---|---|
| `{{tag:NAME}}` | Labeled schema block — each tagged field's `name` and `howToExtract` definition. The "what to pay attention to" form. | `marital_status — whether the user is married / single / divorced.`<br>`mood — current emotional state inferred from tone.` |
| `{{tag:NAME:values}}` | `name: value` pairs of CURRENT values, comma-separated. Name is always included so the values can't be confused. Skips fields with `null` / `undefined`. | `marital_status: married, age: 34, mood: anxious` |
| `{{tag:NAME:names}}` | Bare comma-separated field names — the variables themselves. | `marital_status, age, mood` |

A bare-value form (`{{tag:NAME:rawvalues}}`) is intentionally **not
shipped** — comma-separated values without labels are ambiguous as
soon as more than one field shares a value space (e.g. `single` —
marital status or quantity?).

Unknown / empty tag → token left in place (matches the typo-surfacing
behavior of `{{field:N}}`).

---

## Data model

```ts
// FieldDef gets an optional tags array.
interface FieldDef {
  // existing fields...
  /** Cross-domain grouping tags. Each entry is a name in
   *  `agent.tags`. Lowercased, trimmed, no spaces. Order
   *  preserved; deduped on save. */
  tags?: string[];
}

// AgentDoc gets a declared-tags registry.
interface AgentDoc {
  // existing fields...
  /** Declared tag vocabulary. Lets the UI show a tag in the
   *  picker before any field is tagged with it. At runtime a
   *  field's `tags[]` still wins — declared tags are a UX hint,
   *  not a constraint. Same shape as `domains?: string[]`. */
  tags?: string[];
}
```

Free-form: typing a new tag in the field editor adds it to
`agent.tags` automatically on save (no separate "declare tag" UI
required). The Tags page exists as the central place to rename /
delete / cross-reference tags.

No DB migration needed if both fields are stored as JSON on the
existing agent + field rows.

### Normalization

- Lowercased on save
- Trimmed
- Reject spaces (same validator as field name / domain)
- Reject empty
- Deduped within a field's `tags[]` and within `agent.tags[]`

---

## Surfaces

### Server

- **`aspect-agent-server/builder/runtime/promptAssembler.js`**
  Add the `{{tag:...}}` resolver branch alongside the existing
  `{{enum:...}}` / `{{dc:...}}` / `{{field:...}}` resolvers. One
  function, three sub-shapes (no segment vs `:values` vs `:names`).
  Walks `agentDoc.fields` + the active crew's `crewDoc.fields`,
  filters by tag membership.

### Client

- **`aspect-react-client/src/builder/types/index.ts`**
  Add `tags?: string[]` to `FieldDef` and `AgentDoc`. Mirror the
  server-side canonical types file.
- **`aspect-react-client/src/builder/components/SchemaPanel/SchemaFieldEditor.tsx`**
  New "Tags" input below "Domain". Mirrors the `DomainInput`
  pattern: free-text + autocomplete from `agent.tags`, chips for
  current tags, free-form add (Enter to commit). Auto-commits on
  blur, same model as every other field on the editor.
- **`aspect-react-client/src/builder/components/MentionTextarea/useMentionOptions.ts`**
  New "tag" category. Each option labeled `{{tag:NAME}}` with the
  count of fields under it. The picker reads from `agent.tags`
  (declared) + every tag actually used on a field (in case the
  declared list is stale).
- **New: `aspect-react-client/src/builder/components/TagsScreen/`**
  Dedicated page at `/<agent>/builder/tags`. Two-column layout
  matching `FieldsScreen` / `PersonasScreen`:
  - Left: list of declared tags + their field counts. `+ Add tag`
    button auto-creates a stub name and routes to it.
  - Right: editor for the active tag — inline rename + list of
    every field carrying it (each row links to the field's edit
    URL). Delete button at the bottom.
- **`aspect-react-client/src/builder/components/Canvas/AgentSetupArea.tsx`**
  New chip "Tags" next to Personas / Fields / Enums. Click →
  navigates to `/<agent>/builder/tags`. Count from
  `agent.tags?.length ?? 0`.

---

## Rename cascade

Tags participate in the same rename-cascade pattern as every other
entity. Two sides to keep in sync:

1. **Token side** — rewrite `{{tag:OLD}}`, `{{tag:OLD:values}}`,
   `{{tag:OLD:names}}` across every prompt-text surface (addon
   prompts + promptTemplates, snippet content, persona content,
   enum value umbrellas + section texts, legacy `agent.persona` /
   `crew.persona`).
2. **Data side** — rewrite every `FieldDef.tags[]` entry that
   contains the old name (agent fields + every crew's fields), and
   update the entry in `agent.tags[]` (dedupe if the new name
   already exists).

Add to `aspect-react-client/src/builder/state/promptTokenCascade.ts`:

```ts
export function cascadeTagRename(
  agent: AgentDoc, oldTag: string, newTag: string,
): AgentDoc {
  // 1. Rewrite tokens (segmented: handles bare, :values, :names).
  // 2. Rewrite agent.tags (dedup-preserving order).
  // 3. Rewrite every FieldDef.tags[] entry on agent + crews.
}
```

Wire into `BuilderContext`:

```ts
applyTagRenameCascade: (agentId, oldTag, newTag) => void;
```

Call from the Tags page's inline-rename commit, same model as the
enum / persona / snippet pages already use.

### Delete cascade

`removeAgentTag(agentId, tagName)` (new BuilderContext mutator):

- Strip the tag from `agent.tags`.
- Strip it from every `FieldDef.tags[]` on agent + crew fields.
- Leave `{{tag:NAME}}` tokens in prompts AS-IS so the typo
  surfaces visibly (matches the resolver's unknown-tag behavior).
  No silent rewrites on delete — the user gets to see the broken
  reference.

---

## Open variants / future

- **Declared-list vs free-form**: shipping with both — `agent.tags`
  registry exists, but typing a fresh tag on a field auto-declares
  it. Same compromise we have for domains.
- **Tag scopes**: tags are agent-wide. If a crew-scoped field gets
  tagged, the tag still lives in `agent.tags` — only the field's
  visibility is crew-scoped. v1 ships this; if cross-pollution
  becomes a problem we can add `crew.tags?: string[]` later.
- **`{{tag:NAME:schema}}` future variant**: same as `{{tag:NAME}}`
  but adds the `type` of each field next to its name. Useful for
  LLM prompts that need to know "marital_status is an enum with
  these values". Skipped from v1 — `{{tag:NAME}}` + per-field
  enum awareness via the existing `{{dc:...}}` token is enough.

---

## Build order

1. Types: `FieldDef.tags?` + `AgentDoc.tags?` (server + client mirror).
2. Field editor: tag input with autocomplete.
3. `{{tag:...}}` resolver in `promptAssembler.js` (all three variants).
4. Mention picker: tag category.
5. Tags page + AgentSetupArea chip.
6. Rename cascade (`cascadeTagRename`) wired into Tags page commit.
7. Delete cascade (`removeAgentTag`).

Each step is a small PR-sized chunk; #3 is the only one that touches
the server. Everything else is client-side.
