# Phase B handoff — to the Alfred-focused session

You'll be looking at Alfred. The Builder side just shipped Phase B:
"prompts are mention-aware text" — the structured per-addon
`persona / memoryReads / thinkingReads` toggles are gone. Placement of
every section / domain / field / parameter now lives inside the
`promptTemplate` string via `{{...}}` tokens. This document tells you
what changed and where Alfred needs adjustments.

Triggered Context is intentionally **untouched** by Phase B.

---

## 1. What changed in the agent shape

### `AddonContext` (in `aspect-agent-server/builder/types/index.ts`)

**Removed fields:**
- `persona: boolean`
- `memoryReads: Array<string | null>`
- `thinkingReads: Array<string | null>`

**Surviving fields:**
- `history: HistoryMode` (runtime conversation data, can't be a token)
- `triggeredReads?: Array<string | null>` (Triggered Context still uses it)

### `AddonInstance.promptTemplate`

**Convention shifted.** The descriptor's `defaultPromptTemplate` is now
just `"{{prompt}}"` for every prompt-bearing addon (Talker, Thinker,
Field Extractor, Vibe Extractor). The "scaffolding" that used to wrap
the user's prose lives directly in `defaultConfig.prompt` now.

So a new Talker is born with:
```json
{
  "promptTemplate": "{{prompt}}",
  "config": {
    "prompt": "{{persona}}\n\nYou are speaking with the user…\n\n{{memory}}\n\n{{thinking}}",
    "model": { ... }
  }
}
```

Not:
```json
{
  "promptTemplate": "{{persona}}\n\n{{prompt}}\n\n{{memory}}",
  "config": { "prompt": "You are speaking with the user…", "model": { ... } }
}
```

Both work — the assembler substitutes `{{prompt}}` first, then resolves
any tokens that ended up in the expanded text — but the new form is the
canonical one and what every fresh addon descriptor produces.

---

## 2. The new placeholder vocabulary

The canonical list lives in
`aspect-agent-server/builder/promptPlaceholders.json`. Read it as a
machine-readable spec; treat it as the source of truth.

Categories:

- **Whole sections** — `{{memory}}`, `{{persona}}`, `{{thinking}}`,
  `{{triggered}}`
- **Single domain** — `{{memory:DOMAIN}}`, `{{thinking:DOMAIN}}`
- **Single value (inline)** — `{{field:NAME}}`, `{{param:NAME}}`
- **Extractor-only** — `{{fields_schema}}`, `{{fields_current}}` (auto-injected from wired field set)

`promptPlaceholders.json` also carries `trigger_prefixes` (`@`, `!`, `#`
— the builder UI's mention picker hot-keys) and `idioms` (short
named patterns Alfred should learn to emit naturally).

---

## 3. Where the spec is embedded today

Already wired into:

- `alfred/services/alfredContext.js` — loads `promptPlaceholders.json`,
  renders it as a markdown reference inside `SYSTEM_PROMPT`.
  **`alfredRunner` (brainstorm Alfred) already sees it** through
  `SYSTEM_PROMPT`. The user can ask "how do I reference a field?" and
  he can answer correctly.
- `alfred/services/patchGenerator.js` — loads the raw JSON and embeds
  it verbatim inside the system prompt for the patch-generation call.
  Alfred picks the right tokens when minting an `AddonInstance`'s
  `promptTemplate` / `config.prompt`.
- `alfred/services/bodyValidator.js` — Phase B context fields
  (`persona`, `memoryReads`, `thinkingReads`) are no longer required
  or expected. Only `history` and optional `triggeredReads` live on
  `context`. The validator silently accepts addons that still carry
  the old fields (back-compat for in-flight Apply targets), but Alfred
  should not emit them.

---

## 4. Migration of old addons

Server-side, every addon body is run through
`builder/runtime/migrateAddonContext.js` on:

- `hydrateProject` (client read path)
- `resolveRunnable` (runtime read path)

The migration is **idempotent**. It:

1. Folds the old `context.persona / memoryReads / thinkingReads` flags
   into the template (e.g. `persona: false` strips `{{persona}}`;
   `memoryReads: ['customer']` rewrites `{{memory}}` →
   `{{memory:customer}}`).
2. Substitutes the old `config.prompt` text into the `{{prompt}}` slot
   of the template.
3. Sets `promptTemplate = "{{prompt}}"` and writes the merged content
   to `config.prompt`.
4. Strips the dead `context` fields (keeps `history` + `triggeredReads`).

**Alfred should NOT replicate this migration.** It's a one-shot done by
the runtime. Alfred only emits the new shape.

---

## 5. Concrete patterns Alfred should learn

### Talker (most common)

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

### Field Extractor

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

`{{fields_schema}}` / `{{fields_current}}` are auto-resolved from
`config.extractsFields`. Always place them inside the prompt body now —
they're no longer auto-wrapped by the template.

### Thinker

```json
{
  "promptTemplate": "{{prompt}}",
  "config": {
    "prompt": "{{persona}}\n\nYou are the strategist.\n\n{{memory}}\n\nReturn JSON with keys: main_plan, empathy_tone, open_question.",
    "domain": "strategy"
  }
}
```

The Thinker's output writes to `thinking.<domain>`. Downstream addons
read via `{{thinking}}` (all domains) or `{{thinking:strategy}}` (one
domain). If a Talker should consume the Thinker, place `{{thinking}}`
or `{{thinking:strategy}}` in the Talker's `config.prompt`.

### Transition Router

Unchanged. No prompt, no context placement to worry about.
`context.history.mode === 'none'`.

### Triggered Context

**Don't touch.** Stays as-is for Phase B. Still uses
`context.triggeredReads` etc. The Triggered Context redesign is a
separate later effort.

---

## 6. Adjustments Alfred may need

These are the spots most likely to need tuning on the Alfred side:

1. **System-prompt examples / few-shots.** If Alfred has hard-coded
   example templates from before Phase B (e.g. `"{{persona}}\n\n{{prompt}}\n\n{{memory}}"`
   wrappers), update them to the new shape — single `"{{prompt}}"` in
   `promptTemplate`, scaffolding inside `config.prompt`.
2. **Body-validator failure messages.** If Alfred treats "addon
   missing context.persona" as a recoverable issue and tries to
   re-emit, that retry path can be removed — the field is gone for good.
3. **Instructions about persona / memory toggles.** Anywhere Alfred is
   told to "turn persona on by setting context.persona to true", flip
   the guidance to "place {{persona}} where you want it inside
   config.prompt."
4. **Memory-domain selection guidance.** The old "tick memoryReads to
   inject" instruction becomes "use {{memory:DOMAIN}} for a single
   bucket, {{memory}} for everything, {{field:NAME}} for a single
   inline value."
5. **Triggered guidance.** Leave Triggered Context guidance untouched.
6. **Parameters (NEW).** Alfred should know agent parameters
   (`agent.parameters`) exist and are referenced via `{{param:NAME}}`.
   He'll see them in the agent body summary already; the prompt-writing
   guidance just needs to point at the token.

---

## 7. Quick verification checklist

- `promptPlaceholders.json` is reachable from `alfredContext.js`,
  `patchGenerator.js`, `bodyValidator.js`. (✓ already wired)
- Alfred's brainstorm chat can answer "how do I reference a memory
  field?" with `{{field:NAME}}` (try it manually).
- Alfred's patch generator, when asked to "add a Talker that greets the
  user by their name and asks for their age", produces a
  `config.prompt` with `{{field:customer_name}}` style tokens — NOT
  `context.memoryReads`.
- `bodyValidator` accepts addons whose `context` only has `history`
  (+ optional `triggeredReads`). It does NOT reject for missing
  `persona` / `memoryReads`.

If any of these are off, the fix is almost certainly in the system
prompt's instructions or examples — `promptPlaceholders.json` carries
the contract, but Alfred's tone and defaults still come from his
hand-written system prompt.

---

## 8. Files most worth re-reading

- `aspect-agent-server/builder/types/index.ts` — `AddonContext` + the
  `KNOWN_PROMPT_PLACEHOLDERS` const (flat tokens only).
- `aspect-agent-server/builder/promptPlaceholders.json` — the full
  vocabulary + idioms.
- `aspect-agent-server/builder/runtime/promptAssembler.js` — actual
  substitution logic; the contract Alfred has to respect.
- `aspect-agent-server/builder/runtime/migrateAddonContext.js` —
  exactly what shape conversion the runtime does.
- `aspect-agent-server/builder/addons/talker.addon.json` (and the four
  sibling descriptors) — the new canonical defaults.

That's the whole change. Triggered untouched, no new sigils, no new
schemas. Just: one mention-aware textarea per prompt-based addon, and
the placeholder JSON anchoring everything.
