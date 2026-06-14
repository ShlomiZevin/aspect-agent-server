# Builder V2 — Snippets

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first.
> Related: [BUILDER_V2_DYNAMIC_CONTEXT.md](./BUILDER_V2_DYNAMIC_CONTEXT.md)
> (the closest existing primitive), [BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md)
> (JSON shapes), and the `AddonFilter` already shipped on the per-
> addon Run Filter feature.
>
> **Status:** design locked. Ready to build. No code yet.

---

## TL;DR

A **Snippet** is a named, reusable chunk of authored prompt content
that can be **conditionally suppressed** at runtime. Authored once on
the agent, inserted anywhere a prompt is edited via the `{{snippet:NAME}}`
token. When the snippet's optional condition fails, the token resolves
to empty string and that block of prompt content silently disappears
for the turn.

That's it. No new condition vocabulary, no inline `{{if}}` syntax, no
runtime expression evaluator. Same condition primitive as Transition
Router + Run Filter; same token-substitution model as `{{memory}}` and
`{{dynamic:F}}`.

Why we need it:

- **Smart prompts without forking the addon.** Author one long Thinker
  prompt and let a paragraph vanish when `mood = sad`. Without
  snippets, the author would either fork the prompt (two addons) or
  fork the whole crew (too much) or set up a full DC per paragraph
  (heavy, mental overhead).
- **Reuse.** A snippet authored once is callable from the Thinker AND
  the Talker AND the Field Interviewer. Change the wording in one
  place, every addon picks it up.
- **Doubles as a long-form `Parameter`.** Parameters today are
  single-line static strings (`{{param:bankName}}`). Snippets are the
  multi-line equivalent — even with no condition set, a snippet is a
  reusable text block. The condition is the second feature on top.

---

## Mental model

Three things to internalise:

### 1. A snippet is the inline counterpart to the Run Filter

Run Filter gates whether the whole addon runs. Snippet gates whether
**a piece of content inside a prompt** renders. Same author primitive
(`AddonFilter` — conditions + include/exclude mode), two scopes.

If the author already understands Run Filter, snippet is one mental
step further, not two.

### 2. The token IS the conditional

The author doesn't write "if / then". They drop `{{snippet:greeting_for_returning_user}}`
into their prompt where they want the content to appear. The runtime
either substitutes the snippet's content (condition matched) or
substitutes the empty string (condition failed or no condition set
and the snippet is missing). No inline syntax to parse, no expression
to evaluate.

### 3. Snippets live on the agent, not on the addon

A snippet declared once is callable from every prompt-bearing addon
in the agent. Like `parameters[]` and `dynamicContexts[]`. The token
namespace is flat per agent — names must be unique, validator
enforces.

---

## Why NOT fold this into Dynamic Context

Discussed and decided against, even though DC + an empty case CAN
technically express "render content when mood ≠ sad". Reasons:

- **DC switches by ONE field's current value.** Snippets are AND-of-
  conditions across any fields — same as Run Filter and Transition
  Router. Conceptually wider.
- **DC is structured around cases per enum value.** That's a perfect
  shape for "switch on which mood we're in." It's an awkward shape
  for "skip this paragraph if mood is sad" — the author has to author
  N–1 copies of the same content, one per OTHER value.
- **DC's authoring model is value-first** (pick a field → fill cases).
  Snippets are content-first (write the content → optionally gate
  it). Different starting point for the same author task.
- **Reuse semantics differ.** DC cases are scoped to one field's
  value space. Snippets are flat, named, named globally on the
  agent — one snippet, callable from many addons without per-field
  duplication.

Both are valuable. DC stays for value-driven branching of prose. Snippets
fill the "drop in this content sometimes" gap.

---

## Data shape

### Type

Lives in the canonical types file alongside `DynamicContextDef` and `ParameterDef`.

```ts
/**
 * One named, reusable, optionally-gated chunk of prompt content.
 *
 * Inserted into prompts via `{{snippet:<name>}}`. Renders the
 * `content` when:
 *   - no `filter` is set, OR
 *   - `filter.conditions` is empty, OR
 *   - `filter.mode === 'include'` and ALL conditions match, OR
 *   - `filter.mode === 'exclude'` and AT LEAST ONE condition fails.
 *
 * Otherwise renders empty string and the prompt assembler collapses
 * surrounding whitespace, same as it does for every other token
 * that resolves to empty.
 */
export interface SnippetDef {
  id: ID;
  /** Canonical key — used in `{{snippet:NAME}}` tokens. Unique per
   *  agent (validator enforces). Lowercase + underscores by
   *  convention; the editor lints toward that shape. */
  name: string;
  /** Optional human-readable label shown in the snippets list and
   *  picker description. Free-form. */
  displayName?: string;
  /** The prompt content. Mention-aware — can itself reference
   *  `{{field:X}}`, `{{param:Y}}`, `{{memory}}`, etc. NOT another
   *  snippet (no nested snippets in v1 — keeps substitution one
   *  pass and avoids the cycle question). */
  content: string;
  /** Optional gate. Same shape as `AddonFilter` on `AddonContext`.
   *  Reuses the existing `ConditionsEditor` UI and the existing
   *  `evaluateConditions` runtime helper. Omit for "always render"
   *  (the snippet is then just a reusable text block — that's a
   *  feature, not a bug). */
  filter?: AddonFilter;
}
```

### Storage

Add to `AgentBody`:

```ts
export interface AgentBody {
  // ... existing ...
  snippets?: SnippetDef[];
}
```

Optional on the type so older agents without snippets parse cleanly.
The runtime treats missing/empty as `[]`.

---

## Token & substitution rules

### New tokens

```
{{snippet:NAME}}    — single snippet by name. Inline (bare text — no wrapping
                      heading or label). Empty string when the snippet
                      doesn't exist OR its filter says skip.
```

That's the whole vocabulary. We considered:

- `{{snippets}}` (all of them concatenated). **Skip.** No clear render
  shape and most callers want a specific one.
- `{{snippet:NAME:section}}` (sub-parts within one snippet). **Skip.**
  If you want multiple parts, declare multiple snippets — names are
  cheap.

### Assembler rule (server-side, `promptAssembler.js`)

Mirror the existing `{{dynamic:NAME}}` substitution path:

```js
template = substituteParameterised(
  template,
  'snippet',
  (name) => {
    const snip = (snippets || []).find(s => s.name === name);
    if (!snip) return '';                              // unknown name → ''
    if (snip.filter && Array.isArray(snip.filter.conditions) && snip.filter.conditions.length > 0) {
      const { ok } = evaluateConditions(memory, snip.filter.conditions);
      const mode = snip.filter.mode === 'exclude' ? 'exclude' : 'include';
      const shouldRender = mode === 'include' ? ok : !ok;
      if (!shouldRender) return '';                    // gate said skip → ''
    }
    return snip.content;
  },
  /* inline */ true,
);
```

Empty resolution → existing whitespace-collapse helper deletes the
surrounding blank lines so the assembled prompt isn't gappy. Exactly
what `{{field:X}}` and `{{dynamic:NAME}}` already do when they
resolve to empty.

### What about nested snippets?

`SnippetDef.content` can itself contain `{{snippet:OTHER}}` tokens.
**v1 rule: one substitution pass only.** Nested snippet tokens land
in the assembled prompt as literal text. Reason: cycle prevention is
cheap to specify (refuse to render), but the cycle-detection code
and the "what wins on conflict" decisions add complexity we don't
need yet. If a real use case shows up, allow it with a depth cap.

Validator surfaces the literal as a warning ("looks like a snippet
reference inside another snippet — not expanded in v1").

---

## UI

### Snippets section on the agent page

Lives alongside Persona / Parameters / Domains / Fields / Dynamic
Context. Same UX shape as Parameters / DC — list of rows, "+ Add
snippet" at the bottom, click a row to edit in a modal.

Each row shows:

- Snippet name (mono).
- `displayName` if set.
- A small `▽` icon when a filter is attached (clickable — opens the
  filter editor inline, same as on chip cards).
- A one-line snippet preview (first ~60 chars).

### Snippet editor modal

Standard modal frame. Sections:

1. **Name + display name** — name lints toward `lowercase_underscores`,
   collides-with-existing UX same as `AddFieldModal`.
2. **Content** — `MentionTextarea`, full mention picker (memory,
   parameters, persona, dynamic, etc — NOT `{{snippet:…}}` itself in v1).
3. **Filter** — opens the same focused `FilterModal` used by the
   addon Run Filter. Author button next to the section header
   matches the AddonModal launcher pattern (`No filter — addon runs
   every turn` → amber `Skip when mood = sad`).

No "preview" pane yet. Add later if authors ask.

### Hover preview in the MentionTextarea

**New affordance.** Snippets are typically much longer than other
tokens (paragraphs vs. inline values). Hovering a `{{snippet:NAME}}`
token in the prompt editor should show a tooltip with:

- The snippet name + display name.
- A faded preview of the content (first ~200 chars + ellipsis).
- The filter summary (`No filter — always renders` / `Skip when …`).
- A small "Edit" affordance (clicking jumps to the snippet editor
  modal, same flow as the chip filter badge).

Implementation: `MentionTextarea` already renders the prompt in a
plain `<textarea>` so we can't hit individual tokens. Two options:

- **Option A:** Add a sibling overlay layer that mirrors the
  textarea content, scrolls in sync, and highlights snippet token
  spans. Hovering a span opens the popup. Same trick rich-editor
  shells use for syntax-highlighting overlays.
- **Option B:** Scan the prompt for `{{snippet:NAME}}` tokens and
  render them in a small "Snippets used in this prompt" footer
  under the textarea — same content, simpler implementation, less
  discoverable.

Recommendation: **B in phase 1, A in phase 2.** B ships next to the
rest of the snippets feature in one cycle; A is a UI polish pass
that can land on its own once the primitive is proven.

### Quick-add from `/` shortcut

The unified mention picker (`/` and `{{`) gets a new entry:

- **"+ New snippet"** — opens the snippet editor modal pre-filled
  with the typed filter text as the name. On save, the snippet is
  added to `agent.snippets[]` AND the `{{snippet:<name>}}` token
  is inserted at the caret. Author types `/new vibe ack` → modal
  opens with name `vibe_ack` (whitespace → underscore lint applied)
  → write content + optional filter → Done → token inserted, done.

This matches the existing "+ Create new field" pattern in Field
Reasoner's WireOrCreate modal — the author never leaves the
authoring flow to declare a primitive.

Also add: each existing snippet appears in the picker as a regular
entry with insertion `{{snippet:NAME}}`, grouped under "Snippets".
The description shows the filter summary so the author knows the
gate before inserting.

---

## Server runtime

### Files

```
aspect-agent-server/
  builder/
    types/index.ts                ← SnippetDef + AgentBody.snippets?
    runtime/
      promptAssembler.js          ← {{snippet:NAME}} substitution
    promptPlaceholders.json       ← register the token + sigil
  alfred/
    services/
      bodyValidator.js            ← validateSnippets (name uniqueness,
                                    no nested-snippet refs, condition
                                    sanity)
      patchGenerator.js           ← already auto-picks up SnippetDef
                                    if we list it in the schema doc
```

No new addon descriptor. No new plugin runner. Snippets aren't
addons — they're a data primitive on the agent body, like parameters
and dynamic contexts.

### Assembler integration

One new `substituteParameterised('snippet', …)` call after the
existing `dynamic` substitution (so a snippet's content can reference
`{{dynamic:X}}` — that case still resolves because the dynamic
substitutions run again on the next pass… wait, no. Per the "single
pass" rule, snippet content is the FINAL text — its embedded
`{{dynamic:X}}` would NOT resolve.).

**Decision: snippet content is mention-aware AT EDIT TIME but its
own embedded tokens DO resolve at substitute time.** Run snippet
substitution EARLIER than the rest — before `{{dynamic}}`, before
`{{field:X}}`. That way a snippet inserted at runtime brings its
tokens along, and the regular substitution pass resolves them.

Order:

1. `{{prompt}}` (existing — pastes `config.prompt` into the
   template).
2. **NEW: `{{snippet:NAME}}` first pass** — paste the snippet's
   content into the template OR empty string per filter. The
   pasted content can itself contain other tokens.
3. Sections (`{{memory}}`, `{{thinking}}`, `{{summary}}`, …).
4. Parameterised (`{{memory:X}}`, `{{field:Y}}`, `{{dynamic:Z}}`,
   `{{param:K}}`).
5. Single-field inline (`{{this_field}}`, `{{enum_values}}`).

This handles nested snippets implicitly only as a side-effect of
the second-pass tokens. If a snippet's content includes
`{{snippet:OTHER}}`, the FIRST snippet pass inlines it as
literal, but subsequent passes don't re-scan for snippet tokens —
the nested reference shows up in the assembled prompt as raw text.
Validator warns; authors avoid.

### Memory / brain dependency

The condition evaluator already takes the brain blob (it's how
Run Filter and Transition Router work today). Pass `memory`
through the assembler so the snippet substitution can call
`evaluateConditions(memory, filter.conditions)`.

`assemblePrompt` already receives `memoryValuesByDomain` / similar
accessors; we add the raw `memory` blob as an explicit input so the
snippet rule can use the same `conditionMatcher` the other
condition consumers do.

---

## Examples

### Example 1 — gate one paragraph in a Thinker

Agent has a `mood` enum field with values `[sad, neutral, happy]`.

Author creates a snippet:

```
name:    vibe_acknowledgment
content: "Open with a soft acknowledgment of the user's emotional
          state before pivoting to the strategy."
filter:  { mode: 'exclude', conditions: [ { type: 'field', field: 'mood', op: 'equals', value: 'sad' } ] }
```

Thinker prompt:

```
{{persona}}

Decide the talker's strategy for this turn.

{{snippet:vibe_acknowledgment}}

Your output is JSON: { main_plan, tone }.
```

Runtime:

- `mood = neutral` → snippet renders → Thinker sees the acknowledgment line.
- `mood = sad` → exclude-mode filter matched → snippet renders empty
  → that block + its surrounding blank lines collapse → Thinker
  sees the persona + the JSON instruction with NO acknowledgment
  guidance.

### Example 2 — reusable text block, no condition

```
name:    json_only_instruction
content: "Output JSON only. No preamble, no markdown fences. Use
          double quotes around all keys and string values."
```

No filter. Always renders. Insert in every JSON-producing addon's
prompt so the wording stays consistent agent-wide.

### Example 3 — composed with parameters

```
name:    bank_disclaimer
content: "Welcome to {{param:bankName}}. For account inquiries,
          please call {{param:supportPhone}}."
filter:  { mode: 'include', conditions: [ { type: 'field', field: 'intent', op: 'equals', value: 'support' } ] }
```

Snippet content uses `{{param:…}}`. Snippet substitution inlines
the content; the regular parameter substitution then resolves the
`{{param:X}}` tokens. Author writes the canonical wording once,
references the static config values, uses it from every support-
flow addon.

---

## Locked decisions

1. **Snippets are first-class on the agent.** Not folded into DC. Not
   per-addon. Top-level `agent.snippets[]`, name unique per agent.
2. **Same filter primitive as Run Filter / Transition Router.** `AddonFilter`
   (conditions + `include/exclude` mode). Same `ConditionsEditor` UI,
   same `evaluateConditions` runtime. One condition vocabulary
   across the system.
3. **Optional filter — no condition = always render.** A snippet
   with no filter (or empty conditions) is a reusable text block,
   period. Renders unconditionally every turn it's referenced.
   Conditions are an optional feature ON TOP — they don't change
   the substitution result when absent. (Author intent here: keep
   snippets useful as multi-line Parameters even when the
   gating feature isn't being used.)
4. **Token: `{{snippet:NAME}}`.** Inline, bare text. Empty when
   unknown or gated. Same whitespace collapse as every other empty
   token.
5. **Mention tokens inside snippet content ARE supported.** A
   snippet's `content` field can reference `{{field:X}}`,
   `{{param:Y}}`, `{{memory}}`, `{{dynamic:Z}}`, `{{thinking}}`,
   `{{summary:S}}`, etc. — the snippet substitution pass runs
   FIRST in the assembler (before sections / domains / parameters /
   dynamic), so those embedded tokens land in the assembled
   template and resolve naturally on the regular passes. Author
   gets the full picker inside the snippet editor.
6. **No nested snippets in v1.** A snippet's content with embedded
   `{{snippet:OTHER}}` shows up as literal text — the snippet pass
   is one-shot. Validator warns. Lift the restriction when a real
   need shows up (would need a depth cap + cycle detection).
7. **Sigil: `+`** for the dedicated single-char trigger. Reads as
   "additive content", and lines up with the existing single-char
   trigger convention (`@` / `!` / `#` / `^` / `*` / `%`).
   Author's first reach is `/` (the unified picker) where snippets
   appear under a `Snippets` group regardless; the dedicated
   sigil is just there for muscle memory once the author knows
   the namespace they want.
8. **Hover-preview in the prompt editor is a v1 ship target.** Not
   the overlay-layer route (Option A) but the footer route (Option
   B) — same content, smaller surgery, ships with the primitive.
   Overlay can land later as polish.
9. **Quick-add from `/`.** `+ New snippet` entry in the unified
   mention picker that opens the snippet editor modal and inserts
   the token on save.
10. **No `{{snippets}}` aggregate token.** Authors reference specific
   snippets by name. Aggregate forms have no clean render shape.

---

## Implementation phases

### Phase 1 — bare runtime + agent-page editor

- [ ] Types: `SnippetDef`, `AgentBody.snippets?`.
- [ ] `promptPlaceholders.json`: register `{{snippet:NAME}}`. New
      sigil — recommend `+` (additive content) under that trigger,
      OR fold under `/` only (no dedicated single-char). Decide
      when wiring the picker.
- [ ] `promptAssembler.js`: substitute `{{snippet:NAME}}` first
      pass, before sections. Empty when unknown / filter says skip.
- [ ] Agent page: new `Snippets` section under the Setup zone
      (next to Parameters / Dynamic Context chip).
- [ ] `SnippetModal` editor — name / displayName / content
      (MentionTextarea) / filter (launcher → FilterModal).
- [ ] Mention picker: list every declared snippet under a
      `Snippets` group. Description shows the filter summary so the
      author sees the gate before inserting.
- [ ] Mention picker quick-add: `+ New snippet` entry that opens
      `SnippetModal` and inserts the token on save.
- [ ] Per-prompt "Snippets used here" footer under each
      `MentionTextarea` — lists every snippet name found in the
      current prompt with a one-line preview and the filter
      summary. Click → opens `SnippetModal` for that snippet.

### Phase 2 — Alfred awareness

- [ ] `bodyValidator.js`: `validateSnippets(agentBody)` — name
      uniqueness, no nested `{{snippet:X}}` references inside
      content (warn), filter shape sanity.
- [ ] Alfred system prompt paragraph: "Snippets are agent-level
      reusable prompt blocks with optional conditions. Use them to
      gate paragraphs without forking the addon."

### Phase 3 — overlay-layer hover preview

- [ ] `MentionTextarea` overlay layer that mirrors the textarea
      content, scrolls in sync, highlights `{{snippet:NAME}}`
      tokens, and shows the rich tooltip on hover. Replaces the
      footer "Snippets used here" surface from Phase 1.
- [ ] Use the same `FilterChipBadge`-style popup for visual
      consistency with the chain chip filter affordance.

### Phase 4 — composability with summarizers / DC

- [ ] Decide whether snippets should be allowed inside `DynamicContextDef.cases[].text`
      and `SectionTexts`. Right now they wouldn't resolve (sections
      themselves substitute LAST). Either run the snippet pass
      before AND after the dynamic pass, or document the limitation.
- [ ] Same question for Summarizer's `config.prompt` — already a
      mention-aware textarea; the snippet pass should run there too
      since the Summarizer runs through the assembler like any
      other addon.

---

## Open items (small — for Phase 1 implementation time)

- **Name linting.** Auto-suggest `lowercase_underscores` from a
  free-form display name? Or trust the author? Probably auto-
  suggest with override, same as field name lint.
- **Empty content allowed?** A snippet with empty content is
  useless (renders empty regardless of filter). Block at the
  editor or allow as a "stub"? Probably allow — authors mid-flow
  shouldn't be blocked.
- **Removing a snippet that's referenced.** Scan every prompt
  textarea for `{{snippet:NAME}}` and warn on delete? Or silent
  delete and let the runtime resolve to empty? Probably warn —
  matches the pattern for deleting a referenced field.
