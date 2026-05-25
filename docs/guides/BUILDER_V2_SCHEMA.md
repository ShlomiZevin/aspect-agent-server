# Builder V2 — JSON Schema (Canonical Reference)

> **What this is.** The single source of truth for every JSON shape the
> V2 builder produces and consumes. Maintained by hand. Read by Alfred's
> patch generator at runtime — if this doc drifts from the code, Alfred
> emits invalid bodies.
>
> **Maintenance rule.** Whenever you change
> [aspect-react-client/src/builder/types/index.ts](../../../aspect-react-client/src/builder/types/index.ts)
> OR add / remove / modify a plugin descriptor under
> [aspect-react-client/src/builder/plugins/](../../../aspect-react-client/src/builder/plugins/),
> update this doc **in the same commit**. The "Last verified against
> code" line below must reflect the change.
>
> **Last verified against code:** 2026-05-23 (multi-extractor field model,
> `FieldExtractorConfig.extractsFields[]`, no `FieldDef.scope`).
>
> **Sister docs:** [BUILDER_V2.md](./BUILDER_V2.md) for architecture,
> [BUILDER_V2_ALFRED.md](./BUILDER_V2_ALFRED.md) for how Alfred uses this.

---

## Table of contents

1. [The three-level document](#1-the-three-level-document)
2. [Type definitions](#2-type-definitions)
3. [Plugin registry](#3-plugin-registry)
4. [Prompt placeholders](#4-prompt-placeholders)
5. [Invariants (not expressible in types)](#5-invariants-not-expressible-in-types)
6. [Canonical example bodies](#6-canonical-example-bodies)
7. [Working copy vs. version snapshot](#7-working-copy-vs-version-snapshot)
8. [What Alfred sees and how](#8-what-alfred-sees-and-how)

---

## 1. The three-level document

```
ProjectDoc
└── agents: AgentDoc[]
    ├── (versioned body) AgentBody:
    │     name, slug, spec, persona, defaultCrewId, fields[]
    ├── (not in body)    crews: CrewDoc[]
    ├── versions: AgentVersion[]
    ├── activeVersionId, viewingVersionId
    └── crews: CrewDoc[]
        ├── (versioned body) CrewBody:
        │     name, description?, spec, persona?, addons[], fields[]
        ├── versions: CrewVersion[]
        └── activeVersionId, viewingVersionId
```

Crews are **siblings** of an agent's version history — they're their own
versioned entities, NOT inside `AgentBody`. Promoting an agent version
never disrupts crew membership.

---

## 2. Type definitions

Verbatim from
[aspect-react-client/src/builder/types/index.ts](../../../aspect-react-client/src/builder/types/index.ts).
Comments preserve invariants and intent — keep them when copying back.

### 2.1 Primitives

```ts
type ID = string;

interface ModelRef {
  providerId: string;
  modelId: string;
}
```

### 2.2 Fields

```ts
type FieldType = 'string' | 'int' | 'enum' | 'boolean';

/** Where a field value comes from. */
type FieldSource =
  | 'explicit'   // only when the user literally says it
  | 'inferred';  // can be concluded from conversation patterns

/**
 * Where the field lives in the JSON.
 *  - 'agent': stored on AgentBody.fields[]  — visible from any crew.
 *  - 'crew':  stored on CrewBody.fields[]   — visible only in its
 *             owning crew.
 *
 * Scope is determined by *location* (which array the FieldDef lives
 * in), NOT by a tag on the field itself. FieldDef does NOT carry a
 * `scope` property — that would let it drift from reality.
 */
type FieldScope = 'agent' | 'crew';

interface FieldDef {
  id: ID;
  name: string;                 // canonical key, snake_case
  type: FieldType;
  source: FieldSource;
  /** Free-text guidance on how to extract this field. */
  howToExtract: string;
  /** Only for type === 'enum'. */
  enumValues?: string[];
  /**
   * Optional memory grouping. Blank/undefined = "(no domain)" — the
   * field is still captured to a `_general` bucket at runtime, just
   * not surfaced under a named group.
   */
  domain?: string;
}
```

### 2.3 Addons (plugin instances inside a crew)

```ts
/**
 * Where an addon instance runs. Chosen by the user when adding the
 * instance — NOT a fixed property of the plugin. A single plugin
 * (e.g. Field Extractor) may run in different lanes in different
 * crews.
 */
type AddonLane = 'main' | 'background' | 'offline';

interface HistoryMode {
  mode: 'none' | 'last_n' | 'full';
  /** Only meaningful when mode === 'last_n'. */
  n?: number;
}

/**
 * Universal reading knobs every addon has, regardless of plugin.
 * Persona default OFF (user opts in). Memory reads default empty
 * (user opts in). History default = { mode: 'last_n', n: 5 }.
 */
interface AddonContext {
  history: HistoryMode;
  /** Inject the agent persona into the prompt. Default off. */
  persona: boolean;
  /**
   * List of memory domains to inject. null denotes "(no domain)".
   * Empty list = no `## Memory` section in the prompt.
   */
  memoryReads: Array<string | null>;
}

/**
 * What this addon produces at runtime.
 */
type OutputType =
  | 'text-to-user'    // Talker — text response sent to chat
  | 'json-to-memory'  // Field Extractor — structured fields → memory
  | 'transition';     // Transition Router — emits a next-crew handoff

interface AddonInstance<TConfig = unknown> {
  /** Unique within the crew. */
  instanceId: ID;
  /** Refers to a registered plugin id. */
  pluginId: string;
  lane: AddonLane;
  enabled: boolean;
  /** Plugin-defined config blob. See § 2.5–2.7. */
  config: TConfig;
  /** Universal reading knobs (history / persona / memory). */
  context: AddonContext;
  /**
   * What this instance produces — chosen from the plugin's
   * allowedOutputTypes list. Default snapshotted from
   * defaultOutputType at create time. User-configurable.
   */
  outputType: OutputType;
  /**
   * Source-of-truth prompt template. Snapshotted from
   * PluginDescriptor.defaultPromptTemplate at create time so the
   * server runtime and client preview use the same string.
   * Uses placeholders from § 4.
   */
  promptTemplate: string;
}
```

### 2.4 Plugin-specific config shapes

```ts
interface FieldExtractorConfig {
  prompt: string;
  model: ModelRef;
  /**
   * User-editable name for this extractor instance. Lets users
   * distinguish "Date Extractor" from "Intent Extractor" in the
   * chain canvas. Empty → falls back to "Field Extractor [#N]".
   */
  name?: string;
  /**
   * IDs of FieldDefs (from agent.fields ∪ owning crew.fields)
   * that this extractor pulls out of the conversation. The same
   * field id can appear in multiple extractors' lists; memory
   * writes are keyed by name and the last write wins per turn.
   */
  extractsFields: ID[];
}

interface TalkerConfig {
  /** The voice prompt — what the crew is supposed to say and how. */
  prompt: string;
  model: ModelRef;
}
```

### 2.5 Transition Router config

```ts
type FieldOp =
  | 'equals' | 'not-equals'
  | 'contains' | 'starts-with' | 'ends-with'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not-in';

type TransitionCondition =
  | { type: 'fields-collected'; fields: string[] }
  | {
      type: 'field';
      field: string;          // field NAME (not id)
      op: FieldOp;
      /** Scalar value for binary ops; ignored for 'in' / 'not-in'. */
      value?: unknown;
      /** Multi-value for 'in' / 'not-in'; ignored for binary ops. */
      values?: unknown[];
    };

interface TransitionRouterConfig {
  /** ALL conditions must match (AND). For OR, add a second router. */
  conditions: TransitionCondition[];
  /** Crew to transition to when conditions match. */
  target: ID;
  /** Optional human-readable note shown in the AddonRunCard. */
  reason?: string;
  /**
   * What to do with the rest of THIS turn's chain after a match:
   *  - 'continue' (default) — remaining addons run; Talker (if
   *    downstream) speaks once more from the current crew; NEXT
   *    user turn lands on `target`.
   *  - 'break' — remaining addons skipped; no Talker response this
   *    turn; next user turn lands on `target`.
   */
  onMatch: 'continue' | 'break';
}
```

**FieldOp allowed by FieldType**:

| FieldType | Allowed ops                                                              |
| --------- | ------------------------------------------------------------------------ |
| `enum`    | `equals`, `not-equals`, `in`, `not-in`                                   |
| `string`  | `equals`, `not-equals`, `contains`, `starts-with`, `ends-with`, `in`, `not-in` |
| `int`     | `equals`, `not-equals`, `gt`, `gte`, `lt`, `lte`                         |
| `boolean` | `equals`, `not-equals`                                                   |

### 2.6 Documents (the three levels)

```ts
type CrewBody = Pick<
  CrewDoc,
  'name' | 'description' | 'spec' | 'persona' | 'addons' | 'fields'
>;

interface CrewVersion {
  id: ID;
  number: number;                // monotonic, starting at 1
  description?: string;           // human label from "Save as…"
  createdAt: string;             // ISO timestamp
  body: CrewBody;                // frozen snapshot
}

interface CrewDoc {
  id: ID;

  // ── Working copy (editable; tracks the *viewing* version) ──
  name: string;
  description?: string;
  spec: string;
  persona?: string;
  addons: AddonInstance[];       // chain of plugin instances
  fields: FieldDef[];            // crew-scoped field definitions

  // ── Versioning ──
  versions: CrewVersion[];
  /** The version the agent actually runs at runtime. */
  activeVersionId: ID;
  /** The version currently loaded into the working copy. */
  viewingVersionId: ID;
}

type AgentBody = Pick<
  AgentDoc,
  'name' | 'slug' | 'spec' | 'persona' | 'defaultCrewId' | 'fields'
>;

interface AgentVersion {
  id: ID;
  number: number;
  description?: string;
  createdAt: string;
  body: AgentBody;
}

interface AgentDoc {
  id: ID;
  slug: string;                   // URL slug, /:slug/builder
  name: string;
  spec: string;
  persona: string;
  defaultCrewId?: ID;
  fields: FieldDef[];             // agent-scoped field definitions
  /** NOT part of AgentBody — crews are their own versioned entities. */
  crews: CrewDoc[];
  versions: AgentVersion[];
  activeVersionId: ID;
  viewingVersionId: ID;
}

interface ProjectDoc {
  id: ID;
  name: string;
  spec: string;
  agents: AgentDoc[];
}
```

---

## 3. Plugin registry

Three built-in plugins. The `pluginId` is the stable identifier inside
`AddonInstance.pluginId` — never change these strings.

### 3.1 Talker — `talker`

```ts
{
  id: 'talker',
  name: 'Talker',
  icon: '💬',
  color: '#8b5cf6',
  defaultLane: 'main',
  fieldMode: 'none',
  speaks: true,
  allowedOutputTypes: ['text-to-user'],
  defaultOutputType: 'text-to-user',
  defaultContext: {
    history: { mode: 'last_n', n: 5 },
    persona: false,
    memoryReads: [],
  },
  defaultPromptTemplate: `{{persona}}

{{prompt}}

{{memory}}`,
  defaultConfig: (): TalkerConfig => ({
    prompt: '',
    model: DEFAULT_BALANCED_MODEL,
  }),
}
```

Every new crew gets one Talker by default. The Talker owns the crew's
response prompt — the crew has no prompt of its own.

### 3.2 Field Extractor — `field-extractor`

```ts
{
  id: 'field-extractor',
  name: 'Field Extractor',
  icon: '📥',
  color: '#f59e0b',
  defaultLane: 'main',
  fieldMode: 'extractor',
  allowedFieldSources: ['explicit', 'inferred'],
  speaks: false,
  allowedOutputTypes: ['json-to-memory'],
  defaultOutputType: 'json-to-memory',
  defaultContext: {
    history: { mode: 'last_n', n: 3 },
    persona: false,
    memoryReads: [],
  },
  defaultPromptTemplate: `{{prompt}}

## Field schema
{{fields_schema}}

## Already collected
{{fields_current}}

{{memory}}`,
  defaultConfig: (): FieldExtractorConfig => ({
    prompt:
      "Extract field values from the user's latest message and recent context.\n" +
      "Be precise — only extract what is clearly supported by the conversation.\n" +
      "For 'explicit' fields, capture only what the user literally said.\n" +
      "For 'inferred' fields, you may conclude based on patterns.",
    model: DEFAULT_FAST_MODEL,
    name: '',
    extractsFields: [],
  }),
}
```

### 3.3 Transition Router — `transition-router`

```ts
{
  id: 'transition-router',
  name: 'Transition Router',
  icon: '🔀',
  color: '#0ea5e9',
  defaultLane: 'main',
  fieldMode: 'none',
  speaks: false,
  allowedOutputTypes: ['transition'],
  defaultOutputType: 'transition',
  defaultContext: {
    history: { mode: 'none' },
    persona: false,
    memoryReads: [],
  },
  defaultPromptTemplate: '',   // no LLM call
  defaultConfig: (): TransitionRouterConfig => ({
    conditions: [],
    target: '',
    reason: '',
    onMatch: 'continue',
  }),
  hideStandardSections: {
    context: true,
    output: true,
    promptTemplate: true,
    repository: true,
  },
}
```

Doesn't call an LLM — evaluates conditions against the conversation
memory blob.

---

## 4. Prompt placeholders

Substituted by the runtime when assembling an addon's prompt parameter.
History and the latest user message are NOT placeholders — they're
passed to the LLM as a separate message-history parameter.

| Placeholder         | Replaced with                                                              | Used by |
| ------------------- | -------------------------------------------------------------------------- | ------- |
| `{{prompt}}`        | `instance.config.prompt`                                                   | Talker, Field Extractor |
| `{{persona}}`       | Agent persona text (or empty string when `context.persona === false`)      | Talker  |
| `{{memory}}`        | `## Memory` block built from `context.memoryReads` (empty when no reads)   | Any     |
| `{{fields_schema}}` | `## Field schema` block — name, type, allowed enum values, source, how-to-extract | Extractor only |
| `{{fields_current}}` | `## Already collected` block — JSON map of current field values (nulls OK) | Extractor only |

---

## 5. Invariants (not expressible in types)

These are rules the model must enforce; failing them produces an invalid
body even if the JSON parses.

### 5.1 Identity & references

- `AgentDoc.id`, `CrewDoc.id`, `AddonInstance.instanceId`, `FieldDef.id`,
  `*Version.id` are all unique strings. Use UUIDs or `uid('prefix')`
  format (`agent_xxx`, `crew_xxx`, `addon_xxx`, `field_xxx`, `ver_xxx`).
- `instanceId` must be unique **within its crew**.
- `FieldDef.id` must be unique **within its owning array**
  (`agent.fields[]` or a single `crew.fields[]`). The same field NAME
  may exist on agent + crew (it's confusing — avoid — but not invalid).
- `AgentDoc.defaultCrewId` must reference an id in `AgentDoc.crews[]`.
- `TransitionRouterConfig.target` must reference an id of another crew
  in the same agent.
- `FieldExtractorConfig.extractsFields[]` ids must each resolve in
  `agent.fields ∪ owning_crew.fields`. An id that resolves nowhere is
  silently ignored at runtime — emit a warning, don't crash.

### 5.2 Versions

- Every `AgentDoc` / `CrewDoc` MUST have at least one version (the
  initial one). `versions[]` cannot be empty.
- `activeVersionId` and `viewingVersionId` MUST reference ids in
  `versions[]`.
- `versions[*].number` is monotonic per entity. Next number =
  `max(versions[*].number) + 1`. Don't reuse numbers.
- The version `body` is a frozen snapshot — when restoring a version,
  copy `body` over the working copy fields, don't aliase.

### 5.3 Addons

- Every crew SHOULD have at least one Talker addon. The runtime won't
  crash without one, but the user gets no response.
- An addon's `outputType` MUST be in its plugin's `allowedOutputTypes`.
- An addon's `promptTemplate` MUST only reference placeholders the
  plugin supports — Talker has no `{{fields_schema}}`, etc. Extra
  placeholders survive but render as literal text.
- Addons execute in `addons[]` order, filtered by lane. Order matters
  for transitions (router after talker behaves differently than before).

### 5.4 Fields

- `FieldDef.name` is the memory key. Use `snake_case`. No spaces.
- `FieldDef.type === 'enum'` REQUIRES non-empty `enumValues[]`. Other
  types MUST NOT carry `enumValues`.
- `FieldDef.source === 'inferred'` REQUIRES `howToExtract` to actually
  describe the inference rule. The extractor LLM uses it.
- A field's scope is its location, not a tag — move the FieldDef
  between `agent.fields` and `crew.fields` to change scope.
- The same field id may appear in multiple extractors'
  `extractsFields[]`. Memory writes are keyed by name; last write per
  turn wins.

### 5.5 Transition conditions

- `field` conditions reference a field by **name**, not id. Names are
  resolved against the conversation memory blob, which is keyed by
  name across domain buckets.
- Operator must be valid for the referenced field's declared type (see
  table in § 2.5). Wrong-type combinations are a validation error.
- `fields-collected` conditions list field NAMES that must be present
  (non-null) in memory for the router to fire.

---

## 6. Canonical example bodies

Three reference bodies. When the patch generator needs to add a
structure not present in the current document, it imitates these.

### 6.1 Minimal agent (one crew, one Talker)

```json
{
  "id": "agent_abc1234",
  "slug": "demo",
  "name": "Demo Agent",
  "spec": "",
  "persona": "",
  "defaultCrewId": "crew_xyz5678",
  "fields": [],
  "crews": [
    {
      "id": "crew_xyz5678",
      "name": "Welcome",
      "description": "",
      "spec": "",
      "addons": [
        {
          "instanceId": "addon_t0001",
          "pluginId": "talker",
          "lane": "main",
          "enabled": true,
          "config": {
            "prompt": "Greet the user warmly and ask what they need.",
            "model": { "providerId": "anthropic", "modelId": "claude-sonnet-4-6" }
          },
          "context": {
            "history": { "mode": "last_n", "n": 5 },
            "persona": false,
            "memoryReads": []
          },
          "outputType": "text-to-user",
          "promptTemplate": "{{persona}}\n\n{{prompt}}\n\n{{memory}}"
        }
      ],
      "fields": [],
      "versions": [
        {
          "id": "ver_v1_crew",
          "number": 1,
          "description": "Initial",
          "createdAt": "2026-05-23T00:00:00.000Z",
          "body": { /* matches working copy on first save */ }
        }
      ],
      "activeVersionId": "ver_v1_crew",
      "viewingVersionId": "ver_v1_crew"
    }
  ],
  "versions": [
    {
      "id": "ver_v1_agent",
      "number": 1,
      "description": "Initial",
      "createdAt": "2026-05-23T00:00:00.000Z",
      "body": { /* matches agent body on first save */ }
    }
  ],
  "activeVersionId": "ver_v1_agent",
  "viewingVersionId": "ver_v1_agent"
}
```

### 6.2 Crew with multi-extractor + Talker

Two extractors in the same crew, each pulling a different subset of
fields. The `intent` field lives on the agent (visible everywhere); the
`severity` field is crew-scoped.

```json
{
  "id": "crew_support",
  "name": "Support",
  "description": "Handles incoming support tickets",
  "spec": "Classify intent, collect severity, then talk.",
  "addons": [
    {
      "instanceId": "addon_intent",
      "pluginId": "field-extractor",
      "lane": "main",
      "enabled": true,
      "config": {
        "name": "Intent Extractor",
        "prompt": "Classify the user's intent from their latest message.",
        "model": { "providerId": "openai", "modelId": "gpt-4o-mini" },
        "extractsFields": ["field_intent"]
      },
      "context": { "history": { "mode": "last_n", "n": 3 }, "persona": false, "memoryReads": [] },
      "outputType": "json-to-memory",
      "promptTemplate": "{{prompt}}\n\n## Field schema\n{{fields_schema}}\n\n## Already collected\n{{fields_current}}\n\n{{memory}}"
    },
    {
      "instanceId": "addon_severity",
      "pluginId": "field-extractor",
      "lane": "main",
      "enabled": true,
      "config": {
        "name": "Severity Extractor",
        "prompt": "Score the issue severity 1–5 from cues in the conversation.",
        "model": { "providerId": "openai", "modelId": "gpt-4o-mini" },
        "extractsFields": ["field_severity"]
      },
      "context": { "history": { "mode": "last_n", "n": 5 }, "persona": false, "memoryReads": [] },
      "outputType": "json-to-memory",
      "promptTemplate": "{{prompt}}\n\n## Field schema\n{{fields_schema}}\n\n## Already collected\n{{fields_current}}\n\n{{memory}}"
    },
    {
      "instanceId": "addon_talker",
      "pluginId": "talker",
      "lane": "main",
      "enabled": true,
      "config": {
        "prompt": "Respond appropriately given the intent and severity.",
        "model": { "providerId": "anthropic", "modelId": "claude-sonnet-4-6" }
      },
      "context": { "history": { "mode": "last_n", "n": 8 }, "persona": true, "memoryReads": [null] },
      "outputType": "text-to-user",
      "promptTemplate": "{{persona}}\n\n{{prompt}}\n\n{{memory}}"
    }
  ],
  "fields": [
    {
      "id": "field_severity",
      "name": "severity",
      "type": "int",
      "source": "inferred",
      "howToExtract": "Score 1 (cosmetic) to 5 (outage) based on conversation cues."
    }
  ],
  "versions": [/* ... */],
  "activeVersionId": "...",
  "viewingVersionId": "..."
}
```

Corresponding agent has the shared `intent` field:

```json
"fields": [
  {
    "id": "field_intent",
    "name": "intent",
    "type": "enum",
    "enumValues": ["complaint", "sales", "support"],
    "source": "inferred",
    "howToExtract": "Classify the user message into one of: complaint, sales, support."
  }
]
```

### 6.3 Transition Router

Routes from the `Triage` crew to `Billing` when intent is sales-adjacent
and severity is low. Continues this turn (so the current Talker still
speaks); next user turn lands on `Billing`.

```json
{
  "instanceId": "addon_route_billing",
  "pluginId": "transition-router",
  "lane": "main",
  "enabled": true,
  "config": {
    "conditions": [
      { "type": "field", "field": "intent", "op": "in", "values": ["sales", "complaint"] },
      { "type": "field", "field": "severity", "op": "lte", "value": 2 }
    ],
    "target": "crew_billing",
    "reason": "Low-severity sales/complaint → Billing",
    "onMatch": "continue"
  },
  "context": { "history": { "mode": "none" }, "persona": false, "memoryReads": [] },
  "outputType": "transition",
  "promptTemplate": ""
}
```

---

## 7. Working copy vs. version snapshot

The top-level fields on `CrewDoc` / `AgentDoc` are the **working copy**
— the currently editable state. `versions[]` is the saved history.

- **Save**: copies working → the version currently being VIEWED
  (overwrites its body + updates `createdAt`). The active pointer does
  not change unless the viewed version was active.
- **Save as…**: creates a NEW version with the working copy as its
  body, sets it as `viewingVersionId`. Active pointer unchanged.
- **Set as active**: flips `activeVersionId` to the viewed version. No
  changes to the working copy.
- **View another version**: loads `version.body` into the working
  copy and updates `viewingVersionId`. Prompts when dirty.

Dirty = working copy differs from `versions[viewingVersionId].body`
(key-order-independent equality).

When generating patches, Alfred edits the **working copy fields**, not
the version bodies. The Apply handler delegates to the existing save
endpoint which writes both as needed.

---

## 8. What Alfred sees and how

Two distinct Alfred brains; their schema-related context differs:

### Brainstorm Alfred

Does NOT receive this doc. Sees a human-readable summary of the
ProjectDoc (see [BUILDER_V2_ALFRED.md § Context assembly](./BUILDER_V2_ALFRED.md#context-assembly)).
Its output is English, never JSON.

### Patch-generator Alfred

Receives, in the system prompt:

1. **This file verbatim** — the canonical schema reference. Read at
   server startup from
   `aspect-agent-server/docs/guides/BUILDER_V2_SCHEMA.md` and embedded
   as-is. (Re-reading on every Apply is fine; the file is small.)
2. **The current body JSON** (`AgentBody` or `CrewBody`) being edited.
3. **The English `what_to_do`** from the brainstorm proposal,
   possibly user-edited.

Returns: the full new `AgentBody` or `CrewBody` JSON.

Server-side validator (`alfred/services/proposalValidator.js`) checks
the returned body against the invariants in § 5 before writing. A
validation failure is surfaced to the UI as
"Apply failed — Alfred produced an invalid body" with a "retry" button.

### Implementation note for alfredContext.js

```js
const fs = require('fs');
const path = require('path');

const SCHEMA_DOC_PATH = path.join(
  __dirname, '..', '..', 'docs', 'guides', 'BUILDER_V2_SCHEMA.md',
);

// Read once at module load — file is committed, not generated.
const SCHEMA_DOC = fs.readFileSync(SCHEMA_DOC_PATH, 'utf8');

function patchGeneratorSystemPrompt({ entityKind, currentBody, whatToDo }) {
  return `You produce the full new ${entityKind} JSON body for the V2
agent builder. Output ONLY a JSON object that parses as the requested
body. Preserve fields not mentioned in the change description.
Generate new ids for new entities (uid('prefix') format).

## Schema reference

${SCHEMA_DOC}

## Current body

\`\`\`json
${JSON.stringify(currentBody, null, 2)}
\`\`\`

## Change to apply

${whatToDo}`;
}
```

Re-reading on each call costs ~one filesystem read; trivial. Don't
cache aggressively — the file is editable while the server runs and a
restart would defeat the maintenance contract.
