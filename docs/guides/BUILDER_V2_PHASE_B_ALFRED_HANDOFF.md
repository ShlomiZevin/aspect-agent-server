# Phase B handoff — to the Alfred-focused session

The Builder side just shipped Phase B. This doc is for whoever is
adjusting Alfred next. Start with the prompt at the top — that's the
brief. The rest is reference material.

---

## Prompt to hand to the Alfred session

> You are about to update Alfred. Phase B of the Builder shipped: the
> per-addon `context.persona / memoryReads / thinkingReads` toggles are
> gone. Placement of every section, domain, field, and parameter now
> lives inside the addon's prompt text via `{{...}}` tokens.
>
> What you need to do:
>
> 1. Read `aspect-agent-server/builder/promptPlaceholders.json` — that
>    JSON is the new vocabulary. Every prompt-bearing addon
>    (`talker`, `thinker`, `field-extractor`, `vibe-extractor`) uses
>    these tokens inside `config.prompt`. The token list is the source
>    of truth for both the runtime assembler and the builder UI's
>    mention picker.
>
> 2. Read `aspect-agent-server/builder/runtime/promptAssembler.js` so
>    you know exactly how tokens resolve at runtime. Important:
>    `{{prompt}}` substitutes first, so any token a user typed inside
>    `config.prompt` will be resolved after that pass.
>
> 3. Read `aspect-agent-server/builder/runtime/migrateAddonContext.js`.
>    The runtime auto-migrates old-shape addons on read. **You should
>    not replicate this migration.** Alfred only ever emits the new
>    shape: `promptTemplate: "{{prompt}}"` plus the user's actual
>    template content inside `config.prompt`.
>
> 4. Walk Alfred's own hand-written system prompts
>    (`alfred/services/alfredContext.js`,
>    `alfred/services/patchGenerator.js`) and update any examples or
>    instructions that still talk about `context.persona`,
>    `memoryReads`, `thinkingReads`. Replace them with the
>    placement-inside-`config.prompt` model. The placeholder JSON is
>    already embedded in both files' system prompts (you don't need to
>    re-wire that — just update the surrounding prose if it's stale).
>
> 5. The Triggered Context addon is intentionally **untouched** by
>    Phase B. Leave any Triggered guidance as-is.
>
> Why this matters: users now have one mention-aware textarea per
> prompt addon. They expect Alfred to write template content that
> looks like what they would type — natural prose with `{{...}}` tokens
> woven in. The old "set context.persona = true" style is dead
> vocabulary.
>
> Validation checklist when you're done:
>   - Ask brainstorm Alfred "how do I reference a memory field?" → he
>     should answer `{{field:NAME}}`.
>   - Ask the patch generator (via Apply) for "a Talker that greets
>     the user by their name" → emitted addon should have
>     `promptTemplate: "{{prompt}}"` and `config.prompt` containing
>     `{{field:customer_name}}` style tokens. Not `memoryReads`.
>   - `bodyValidator.js` accepts addons whose `context` only has
>     `history` (+ optional `triggeredReads`).

---

## Reference: the actual changes

### 1. Agent shape

**`AddonContext` (in `builder/types/index.ts`) lost:**
- `persona: boolean`
- `memoryReads: Array<string | null>`
- `thinkingReads: Array<string | null>`

**Survives:**
- `history: HistoryMode`  — runtime conversation data, can't be a token
- `triggeredReads?: Array<string | null>` — Triggered Context still uses it

**`AddonInstance.promptTemplate` convention:** always `"{{prompt}}"`.
The actual template content lives in `config.prompt`. The assembler
substitutes `{{prompt}}` first so any tokens inside the user's prose
get resolved on the same pass.

### 2. The placeholder vocabulary

Canonical spec: `aspect-agent-server/builder/promptPlaceholders.json`.

| Category         | Tokens                                                  |
| ---------------- | ------------------------------------------------------- |
| Whole sections   | `{{memory}}`, `{{persona}}`, `{{thinking}}`, `{{triggered}}` |
| Single domain    | `{{memory:DOMAIN}}`, `{{thinking:DOMAIN}}`              |
| Single value     | `{{field:NAME}}`, `{{param:NAME}}`                      |
| Extractor-only   | `{{fields_schema}}`, `{{fields_current}}`               |

**Mention-picker triggers** (UI hot-keys — Alfred doesn't insert these,
but he should know what users type):
- `@` Memory · `!` Thinking · `#` Parameters · `^` Persona
- `{{` opens a unified picker with every category in one list

### 3. Migration

Runtime applies `migrateAddonContext.migrateAddonInstance` on every
read. Old addons fold their context flags into the template, merge
`config.prompt` into the template, drop the dead context fields. The
migration is **idempotent** — re-running on a migrated addon is a
no-op.

### 4. Where the placeholder JSON is embedded

- `alfred/services/alfredContext.js` — renders it as markdown inside
  `SYSTEM_PROMPT` (so brainstorm Alfred sees it)
- `alfred/services/patchGenerator.js` — embeds it raw inside the
  patch-generation system prompt
- `alfred/services/bodyValidator.js` — Phase B context fields no
  longer required. Only `history` (+ optional `triggeredReads`).

### 5. Canonical example shapes

**Talker:**
```json
{
  "promptTemplate": "{{prompt}}",
  "context": { "history": { "mode": "last_n", "n": 5 } },
  "config": {
    "prompt": "{{persona}}\n\nYou are guiding the user through onboarding. Their name is {{field:customer_name}}.\n\n{{memory}}\n\n{{thinking}}",
    "model": { "providerId": "google", "modelId": "gemini-2.5-flash" }
  }
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

**Thinker:**
```json
{
  "promptTemplate": "{{prompt}}",
  "context": { "history": { "mode": "last_n", "n": 8 } },
  "config": {
    "prompt": "{{persona}}\n\nYou are the strategist.\n\n{{memory}}\n\nReturn JSON with keys: main_plan, empathy_tone, open_question.",
    "domain": "strategy"
  }
}
```

**Transition Router & Triggered Context:** unchanged.

### 6. Files worth re-reading

- `builder/types/index.ts` — `AddonContext` + `KNOWN_PROMPT_PLACEHOLDERS`
- `builder/promptPlaceholders.json` — full vocabulary + idioms
- `builder/runtime/promptAssembler.js` — substitution logic
- `builder/runtime/migrateAddonContext.js` — the migration shape
- `builder/addons/*.addon.json` — the five updated descriptors
