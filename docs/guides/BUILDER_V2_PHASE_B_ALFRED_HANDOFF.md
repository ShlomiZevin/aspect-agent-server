# Phase B handoff — to the Alfred-focused session

The Builder side just shipped Phase B + the **Dynamic Context** redesign
(which replaced the old Triggered Context addon). This doc is for
whoever updates Alfred next. Start with the prompt at the top — that's
the brief. The rest is reference material.

---

## Prompt to hand to the Alfred session

> You are about to update Alfred. Two big things happened on the
> Builder side since you last looked:
>
> **(A) Phase B** — the per-addon `context.persona / memoryReads /
> thinkingReads / triggeredReads` toggles are gone. Placement of every
> section, domain, field, parameter, and dynamic-context switch now
> lives inside the addon's prompt text via `{{...}}` tokens.
>
> **(B) Dynamic Context replaces Triggered Context.** The
> Triggered Context addon, its rules, its `triggered` brain section,
> the `{{triggered}}` token, and `context.triggeredReads` are all
> **deleted from the codebase**. The new model is a value-switched
> token authored at agent level — see (3) below for the shape.
>
> What you need to do:
>
> 1. Read `aspect-agent-server/builder/promptPlaceholders.json` — that
>    JSON is the new vocabulary. Every prompt-bearing addon
>    (`talker`, `thinker`, `field-extractor`, `vibe-extractor`) uses
>    these tokens inside `config.prompt`. The list is the source of
>    truth for both the runtime assembler and the builder UI's mention
>    picker.
>
> 2. Read `aspect-agent-server/builder/runtime/promptAssembler.js` so
>    you know exactly how tokens resolve at runtime. `{{prompt}}`
>    substitutes first, so any token a user typed inside
>    `config.prompt` will be resolved on the same pass.
>
> 3. **Dynamic Context shape.** Authored at `agent.dynamicContexts:
>    DynamicContextDef[]`. Each carries `fieldId` + `cases: { value,
>    text }[]` + optional `fallback`. Resolution: `{{dynamic:NAME}}`
>    looks up the field whose name === NAME, finds the DC for it,
>    matches the live memory value against `cases[].value`, returns
>    the matched `text` (or fallback, or empty). When you generate a
>    new DC: pick an enum field on the agent, seed one case per
>    enumValue, write multi-paragraph "how to handle this case"
>    prose. The runtime emits a `dynamic.resolved` SSE event for every
>    resolution so the chat UI surfaces it.
>
> 4. Read `aspect-agent-server/builder/runtime/migrateAddonContext.js`.
>    The runtime auto-migrates old-shape addons on read (strips dead
>    context fields, folds wrapper template into `config.prompt`).
>    Alfred only ever emits the new shape: `promptTemplate: "{{prompt}}"`
>    plus the actual template content inside `config.prompt`.
>
> 5. Walk Alfred's own hand-written system prompts
>    (`alfred/services/alfredContext.js`,
>    `alfred/services/patchGenerator.js`) and update any examples or
>    instructions that still talk about `context.persona`,
>    `memoryReads`, `thinkingReads`, `triggeredReads`, or the old
>    Triggered Context addon. The placeholder JSON is already embedded
>    in both files' system prompts.
>
> 6. The **Triggered Context addon is gone**. Drop any references to
>    `triggered-context` plugin id, `{{triggered}}` token, the
>    `triggered` brain section, and `context.triggeredReads`.
>
> Why this matters: users now have one mention-aware textarea per
> prompt addon plus a deterministic "switch by value" mechanism that
> doesn't require adding an addon to a chain. They expect Alfred to
> propose Dynamic Contexts as a first-class tool (replacing what was
> previously "set up a Triggered Context addon").
>
> Validation checklist when you're done:
>   - Ask brainstorm Alfred "how do I reference a memory field?" → he
>     should answer `{{field:NAME}}`.
>   - Ask "how do I make the talker change tone based on the
>     customer's tier?" → he should propose adding a Dynamic Context
>     on the `tier` field, with one case per tier, then dropping
>     `{{dynamic:tier}}` into the Talker prompt. NOT "add a Triggered
>     Context addon".
>   - Ask the patch generator for "a Talker that greets the user by
>     their name" → emitted addon should have
>     `promptTemplate: "{{prompt}}"` and `config.prompt` containing
>     `{{field:customer_name}}` style tokens.
>   - `bodyValidator.js` accepts addons whose `context` only has
>     `history` (Phase B already stripped triggeredReads).
>   - No emitted addon has `pluginId: "triggered-context"`.

---

## Reference: what changed

### 1. Agent shape additions

```ts
// agent.dynamicContexts: DynamicContextDef[]
interface DynamicContextDef {
  id: ID;
  fieldId: ID;          // points at agent.fields[].id
  cases: { value: string; text: string }[];
  fallback?: string;
}
```

### 2. Tokens — current vocabulary

| Category         | Tokens                                                  |
| ---------------- | ------------------------------------------------------- |
| Whole sections   | `{{memory}}`, `{{persona}}`, `{{thinking}}`             |
| Single domain    | `{{memory:DOMAIN}}`, `{{thinking:DOMAIN}}`              |
| Single value     | `{{field:NAME}}`, `{{param:NAME}}`                      |
| Dynamic context  | `{{dynamic:NAME}}` (NAME = field name)                  |
| Extractor-only   | `{{fields_schema}}`, `{{fields_current}}`               |

Gone: `{{triggered}}`. The `triggered` brain section, the addon, the
context field — all removed.

**Mention-picker triggers** (UI hot-keys — Alfred doesn't insert these,
but he should know what users type):
- `@` Memory · `!` Thinking · `#` Parameters · `^` Persona · `*` Dynamic
- `{{` / `/` open a unified picker with every category

### 3. Migration

`migrateAddonContext.migrateAddonInstance` runs on every read. Old
addons get their context flags folded into the template, `config.prompt`
merged in, dead context fields stripped. Idempotent. Old TriggeredContext
addons are simply not loaded anymore — the plugin file is gone.

### 4. Where the placeholder JSON is embedded

- `alfred/services/alfredContext.js` — markdown reference inside
  `SYSTEM_PROMPT` for brainstorm Alfred.
- `alfred/services/patchGenerator.js` — raw JSON inside the
  patch-generation system prompt.
- `alfred/services/bodyValidator.js` — Phase B context fields no
  longer required. Only `history` is.

### 5. Canonical example shapes

**Talker:**
```json
{
  "promptTemplate": "{{prompt}}",
  "context": { "history": { "mode": "last_n", "n": 5 } },
  "config": {
    "prompt": "{{persona}}\n\nYou are guiding {{field:customer_name}}.\n\n{{dynamic:tier}}\n\n{{memory}}\n\n{{thinking}}",
    "model": { "providerId": "google", "modelId": "gemini-2.5-flash" }
  }
}
```

**Dynamic Context (lives on `agent.dynamicContexts`):**
```json
{
  "id": "dc_a1b2c3d4",
  "fieldId": "field_xyz",
  "cases": [
    { "value": "gold",   "text": "Gold-tier customers expect…\n\n[paragraphs of how-to prose]" },
    { "value": "silver", "text": "Silver-tier customers…" },
    { "value": "bronze", "text": "Bronze-tier customers…" }
  ],
  "fallback": "Treat as standard tier — friendly and brief."
}
```

**Field / Vibe Extractor:**
```json
{
  "promptTemplate": "{{prompt}}",
  "context": { "history": { "mode": "last_n", "n": 3 } },
  "config": {
    "prompt": "Extract field values from the user's latest message.\n\n## Field schema\n{{fields_schema}}\n\n## Already collected\n{{fields_current}}\n\nReturn JSON. Omit fields you didn't extract.",
    "extractsFields": [...]
  }
}
```

**Transition Router:** unchanged.

### 6. Live runtime visibility

When the assembler resolves a `{{dynamic:NAME}}` token, it emits a
`dynamic.resolved` SSE event:

```json
{ "type": "dynamic.resolved",
  "instanceId": "addon_…",
  "fieldName": "tier",
  "matched": "gold",
  "text": "Gold-tier customers expect…" }
```

The chat UI shows it as a quiet line above the assistant message.
Alfred doesn't need to do anything with these — they're for the
end-user to see what fired.

### 7. Files worth re-reading

- `builder/types/index.ts` — `DynamicContextDef`, `AddonContext`,
  `KNOWN_PROMPT_PLACEHOLDERS`
- `builder/promptPlaceholders.json` — full vocabulary + idioms
- `builder/runtime/promptAssembler.js` — substitution logic
  (`resolveDynamicInline` is the new bit)
- `builder/runtime/migrateAddonContext.js` — migration shape
- `builder/addons/*.addon.json` — five descriptors (talker, thinker,
  field-extractor, vibe-extractor, transition-router). The
  triggered-context descriptor is **deleted**.
