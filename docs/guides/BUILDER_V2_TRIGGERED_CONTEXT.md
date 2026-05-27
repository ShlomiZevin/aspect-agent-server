# Builder V2 — Triggered Context (Phase 6)

> Sister doc to [BUILDER_V2.md](./BUILDER_V2.md). Read that first. Read
> [BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md) to know the addon
> contract. Read [BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md) for the
> JSON shapes — this feature adds a third brain section and a new
> addon descriptor.

## What this is

**The hard alternative to KB.** Knowledge Base is vector-similarity
guessing — the LLM may or may not surface the right passage at the
right time. Triggered Context is deterministic: *"when field X has
value Y, inject EXACTLY this text into the prompt."* No similarity
search, no model interpretation in the routing.

Use this when you know which guidance applies under which condition
and you don't want the LLM doing the matching for you. Examples:

- `intent == 'complaint'` → inject de-escalation guidance.
- `mood == 'stubborn'` → inject empathy-first framing.
- `severity >= 4 && intent == 'sales'` → inject "escalate to advisor" guidance.

## The shape of the solution

**Triggered Context is an addon.** Same primitive as everything else
in the V2 builder — a plugin instance that lives in a crew's chain,
configures its own behavior, and produces memoryWrites the engine
persists. No bespoke modal, no `triggers[]` array on FieldDef, no new
prompt placeholder concept invented for this feature.

Storage grows from two parallel brain sections to **three**:

```
{
  memory:    { ... }   // facts the brain remembers
  thinking:  { ... }   // current strategic plan
  triggered: { ... }   // pre-scripted guidance fired by rules  ← NEW
}
```

The new section is consumed by downstream addons (Talker, Thinker)
through the same `Reads` picker pattern they already use for Memory
and Thinking. One unified mental model.

## Brain analogue

Per the Lybi brain KB page:

| Brain region | V2 piece |
|---|---|
| Hippocampus (encoding) | Field Extractor |
| Limbic system (mood) | Vibe Extractor |
| Prefrontal cortex (planning) | Thinker |
| Broca's area (speech) | Talker |
| Executive attention switch | Transition Router |
| **Basal ganglia / procedural memory** | **Triggered Context** ← NEW |

Basal ganglia handles *learned, automatic responses* — "when you see
this pattern, fire this script." That's exactly what the Triggered
Context addon does. The Lybi brain page gets a seventh region.

---

## Architecture at a glance

```
[Crew chain in the Cortex]
   ┌────────────────┐   ┌─────────────────┐   ┌──────────────┐   ┌──────────┐
   │ Field Extractor│ → │ Triggered Context│ → │ Thinker      │ → │ Talker    │
   │ (writes facts) │   │ (writes scripts) │   │ (reads both)  │   │ (reads all)│
   └────────────────┘   └─────────────────┘   └──────────────┘   └──────────┘
          │                     │                    │                  │
          ▼                     ▼                    ▼                  ▼
   memory.customer_profile  triggered.scripts   thinking.strategy   text-to-user
```

The Triggered Context addon:

1. Evaluates each of its rules against the current `memory` section.
2. Writes the `contextText` of matched rules into `triggered.<domain>.<field>`.
3. Downstream addons (Thinker / Talker) read from `triggered` via their
   `triggeredReads: Array<string | null>` config and the
   `{{triggered}}` prompt placeholder.

No LLM call — same shape as Transition Router. The matcher is reused
from Transition Router so there's one condition vocabulary across the
system.

---

## Data model

### `AddonContext` — add `triggeredReads`

```ts
interface AddonContext {
  history:        HistoryMode;
  persona:        boolean;
  memoryReads:    Array<string | null>;
  thinkingReads?: Array<string | null>;
  /**
   * Triggered-context domains to inject — populated by upstream
   * `Triggered Context` addons. Parallel to memoryReads / thinkingReads
   * but reads from the brain's `triggered` section. `null` = no-domain
   * bucket. Empty = no `## Triggered` block in the prompt.
   */
  triggeredReads?: Array<string | null>;
}
```

### `KNOWN_PROMPT_PLACEHOLDERS` — add `triggered`

```ts
export const KNOWN_PROMPT_PLACEHOLDERS = {
  prompt:         '{{prompt}}',
  persona:        '{{persona}}',
  memory:         '{{memory}}',
  thinking:       '{{thinking}}',
  triggered:      '{{triggered}}',  // ← NEW
  fields_schema:  '{{fields_schema}}',
  fields_current: '{{fields_current}}',
} as const;
```

### New addon config shape: `TriggeredContextConfig`

```ts
interface TriggeredContextConfig {
  /** User-editable instance name shown on the chain card. */
  name?: string;
  /**
   * Where matched rule texts get written in the brain's `triggered`
   * section. Defaults to `'scripts'`. Same configurable-domain pattern
   * as Thinker. Multiple Triggered Context loaders can coexist in one
   * crew with different domains (`scripts`, `tone-overrides`, …).
   */
  domain: string;
  rules: TriggeredRule[];
}

interface TriggeredRule {
  id: ID;
  /** Optional human label for the rule list. */
  label?: string;
  /**
   * Conditions to match. ALL must pass (AND). For OR semantics, add
   * another rule. Reuses the EXACT same shape as
   * `TransitionRouterConfig.conditions`.
   */
  conditions: TransitionCondition[];
  /**
   * The memory key inside `triggered.<domain>` to write the matched
   * text into. Each rule writes to its own field so different rules'
   * outputs accumulate (rather than overwriting each other).
   */
  field: string;
  /** The text injected when the rule's conditions match. */
  contextText: string;
}
```

### Storage shape — three sections

```ts
// Before (Phase 5)
type BrainBlob = {
  memory:   Record<string, Record<string, unknown>>;
  thinking: Record<string, Record<string, unknown>>;
};

// After (Phase 6)
type BrainBlob = {
  memory:    Record<string, Record<string, unknown>>;
  thinking:  Record<string, Record<string, unknown>>;
  triggered: Record<string, Record<string, unknown>>;  // ← NEW
};
```

### `kind` extended on memoryWrites

`AddonInstance.run()` returns `memoryWrites` whose `kind` field now
admits three values:

```ts
{
  kind: 'memory' | 'thinking' | 'triggered';  // 'memory' default
  domain: string | null;
  field: string;
  value: unknown;
}
```

Existing addons (Field/Vibe Extractor, Thinker) emit `'memory'` and
`'thinking'` respectively. The Triggered Context plugin emits
`'triggered'`. No new outputType — `json-to-memory` semantically still
covers it (JSON parsed into structured writes); the *kind* per write
routes between sections.

---

## The new addon

### Descriptor — `aspect-agent-server/builder/addons/triggeredContext.addon.json`

```jsonc
{
  "pluginId":          "triggered-context",
  "displayName":       "Triggered Context",
  "description":       "Inject deterministic guidance when conditions match.",
  "purpose":           "Loads pre-scripted guidance into memory's `triggered` section based on hard-coded rules over field values. Reach for this when you know exactly what the talker / thinker should be told under a specific condition — e.g. 'when intent == complaint, follow this de-escalation script'. Place upstream of the Thinker / Talker (or whichever addon consumes its output). Each rule has conditions (AND-of-clauses, same vocabulary as Transition Router) and a text body. Matched rules write their text to `triggered.<domain>.<field>` — downstream addons read via their `triggeredReads` config, mirroring how they read memory / thinking. No LLM call.",
  "icon":              "🎯",
  "color":             "#0ea5e9",

  "defaultLane":       "main",
  "fieldMode":         "none",
  "speaks":            false,
  "requiresModel":     false,

  "allowedOutputTypes": ["json-to-memory"],
  "defaultOutputType":  "json-to-memory",

  "defaultContext": {
    "history":      { "mode": "none" },
    "persona":      false,
    "memoryReads":  [],
    "thinkingReads": []
  },

  "defaultPromptTemplate": "",

  "defaultConfig": {
    "name":   "",
    "domain": "scripts",
    "rules":  []
  },

  "hideStandardSections": {
    "context": true,
    "output":  true,
    "promptTemplate": true,
    "repository": false
  }
}
```

**Why color `#0ea5e9` (sky-blue)** — wait, Transition Router already
owns sky-blue. Need to pick a different one. Candidates:

- `#06b6d4` (cyan) — close cousin of sky but distinct.
- `#84cc16` (lime) — bright, "loaded/active" feel.
- `#a855f7` (purple) — already too close to Talker's violet.
- `#f97316` (orange) — bright, attention-grabbing, distinct from amber Field Extractor.
- **`#06b6d4` (cyan) — my pick.** Cool, technical, paired-but-different from the sky-blue Transition Router. Fits 🎯's "targeting" mood.

Final descriptor color: `#06b6d4`.

### Server plugin — `aspect-agent-server/builder/plugins/triggeredContext/addon.triggeredContext.js`

```js
const { registerPlugin } = require('../../runtime/pluginRegistry');
const descriptor = require('../../addons/triggeredContext.addon.json');
const { evaluateConditions } = require('../../runtime/conditionMatcher');  // shared

async function run(ctx) {
  const start = Date.now();
  const cfg = ctx.instance.config || {};
  const domain = (cfg.domain && cfg.domain.trim()) ? cfg.domain.trim() : 'scripts';
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];

  // Build memoryWrites by walking rules in declared order. Each rule
  // writes its `contextText` into `triggered.<domain>.<rule.field>`
  // when its conditions match. Non-matching rules → no write.
  // Concatenate (not overwrite) when multiple rules target the same
  // (domain, field) pair by joining their texts under headers — fits
  // the user's stated preference for concatenation when rules collide.
  const matched = rules.filter(r => evaluateConditions(r.conditions, ctx.memory));

  // Group by field so multiple matches on the same field concat cleanly.
  const byField = new Map();
  for (const r of matched) {
    if (!r.field || typeof r.contextText !== 'string') continue;
    if (!byField.has(r.field)) byField.set(r.field, []);
    byField.get(r.field).push(r.contextText);
  }

  const memoryWrites = [];
  for (const [field, texts] of byField) {
    memoryWrites.push({
      kind: 'triggered',
      domain,
      field,
      value: texts.join('\n\n'),
    });
  }

  return {
    rawOutput:    JSON.stringify({ matched: matched.map(r => r.id) }, null, 2),
    parsedOutput: { matched: matched.map(r => r.id) },
    memoryWrites,
    durationMs:   Date.now() - start,
    tokens:       { input: 0, output: 0, total: 0 },
  };
}

registerPlugin({
  id:                 descriptor.pluginId,
  allowedOutputTypes: descriptor.allowedOutputTypes,
  requiresModel:      false,
  run,
});

module.exports = { TRIGGERED_CONTEXT_PLUGIN_ID: descriptor.pluginId };
```

### Shared `conditionMatcher` — extract from Transition Router

Today `addon.transitionRouter.js` has the condition-matching logic
inline. Extract into `aspect-agent-server/builder/runtime/conditionMatcher.js`
so both Transition Router AND Triggered Context use the same matcher.
One condition vocabulary, one place to maintain it.

```js
// conditionMatcher.js
const builderMemory = require('./builderMemory');

/**
 * Evaluate AND-of-conditions against the current brain blob's memory
 * section. Used by Transition Router and Triggered Context.
 *
 * @param {TransitionCondition[]} conditions
 * @param {BrainBlob} brain  — full blob (matcher only reads memory section today)
 * @returns {boolean}  — true iff EVERY condition matches
 */
function evaluateConditions(conditions, brain) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  return conditions.every(c => evaluateOne(c, brain));
}

function evaluateOne(condition, brain) {
  // ... extracted verbatim from current TransitionRouter implementation,
  // adapted to read from brain.memory instead of the legacy flat blob.
}

module.exports = { evaluateConditions };
```

### Client wrapper + ConfigComponent

- `aspect-react-client/src/builder/plugins/triggeredContext/addon.triggeredContext.ts`
  — standard wrapper hydrating the descriptor JSON.
- `aspect-react-client/src/builder/plugins/triggeredContext/TriggeredContextConfig.tsx`
  — config screen with:
  - Name input
  - Domain input (default `scripts`)
  - Rule list — each row uses the existing **`ConditionsEditor`**
    component from Transition Router (same component, no duplication).
    Plus: field name input + multi-line textarea for `contextText` +
    optional `label` input.
  - "+ Add rule" button

**Reuse alert**: the Transition Router's `ConditionsEditor` becomes a
shared component used by both Transition Router and Triggered Context.
Move it from `plugins/transitionRouter/` to `components/Conditions/`
so the import path doesn't make Triggered Context look like it
depends on Transition Router's internals.

### Both `plugins/index.{ts,js}` register the new plugin.

---

## Prompt assembly

### Server (`promptAssembler.js`) — add `buildTriggeredBlock`

Mirrors `buildMemoryBlock` / `buildThinkingBlock`:

```js
function buildTriggeredBlock(selectedDomains, valuesByDomain) {
  if (!selectedDomains || selectedDomains.length === 0) return '';
  const sections = selectedDomains.map(d => {
    const label = d === null ? 'general' : d;
    const map = valuesByDomain(d) || {};
    return `### ${label}\n${JSON.stringify(map, null, 2)}`;
  });
  return `## Triggered\n${sections.join('\n\n')}`;
}
```

In `assemblePrompt`, add a new substitution:

```js
return substitute(template, {
  prompt:         cfg.prompt || '',
  persona:        buildPersonaBlock(agentPersona, !!instance.context?.persona),
  memory:         buildMemoryBlock(instance.context?.memoryReads || [], memoryValuesByDomain),
  thinking:       buildThinkingBlock(instance.context?.thinkingReads || [], thinkingValuesByDomain),
  triggered:      buildTriggeredBlock(instance.context?.triggeredReads || [], triggeredValuesByDomain),  // ← NEW
  fields_schema:  isExtractor ? buildFieldsSchemaBlock(fields) : '',
  fields_current: isExtractor ? buildFieldsCurrentBlock(fields, fieldValueOf) : '',
});
```

And the BuilderRunner exposes the new accessor:

```js
const triggeredValuesByDomain = (domain) => builderMemory.valuesForDomain(memory, domain, 'triggered');
```

### Client (`buildPromptPreview.ts`) — matching `buildTriggeredBlock`

Byte-equality contract with the server. Same as `memory` / `thinking`
preview blocks — empty `{}` per domain at preview time, real values
substituted at runtime.

### Default templates

Talker's default template grows:

```
{{persona}}

{{prompt}}

{{memory}}

{{thinking}}

{{triggered}}
```

Thinker's default template grows the same way. Existing instances
keep their snapshotted templates per the V2 convention — users update
by re-saving or recreating. New instances pick up the new placeholder.

---

## Storage extension

[`builderMemory.js`](../../builder/runtime/builderMemory.js) extends
from two sections to three. Concretely:

```js
const SECTION_MEMORY    = 'memory';
const SECTION_THINKING  = 'thinking';
const SECTION_TRIGGERED = 'triggered';  // ← NEW
const SECTIONS = [SECTION_MEMORY, SECTION_THINKING, SECTION_TRIGGERED];

function sectionKey(kind) {
  if (kind === SECTION_THINKING)  return SECTION_THINKING;
  if (kind === SECTION_TRIGGERED) return SECTION_TRIGGERED;
  return SECTION_MEMORY;
}
```

`normalizeBlob` handles the third section the same way:

```js
function normalizeBlob(raw) {
  if (!raw || typeof raw !== 'object') {
    return { memory: {}, thinking: {}, triggered: {} };
  }
  if (raw.memory || raw.thinking || raw.triggered) {
    return {
      memory:    raw.memory    || {},
      thinking:  raw.thinking  || {},
      triggered: raw.triggered || {},  // ← NEW
    };
  }
  return { memory: raw, thinking: {}, triggered: {} };  // legacy
}
```

`applyWrites` routes by `kind`; the existing switch already covers
the new section the moment `'triggered'` is a recognized value.

Server routes (`/conversations/:id/memory`) return all three sections
in the response. Client `BrainSection` type covers it. Client
`conversationMemory` state grows from `{ memory, thinking }` to
`{ memory, thinking, triggered }`.

`applyLocalMemoryWrites` routes the optimistic local merge based on
each write's `kind` — same pattern as the thinking extension.

PATCH endpoint accepts `kind: 'memory' | 'thinking' | 'triggered'` so
the existing field-edit modal can manually set values in any section
(only memory uses this today; future-proofs the API).

---

## UI

### 1. New addon in the Add Step picker

Appears as 🎯 Triggered Context (cyan accent). The picker already
reads from the plugin registry — adding the descriptor + registering
the plugin is enough; no Add-Step code changes.

### 2. Chain canvas card

Standard addon card with:
- 🎯 icon, cyan accent strip
- Name: user's `config.name` or "Triggered Context [#N]" fallback
- Subtitle: `N rules` (counted from `config.rules.length`)
- No model line (no LLM call, `requiresModel: false`)

### 3. Config modal — `TriggeredContextConfig`

Three sections:

**a) Identity**:
- Name input
- Writes-to chip: `triggered · <domain>` (domain editable inline)

**b) Rules list**:

```
┌─────────────────────────────────────────────────┐
│ Rules (3)                            [+ Add rule]│
├─────────────────────────────────────────────────┤
│ ▾ Complaint route                              ×│
│   IF intent equals 'complaint'                   │
│   WRITE TO: handling_guide                       │
│   ┌─────────────────────────────────────────┐   │
│   │ ## Complaint Handling                    │   │
│   │                                          │   │
│   │ Rule #1: Never be defensive...           │   │
│   └─────────────────────────────────────────┘   │
│ ─────────────────────────────────────────────── │
│ ▸ Open-account route                           ×│
│ ─────────────────────────────────────────────── │
│ ▸ Stubborn customer                            ×│
└─────────────────────────────────────────────────┘
```

Each rule row:
- Collapsible (label header shown when collapsed)
- Label input
- `ConditionsEditor` (reused from Transition Router) for the condition list
- Field input (`writes-to`)
- Multi-line textarea for `contextText`
- × delete button

**c) Standard sections** (`history`, `persona`, output, prompt
template) are hidden — `requiresModel: false` means none of them apply.

### 4. New brain panel — `TriggeredPanel` (below the Cortex)

Sibling of `ThinkingPanel`. Reads from `conversationMemory.triggered`.
Same lavender-style card layout but **cyan** tint to match the addon
color:

```
🎯 Triggered
   What pre-scripted guidance fired this turn.

  ┌ scripts ───────────────────────┐
  │ handling_guide                  │
  │ ## Complaint Handling           │
  │ Rule #1: Never be defensive...  │
  └─────────────────────────────────┘
```

Visibility rule — same as ThinkingPanel:
- No Triggered Context addon in the crew → hide entirely.
- Addon exists, no rules matched yet → empty-state hint.
- Addon exists + matches landed → render cards.

### 5. Talker / Thinker config — `triggeredReads` picker

In [`AddonContextSection`](../../../aspect-react-client/src/builder/components/AddonContext/AddonContextSection.tsx),
add a third group below Memory and Thinking:

```
🎯 Triggered
  ☐ scripts
  ☐ tone-overrides
```

Domains shown = `config.domain` from every Triggered Context addon in
this crew, deduped + sorted. Plus any currently-selected domain that's
not present (so deletes don't strand selections).

### 6. Picker chips with 🎯 prefix

The chips render as `🎯 <domain>` for consistency with how Thinking
chips render `💭 <domain>`. Visual cue: brain section determines the
prefix emoji.

### 7. Visible memory editing — PATCH endpoint

The existing field-edit modal lets users manually edit memory values.
Future enhancement (not required for v1): a similar affordance to
manually edit triggered values for testing — bypasses rules. Not
needed for first ship.

---

## Order matters

The Triggered Context addon must run **before** any addon that reads
from `triggered`. Standard chain-ordering concern — same as today's
"Field Extractor before Talker." Two mitigations:

1. **Doc + picker hint**: when adding a Triggered Context addon, the
   picker hint reads "Place upstream of addons that will consume its
   output."
2. **Soft warning in the config modal**: when an addon's
   `triggeredReads` is non-empty AND there's no Triggered Context
   addon upstream in the chain, show a warning chip "⚠ no upstream
   loader — these reads will be empty."

The soft warning is a stretch goal — not blocking initial ship.

---

## Decision journal

Continues from Builder V2 decision sequence.

**61. Triggered Context is an addon, not a per-field property.** Rules
   live in an addon's config (like Transition Router's), not on
   FieldDef. Reason: every other behavior is an addon; introducing a
   `FieldDef.triggers[]` would split the architecture.

**62. New brain section `triggered` parallel to memory and thinking.**
   Output of the loader goes into a third section, consumed via the
   same `Reads` picker pattern as memory and thinking. Real-time
   inspection happens in a new TriggeredPanel sibling of ThinkingPanel.

**63. `outputType` stays `json-to-memory`; `kind` routes per write.**
   Adding a new outputType `'triggered-to-memory'` would imply each
   addon writes to only one section, which is false (Thinker writes
   to thinking, Triggered Context writes to triggered, but both
   conceptually emit "structured data to brain"). Per-write `kind`
   keeps outputType as a SHAPE descriptor, not a routing one.

**64. ConditionsEditor is extracted from Transition Router.** Moved
   to `components/Conditions/` and shared. One condition vocabulary,
   one component to maintain. Both Transition Router and Triggered
   Context import it. Same logic on the server in `conditionMatcher.js`.

**65. Multiple matching rules concatenate, not overwrite.** When two
   rules write to the same `(domain, field)`, their `contextText`
   values are joined with `\n\n`. Rationale: rules are user-authored
   and probably non-overlapping; collisions are likely intentional
   ("here's the complaint bit AND here's the price-objection bit").

**66. Brain analogue: basal ganglia.** Procedural memory — automatic
   scripts fired by patterns. The Lybi brain KB page gets a seventh
   region.

**67. Default domain `'scripts'`.** Matches Thinker's default
   `'strategy'` shape. Configurable per-instance. Multiple Triggered
   Context loaders in a crew can write to different domains.

---

## File layout

```
aspect-agent-server/
  builder/
    addons/
      triggeredContext.addon.json       ← NEW descriptor
    plugins/
      triggeredContext/
        addon.triggeredContext.js        ← NEW server plugin
      index.js                           ← register new plugin
    runtime/
      conditionMatcher.js                ← EXTRACTED from transitionRouter
      builderMemory.js                   ← extend to 3 sections
      promptAssembler.js                 ← buildTriggeredBlock + substitute
      BuilderRunner.js                   ← thread triggeredValuesByDomain
    routes/
      runtimeRoute.js                    ← GET/PATCH /memory returns 3 sections

aspect-react-client/src/builder/
  plugins/
    triggeredContext/
      addon.triggeredContext.ts          ← NEW client wrapper
      TriggeredContextConfig.tsx          ← NEW config screen
      TriggeredContextConfig.module.css   ← NEW
    index.ts                              ← register new plugin
  components/
    Conditions/                           ← EXTRACTED shared component
      ConditionsEditor.tsx
      ConditionsEditor.module.css
    TriggeredPanel/                       ← NEW
      TriggeredPanel.tsx
      TriggeredPanel.module.css
    Canvas/CrewView.tsx                   ← mount TriggeredPanel
    AddonContext/AddonContextSection.tsx  ← add Triggered group
    PromptTemplateModal/buildPromptPreview.ts ← buildTriggeredBlock
  state/
    builderApi.ts                         ← ConversationMemory grows
    BuilderContext.tsx                    ← conversationMemory state grows
  types/index.ts                          ← AddonContext.triggeredReads
                                            + KNOWN_PROMPT_PLACEHOLDERS.triggered
                                            + TriggeredContextConfig
                                            + TriggeredRule
```

---

## Sister-doc updates

- **[BUILDER_V2.md](./BUILDER_V2.md)** — Data model section mentions
  the third brain section. Quick paragraph on Triggered Context as an
  addon.
- **[BUILDER_V2_SCHEMA.md](./BUILDER_V2_SCHEMA.md)** — Brain blob shape
  updated (3 sections). Plugin registry adds the new plugin. The
  invariants section notes:
  - "A Triggered Context addon must precede addons that consume its
    output in the chain."
  - "Per-write `kind` admits three values: `memory` | `thinking` | `triggered`."
- **[BUILDER_V2_ADDONS.md](./BUILDER_V2_ADDONS.md)** — Documents the
  `requiresModel: false` pattern (already used by Transition Router,
  now also Triggered Context). Documents `hideStandardSections` for
  no-LLM addons.
- **[BUILDER_V2_ALFRED.md](./BUILDER_V2_ALFRED.md)** — Alfred's
  schema-doc reference will pick up the new addon automatically when
  the descriptor lands in `addons/`. No code change in Alfred's plan.
- **Lybi KB brain page**
  ([LybiBrainPage.tsx](../../../aspect-react-client/src/pages/LybiBrainPage.tsx)) — add a
  seventh region to the mapping slide: "Basal ganglia / procedural
  memory → Triggered Context."

---

## Phasing

**P6.1 — Foundation** (~1 session)
- Extract `conditionMatcher.js` from `transitionRouter`.
- Extract `ConditionsEditor` from `plugins/transitionRouter/` into
  shared `components/Conditions/`. Both client paths swap to it.
- Storage extension: add `triggered` section to `builderMemory.js`
  with read-time fallback. Add `'triggered'` to `kind` routing.
- Type updates: `AddonContext.triggeredReads`,
  `KNOWN_PROMPT_PLACEHOLDERS.triggered`, `TriggeredContextConfig`.
- Prompt assembler + client preview: `buildTriggeredBlock` +
  `{{triggered}}` substitution (byte-equal).
- BuilderRunner: expose `triggeredValuesByDomain` accessor.
- Routes: GET/PATCH `/memory` return three sections.

**P6.2 — The addon** (~half session)
- `triggeredContext.addon.json` descriptor.
- Server plugin: evaluate rules → emit `kind: 'triggered'` writes.
- Client wrapper + `TriggeredContextConfig.tsx` rule editor.
- Register both sides.

**P6.3 — Consumption UI** (~half session)
- `TriggeredPanel.tsx` (sibling of ThinkingPanel) mounted in CrewView.
- `AddonContextSection` gains the Triggered group with 🎯 chips.
- Talker / Thinker descriptor defaults: `defaultPromptTemplate`
  extended with `{{triggered}}`; `defaultContext.triggeredReads: []`.

**P6.4 — Polish** (~quick)
- Lybi KB brain page: add the basal ganglia / Triggered Context row.
- Soft "⚠ no upstream loader" warning chip in the AddonContext picker
  when reads are set but no Triggered Context exists upstream.

**Total scope estimate**: 2 sessions to ship, 1 more for polish.

---

## Open items deferred

- **Manual editing of triggered values from the UI** — the PATCH
  endpoint accepts `kind: 'triggered'` (future-proofed), but no UI
  affordance yet. Add when a use case demands.
- **Agent-level Triggered Context** — currently crew-scoped (lives in
  a crew's chain). Agent-level chains aren't a concept in V2 yet;
  when they land (per user's note), Triggered Context lives there
  naturally.
- **Rule templates / sharing** — copy a rule from one loader to
  another. Not necessary for first iteration.
- **Composition / nested conditions** — V1 supports only AND-of-conditions
  per rule (matches Transition Router today). OR via multiple rules.
  Add nested grouping when a real use case appears.
- **Rule logging in `agent_log`** — track when a rule's text changes
  (it affects prompt content). Aligns with Alfred's `agent_log`
  approach. Defer; not blocking the feature.

---

## What I need from you (the next session) before starting

1. Confirm the `conditionMatcher` extraction lands in
   `aspect-agent-server/builder/runtime/conditionMatcher.js`.
2. Confirm `ConditionsEditor` extraction lands in
   `aspect-react-client/src/builder/components/Conditions/`.

**No migration needed**: when Thinking shipped, every brain blob in
the DB was already moved to the `{memory, thinking}` section-keyed
shape (`normalizeBlob` ensured it on every read/write). Adding the
third section is just `triggered: raw.triggered || {}` — defaulting a
missing optional. No DB script, no read-path fallback to design. The
legacy-flat-blob fallback from the Thinking phase still exists and
covers any unmigrated blob; new Triggered code piggybacks on it.

If both extraction points are yes, P6.1 + P6.2 are mechanical.
