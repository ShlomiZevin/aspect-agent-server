/**
 * Builder JSON document types — CANONICAL source of truth.
 *
 * Edit THIS file. The client gets a synced copy at
 * `aspect-react-client/src/builder/types/index.ts` via the client's
 * `sync-types` script (runs on postinstall / predev / prebuild). The
 * client copy is gitignored — don't edit it; your changes will be
 * overwritten on the next sync.
 *
 * Why server-owned: Alfred's `patchGenerator.js` and the runtime
 * `BUILDER_V2_SCHEMA.md` doc both reference these types; making the
 * server the canonical home means the file ships inside the Docker
 * build context (no cross-folder reads). The client mirrors at build
 * time — it's the consumer, not the owner.
 *
 * Storage model: each ProjectDoc / AgentDoc / CrewDoc is a single JSON
 * document persisted as one row in its own table. During the builder
 * session they live in memory and localStorage as drafts.
 *
 * Plugin configs live INSIDE the crew doc as opaque `config` blobs keyed
 * by `pluginId`. The plugin registry knows how to render/validate each.
 */

export type ID = string;

// ─── Provider / Model ──────────────────────────────────────────────

export interface ModelRef {
  providerId: string;
  modelId: string;
}

// ─── Fields (used by Field Extractor and any future addon that produces fields) ──

export type FieldType = 'string' | 'int' | 'enum' | 'boolean';

/** Where a field value comes from. */
export type FieldSource =
  | 'explicit'   // only when the user literally says it
  | 'inferred';  // can be concluded from conversation patterns

/**
 * Where the field lives in the JSON.
 *  - 'agent': stored on `AgentBody.fields[]` — visible from any crew.
 *  - 'crew':  stored on `CrewBody.fields[]` — visible only in its
 *             owning crew.
 *
 * Scope is determined by *location* (which array the FieldDef lives
 * in), not by a tag on the field itself. So `FieldDef` doesn't carry
 * `scope` — that would let it drift from reality. Hooks compute it
 * by asking "where did I find this field?".
 */
export type FieldScope = 'agent' | 'crew';

export interface FieldDef {
  id: ID;
  name: string;                 // canonical key, snake_case
  type: FieldType;
  source: FieldSource;
  /** Free-text guidance on how to extract this field. Field-specific
   *  copy (e.g. "find the customer's PRIMARY motive"); shared
   *  per-value knowledge belongs on the enum's sections, not here. */
  howToExtract: string;
  /** Only for `type: 'enum'` — references an `EnumTypeDef.id` on
   *  `AgentDoc.enums[]`. Multiple fields can point at the same enum
   *  type; the per-value knowledge (values list, umbrella, sections)
   *  lives on the enum, not duplicated per field. Empty/undefined
   *  while type === 'enum' means "type is enum but no concrete enum
   *  picked yet" — the field is authoring-only until wired. */
  enumType?: ID;
  /**
   * Optional memory grouping. Blank/undefined = "(no domain)" — the
   * field is still captured to a `general` bucket at runtime, just
   * not surfaced under a named group.
   */
  domain?: string;
}

// ─── Parameters (static agent-wide values) ────────────────────────

/**
 * A static, agent-scoped value the user declares once and references
 * from any prompt-based addon. Parameters are the static counterpart
 * to fields: fields come from the conversation (extracted/inferred per
 * turn), parameters come from configuration and never change at runtime.
 *
 * Examples: the bank's display name, a support phone number, a
 * regulatory disclaimer string.
 *
 * Picker UX: rendered alongside fields in the `#` mention menu so users
 * can mix them into prompts the same way (`#bankName`).
 */
export interface ParameterDef {
  id: ID;
  /** Canonical key — lowerCamelCase, used as the `#` mention token. */
  name: string;
  /** The configured value substituted into prompts at runtime. Plain
   *  string today; extend to typed values later if a real need shows up. */
  value: string;
  /** Optional one-line description shown in the picker. */
  description?: string;
}

// ─── Addons (plugins inside a crew) ────────────────────────────────

/**
 * Where an addon instance runs. Chosen by the user when adding the
 * instance — not a fixed property of the plugin. A single plugin
 * (e.g. Field Extractor) may run in different lanes in different
 * crews.
 */
export type AddonLane = 'main' | 'background' | 'offline';

/**
 * How much past conversation to inject into the step's prompt.
 *
 *  - `none`               — no history.
 *  - `last_n`             — last N messages.
 *  - `full`               — every message (legacy alias for `all`).
 *  - `all`                — every message in the conversation.
 *  - `since_transition`   — messages strictly after the last crew
 *                           transition (falls back to `all` if no
 *                           transition has happened yet).
 *  - `since_summarizer`   — messages strictly after the named
 *                           summarizer's last run watermark (falls
 *                           back to `all` if the summarizer has
 *                           never fired or doesn't exist).
 *
 * Resolution lives in `historyService.js`. New modes apply to EVERY
 * addon, not just summarizers — a regular Thinker can read
 * `since_summarizer: main` to see just the messages a checkpoint
 * hasn't covered yet.
 */
export type HistoryMode =
  | { mode: 'none' }
  | { mode: 'all' }
  | { mode: 'last_n'; n: number }
  | { mode: 'full' }                                          // legacy alias for `all`
  | { mode: 'since_transition' }
  | { mode: 'since_summarizer'; summarizerName: string };

/**
 * Why and when an OFFLINE-lane addon fires. Required for any addon
 * on the `offline` lane; ignored on `main` / `background` lanes.
 *
 *  - `every_n_messages` — fire after every N user-message-plus-reply
 *                         pairs (default 8). Counter lives in
 *                         `context_data` per (conversation, instance).
 *  - `on_transition`    — fire whenever a crew transition is emitted
 *                         in the same turn.
 *
 * Designed as a discriminated union so future kinds (`when_field_equals`,
 * `time_elapsed`, …) can be added without breaking existing data.
 */
export type OfflineTrigger =
  | { kind: 'every_n_messages'; n: number }
  | { kind: 'on_transition' };

/**
 * Universal reading knobs every addon has, regardless of plugin.
 *
 * Phase B collapsed the per-section toggles (`persona`, `memoryReads`,
 * `thinkingReads`) into the `promptTemplate` itself: the user controls
 * placement of `{{memory}}` / `{{memory:domain}}` / `{{persona}}` /
 * `{{thinking}}` / `{{field:X}}` / `{{param:X}}` / `{{enum:X[:S]}}` /
 * `{{dc:X[:S|*]}}` inline. `history` controls which raw messages
 * reach the LLM as a separate parameter; `trigger` controls when an
 * offline-lane addon fires at all.
 */
export interface AddonContext {
  history: HistoryMode;
  /** Required when this instance sits on the `offline` lane. The
   *  runtime ignores it on `main` / `background` lanes — those run
   *  once per turn unconditionally. */
  trigger?: OfflineTrigger;
  /** Optional gate that decides whether THIS turn's run of this
   *  addon happens at all. Evaluated by the engine against the brain
   *  blob BEFORE prompt assembly / LLM call. When the addon is
   *  skipped, the chain still runs (skip just means "this one
   *  step"); the SSE timeline shows the skipped card with the
   *  filter's evaluation so the author sees why. Absent / no
   *  conditions → always runs (legacy behaviour). */
  filter?: AddonFilter;
}

/**
 * Per-addon run filter — the gate the engine evaluates before
 * deciding whether to run this addon on the current turn.
 *
 * `conditions` is an AND-of-conditions, identical in shape to
 * `TransitionRouterConfig.conditions`. Reuses the same `conditionMatcher`
 * implementation so a single vocabulary covers both "should this
 * router fire?" and "should this addon run at all?".
 *
 * `mode` flips the polarity:
 *  - `'include'` (default) — addon runs ONLY when every condition
 *    evaluates `ok`.
 *  - `'exclude'` — addon runs ONLY when at least one condition
 *    evaluates not-ok (i.e., when the conditions DON'T hold).
 *
 * Empty `conditions` → no gate (the engine treats it as "always
 * run", same as omitting the filter property entirely).
 */
export interface AddonFilter {
  conditions: TransitionCondition[];
  mode: 'include' | 'exclude';
  /**
   * Optional per-conversation run cap — the addon runs at most `cap`
   * times in a single conversation, independent of `conditions`. Absent
   * / undefined / 0 = no cap. The counter lives in `context_data` per
   * (conversation, instance). Surfaced in the Filter editor as
   * "Run at most N times per conversation".
   */
  cap?: number;
}

/**
 * What this addon produces at runtime. Conceptually independent
 * from how it produces it — kept extensible so future plugins can
 * declare new kinds (UI cards, audio, tool calls, …).
 */
export type OutputType =
  | 'text-to-user'      // Talker — text response sent to the chat
  | 'json-to-memory'    // Field Extractor, future Strategic / Vibe — structured fields written to memory
  | 'transition';       // Transition Router — emits a next-crew handoff signal

export interface AddonInstance<TConfig = unknown> {
  /** Unique within the crew. */
  instanceId: ID;
  /** Refers to a registered plugin (e.g. "field-extractor"). */
  pluginId: string;
  /** Lane this instance runs in. Set per-instance by the user. */
  lane: AddonLane;
  enabled: boolean;
  /** Plugin-defined config blob. */
  config: TConfig;
  /** Universal reading knobs (history / persona / memory). */
  context: AddonContext;
  /**
   * What this instance produces — chosen from the plugin's
   * `allowedOutputTypes` list. Default snapshotted from
   * `defaultOutputType` at create time. User-configurable.
   */
  outputType: OutputType;
  /**
   * Prompt template the runtime uses to assemble this step's prompt.
   * Snapshotted from the plugin's `defaultPromptTemplate` at create
   * time so it travels with the addon and stays stable across plugin
   * updates. Placeholders are interpolated by the runtime — see
   * `KNOWN_PROMPT_PLACEHOLDERS` below for the full set.
   *
   * Source-of-truth contract: this exact string is what the server
   * uses as the *prompt* parameter to the LLM. **History is NOT in
   * this string** — it's passed separately as the LLM's message-
   * history parameter (varies per provider).
   */
  promptTemplate: string;
}

/**
 * Reference: full token vocabulary lives in
 * `aspect-agent-server/builder/promptPlaceholders.json` — read by the
 * server prompt assembler, by Alfred, and by the client MentionTextarea.
 * The constants below are the flat (no-parameter) tokens only; tokens
 * with a `:name` segment (e.g. `{{memory:customer}}`) are matched by
 * pattern in the assembler.
 */
export const KNOWN_PROMPT_PLACEHOLDERS = {
  /** The user-written prompt (`config.prompt`). */
  prompt: '{{prompt}}',
  /** Agent persona text block (empty if persona is blank). */
  persona: '{{persona}}',
  /** Full `## Memory` dump — every domain with values. */
  memory: '{{memory}}',
  /** Full `## Thinking` dump. */
  thinking: '{{thinking}}',
  /** Full `## Summary` dump — every declared summarizer with text. */
  summary: '{{summary}}',
  /** Schema block for an extractor's fields. Extractor plugins only. */
  fields_schema: '{{fields_schema}}',
  /** Currently-collected values for an extractor's fields. Extractor plugins only. */
  fields_current: '{{fields_current}}',
  /** Literal NAME of the (first) field this extractor populates. Designed
   *  for single-field extractors (Field Reasoner). Empty for non-extractor
   *  plugins or when the extractor has no fields. */
  this_field: '{{this_field}}',
  /** Comma-separated list of the (first) extracted field's enum values.
   *  Resolved from the field's `enumType` → that EnumTypeDef's
   *  `values[].value`. Source of truth lives on the enum so the prompt
   *  can't drift from the bible. */
  enum_values: '{{enum_values}}',
} as const;

// ─── Plugin-specific config shapes ─────────────────────────────────

export interface FieldExtractorConfig {
  prompt: string;
  model: ModelRef;
  /**
   * User-editable name for this extractor instance. Lets users
   * distinguish "Date Extractor" from "Intent Extractor" in the
   * chain canvas. Empty → falls back to "Field Extractor [#N]".
   */
  name?: string;
  /**
   * IDs of FieldDefs (from `agent.fields` or owning `crew.fields`)
   * that this extractor pulls out of the conversation. The same
   * field id can appear in multiple extractors' lists; memory writes
   * are keyed by name and the last write wins per turn.
   */
  extractsFields: ID[];
}

/**
 * Field Reasoner — single-field, complex-reasoning extractor.
 *
 * Storage shape is identical to FieldExtractorConfig (same
 * `extractsFields: ID[]` array, same prompt/model/name slots) so the
 * runtime reuses the existing extractor pipeline unchanged. The UI
 * constrains `extractsFields` to exactly one entry — that field is
 * "this field" for the {{this_field}} / {{enum_values}} tokens. The
 * fused modal also drives a parallel FieldDef create/update on the
 * agent or crew schema; that write is independent of the AddonInstance
 * (the FieldDef lives where every other field lives — on
 * agent.fields[] or crew.fields[]).
 */
export interface FieldReasonerConfig {
  prompt: string;
  model: ModelRef;
  /** Instance display name. Empty → falls back to "Field Reasoner [#N]". */
  name?: string;
  /** Length-1 array referencing the FieldDef this Reasoner populates.
   *  Same shape as FieldExtractor for runtime compatibility. */
  extractsFields: ID[];
}

/**
 * Field Interviewer — Thinker + bound field, in one LLM call.
 *
 * Use when the atomic decision is BOTH "what should the talker ask
 * next to make progress toward filling this field" AND "if the user
 * just gave me the answer, commit it". Splitting those into a Thinker
 * + Field Reasoner forces two LLM runs that can disagree about the
 * same exchange. Field Interviewer keeps them together.
 *
 * Storage shape: identical to FieldReasoner (single-id `extractsFields`)
 * so the runtime reuses the extractor pipeline unchanged. Plus a
 * `domain` like Thinker — every NON-bound-field key in the parsed
 * JSON is treated as a thinking write under that domain (default
 * `'interview'`).
 */
export interface FieldInterviewerConfig {
  prompt: string;
  model: ModelRef;
  /** Instance display name. Empty → falls back to "Field Interviewer [#N]". */
  name?: string;
  /** Length-1 array referencing the FieldDef this Interviewer populates. */
  extractsFields: ID[];
  /** Thinking domain for the free-form keys (everything that isn't the
   *  bound field). Defaults to `'interview'`. */
  domain: string;
}

export interface TalkerConfig {
  /** The voice prompt — what the crew is supposed to say and how. */
  prompt: string;
  model: ModelRef;
}

/**
 * Thinker — produces strategic guidance for the Talker. The output is
 * a free-form JSON object (keys defined by the prompt, NOT a declared
 * field list) written to the brain's `thinking` section under a
 * configurable domain. Talker reads via `context.thinkingReads`.
 *
 * Why no declared fields: thinking output is freeform advice consumed
 * only by the Talker. Forcing a field schema would constrain what the
 * Thinker can say and clutter the FieldsPanel with strings that
 * nothing else reads. The prompt is the contract — the LLM emits keys
 * the user asked for; the server writes whatever lands.
 */
export interface ThinkerConfig {
  prompt: string;
  model: ModelRef;
  /** User-editable instance name shown on the chain card. */
  name?: string;
  /**
   * Where Thinker writes its output in the brain's `thinking` section.
   * Defaults to `'strategy'`. Multiple Thinkers in the same crew can
   * write to different domains (e.g. `'strategy'`, `'tone'`).
   */
  domain: string;
}

/**
 * Summarizer — distil chat history into a compact checkpoint.
 *
 * Lives on the `offline` lane (`AddonInstance.lane === 'offline'`),
 * fires per its `context.trigger`, writes to `brain.summary[name]`.
 * Other addons consume the synthesis via `{{summary:NAME}}` and can
 * read "messages since this checkpoint" via the `since_summarizer`
 * history mode.
 *
 * `name` is both the token name (`{{summary:NAME}}`) and the
 * `since_summarizer.summarizerName` reference key. Free-form,
 * unique per agent — the validator enforces uniqueness so a stale
 * reference can't collide with a freshly-created summarizer.
 */
export interface SummarizerConfig {
  prompt: string;
  model: ModelRef;
  /** Token name used in `{{summary:NAME}}` AND in
   *  `since_summarizer: NAME` history references. Unique per agent. */
  name: string;
}

// ─── Brain blob (runtime — written by addons, read by assembler) ───

/**
 * Per-summarizer entry in `brain.summary`. Replaced wholesale on
 * each run (rolling = replace), so reading the slot always gives the
 * current synthesis — no log of past checkpoints in v1.
 */
export interface SummaryEntry {
  /** The synthesis text the LLM produced. */
  text: string;
  /** Highest message index this run included in its history slice.
   *  Used by the `since_summarizer` history mode to filter messages
   *  strictly after the checkpoint. */
  watermark: number;
  /** Epoch ms when the run completed. Surfaced in the brain viewer. */
  ranAt: number;
}

/**
 * Per-conversation brain blob — what the engine reads and the
 * assembler renders into `{{memory}}` / `{{thinking}}` /
 * `{{summary}}` tokens. Storage lives in `context_data` under the
 * `builder_memory` namespace, scoped to the conversation.
 *
 * Mirror of the JS-side shape in `runtime/builderMemory.js`. Kept
 * here so client code consuming the SSE `addon.brain` event has a
 * canonical type to bind to.
 */
export interface Brain {
  /** Facts the brain remembers — extractors write here. */
  memory:   { [domain: string]: Record<string, unknown> };
  /** Current reasoning — Thinker (and Field Interviewer's free-form
   *  keys) write here. */
  thinking: { [domain: string]: Record<string, unknown> };
  /** Summarizer checkpoints, one slot per `SummarizerConfig.name`. */
  summary:  { [name: string]: SummaryEntry };
}

// ─── Enums (agent-level type bible) ───────────────────────────────

/**
 * Enum types live at the agent level (`AgentDoc.enums`) as the bible
 * of value vocabularies the agent reasons over. A FieldDef declares
 * `type: 'enum'` + `enumType: <EnumTypeDef.id>` to bind to one — many
 * fields can share the same enum (e.g. `primary_motive` and
 * `secondary_motive` both bind to the `motive` enum). Per-value
 * knowledge (umbrella prompt + free-form sections like
 * `how_to_identify`, `definition`, `examples`) lives on the enum,
 * not duplicated across fields.
 *
 * Two token families read from this model:
 *
 *  - `{{enum:NAME[:SECTION]}}` (aggregate): renders headed blocks for
 *    every value of the enum — each value's umbrella when SECTION is
 *    absent, otherwise that value's SECTION body. Values with empty
 *    content for the requested slot are omitted. Used for extractor /
 *    reasoner prompts that need every-value identification guidance.
 *
 *  - `{{dc:FIELD[:SECTION|:*]}}` (live-value lookup): given a field of
 *    type=enum, resolves the field's current memory value to a value
 *    record on its enum and renders that value's umbrella (default),
 *    a named section body, or every authored section under it (`:*`).
 *    Resolves to empty when the field has no value or the value isn't
 *    in the enum.
 *
 * No fallback concept on the enum — missing matches resolve to empty.
 * Authors wrap with their own fallback prose in the prompt if needed.
 */
export interface EnumSectionDecl {
  /** The token key (`{{enum:FOO:NAME}}` / `{{dc:bar:NAME}}`). The
   *  editor lints toward snake_case so tokens stay safe, but the
   *  string is otherwise free-form. */
  name: string;
}

export interface EnumValueDef {
  /** Stable id so renames of `value` cascade through `sectionTexts`
   *  keys in a single atomic update. */
  id: ID;
  /** The canonical string compared against memory at runtime — what
   *  the field's value is expected to equal (case-sensitive,
   *  `String(memoryValue) === String(value)`). */
  value: string;
  /** Per-value umbrella prompt. What `{{enum:NAME}}` (no section)
   *  emits for this value, and what `{{dc:field}}` (no section)
   *  emits when the field's current value matches. Empty = omit. */
  umbrellaText?: string;
  /** Per-value section bodies, keyed by the section name declared on
   *  the parent `EnumTypeDef.sections`. Missing keys resolve to empty
   *  at runtime; the editor surfaces every declared section, the
   *  author fills in what's relevant per value. Bodies can be many
   *  paragraphs of comprehensive prose — the assembler renders them
   *  as a single `### value` block under a wrapping `## name` header
   *  (see assembler for the exact template). */
  sectionTexts?: Record<string, string>;
}

export interface EnumTypeDef {
  id: ID;
  /** Canonical key used in `{{enum:NAME}}` tokens and in
   *  `FieldDef.enumType` references. Unique per agent. */
  name: string;
  /** Section NAMES declared on this enum — the address space the
   *  `{{enum:NAME:SECTION}}` and `{{dc:field:SECTION}}` tokens
   *  resolve against. Shared across every value so the aggregate
   *  token can aggregate: adding a section makes it referenceable
   *  under every value even if some haven't authored a body. */
  sections?: EnumSectionDecl[];
  /** The declared values. Order is authored — the editor preserves
   *  it; the assembler renders aggregate blocks in this order. */
  values: EnumValueDef[];
}

// ─── Snippets (agent-level reusable prompt content) ───────────────

/**
 * One named, reusable, optionally-gated chunk of prompt content.
 *
 * Inserted into any addon's prompt via `{{snippet:NAME}}`. Renders
 * `content` when:
 *   - no `filter` is set, OR
 *   - `filter.conditions` is empty, OR
 *   - `filter.mode === 'include'` and ALL conditions match, OR
 *   - `filter.mode === 'exclude'` and AT LEAST ONE condition fails.
 *
 * Otherwise resolves to empty string; the assembler's whitespace
 * collapse strips surrounding blank lines the same way it does for
 * every other token that resolves to empty.
 *
 * Snippet content is mention-aware — embedded `{{field:X}}` /
 * `{{param:Y}}` / `{{memory}}` / `{{enum:Z[:S]}}` / `{{dc:Z[:S|*]}}`
 * / etc. tokens resolve on the regular substitution passes because
 * the snippet pass runs FIRST in `promptAssembler` (the snippet's
 * content is inlined into the template before sections / params /
 * enum / dc tokens are resolved). Nested `{{snippet:OTHER}}`
 * references inside `content` are NOT recursively expanded in v1 —
 * they show up as literal text; the validator surfaces a warning.
 *
 * See `docs/guides/BUILDER_V2_SNIPPETS.md` for the full design.
 */
export interface SnippetDef {
  id: ID;
  /** Canonical key — used in `{{snippet:NAME}}` tokens. Unique
   *  per agent (validator enforces). Lowercase + underscores by
   *  convention; the editor lints toward that shape. */
  name: string;
  /** Optional human-readable label shown in the snippets list and
   *  picker description. Free-form. */
  displayName?: string;
  /** The prompt content. Mention-aware. */
  content: string;
  /** Optional gate. Same shape as the per-addon Run Filter so the
   *  author learns ONE condition vocabulary across the system. Omit
   *  for "always render" (the snippet then acts as a reusable
   *  multi-line text block — that's intentional, useful even
   *  without gating). */
  filter?: AddonFilter;
}

// ─── Personas (agent-level voice/role blocks) ─────────────────────

/**
 * One named persona — a reusable voice/role text block injected into
 * addon prompts via the `{{persona}}` / `{{persona:NAME}}` tokens.
 *
 * `{{persona}}` (bare) appends every persona whose `appliesTo` includes
 * the addon's plugin id (or the wildcard `'*'`), in the agent's list
 * order. `{{persona:NAME}}` pulls one specific persona regardless of
 * `appliesTo`.
 *
 * Lives on `AgentDoc.personas` (agent-scoped). Names are unique per
 * agent. Replaces the older single `AgentDoc.persona` string for
 * multi-persona agents; the legacy `persona` field is still read as a
 * fallback when no personas are declared.
 */
export interface PersonaDef {
  id: ID;
  /** Canonical key — used in `{{persona:NAME}}` tokens. Unique per agent. */
  name: string;
  /** The persona voice/role text. Mention-aware. */
  content: string;
  /**
   * Which addons receive this persona via the bare `{{persona}}` token.
   * Entries are plugin ids (e.g. `'talker'`); the wildcard `'*'` means
   * "all addons". Empty = this persona is only reachable via the
   * explicit `{{persona:NAME}}` token.
   */
  appliesTo: string[];
}

// ─── Transition Router plugin ─────────────────────────────────────

/**
 * Conditions an instance of the Transition Router can check against
 * the conversation memory. ALL conditions on an instance must match
 * for the router to fire (AND). For OR semantics, drop a second
 * Transition Router with the other condition.
 *
 * Earlier draft had `llm-decide`; cut from v1 — compose an upstream
 * Field Extractor (with an intent-like field) + a `field-equals`
 * rule on the extracted value. Composable, inspectable in the
 * timeline, and the LLM call gets logged in llm_usage like everything else.
 */
/**
 * Operators a `field` condition can use. The UI filters the dropdown
 * based on the selected field's declared `type`:
 *   - enum    → equals | not-equals | in | not-in
 *   - string  → equals | not-equals | contains | starts-with | ends-with | in | not-in
 *   - int     → equals | not-equals | gt | gte | lt | lte
 *   - boolean → equals | not-equals
 * If no field is picked yet (or the field doesn't exist in the
 * registry) the dropdown shows the safe-default set.
 *
 * `in` / `not-in` use the `values` array; everything else uses
 * `value` (scalar). Keeping them on the same condition variant lets
 * the user flip between operators without losing the field choice.
 */
export type FieldOp =
  | 'equals' | 'not-equals'
  | 'contains' | 'starts-with' | 'ends-with'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not-in';

export type TransitionCondition =
  | { type: 'fields-collected'; fields: string[] }
  | {
      type: 'field';
      field: string;
      op: FieldOp;
      /** Scalar value for binary ops; ignored for `in` / `not-in`. */
      value?: unknown;
      /** Multi-value for `in` / `not-in`; ignored for binary ops. */
      values?: unknown[];
    }
  | {
      /**
       * Matches while this addon/router has run at most `max` times in
       * the conversation. Mostly superseded by `AddonFilter.cap` (the
       * actual UX surface), but kept as a condition variant for legacy
       * data and programmatic use.
       */
      type: 'run-count';
      max: number;
    };
// `always` was dropped — composing with an upstream extractor +
// field op covers the unconditional pipeline case more inspectably.

export interface TransitionRouterConfig {
  conditions: TransitionCondition[];
  /** Crew to transition to when conditions match. */
  target: ID;
  /** Optional human-readable note shown in the AddonRunCard. */
  reason?: string;
  /**
   * What to do with the rest of THIS crew's chain after a match:
   *  - `'continue'` (default) — remaining addons in the current
   *    crew's chain still run. Combined with `fireImmediately`, the
   *    target crew's chain starts AFTER the current crew finishes.
   *  - `'break'` — remaining addons in the current crew's chain
   *    are skipped. Combined with `fireImmediately`, the target
   *    crew's chain starts RIGHT AWAY in the same turn.
   *
   * `onMatch` only governs the CURRENT crew's chain; whether the
   * target crew runs this turn is `fireImmediately`'s job.
   */
  onMatch: 'continue' | 'break';
  /**
   * Whether the target crew's chain runs in the SAME turn after the
   * transition fires.
   *
   *  - `true` (default) — after the current crew's chain settles
   *    (per `onMatch`), the engine resolves the target crew and runs
   *    its main-lane chain right away. Two talkers in one turn are
   *    allowed (the last assistant text wins on the message row).
   *    Cascading transitions are capped at 4 hops per turn so a
   *    misconfigured graph can't loop forever.
   *  - `false` — the transition is recorded for the NEXT user turn.
   *    Memory + brain still carry over; the target crew sees the
   *    same conversation state on its next chance to run.
   *
   * Optional for back-compat; absence reads as `true`.
   */
  fireImmediately?: boolean;
}

// ─── The three-level documents ─────────────────────────────────────

/**
 * The editable fields of a crew — the body that gets snapshotted into
 * a `CrewVersion`. Same fields live at the top of `CrewDoc` as the
 * "working copy" (what the user is currently editing).
 */
export type CrewBody = Pick<
  CrewDoc,
  'name' | 'description' | 'spec' | 'persona' | 'addons' | 'fields'
>;

export interface CrewVersion {
  id: ID;
  /** Monotonic, starting at 1. */
  number: number;
  /** Optional human-readable label from Save As. */
  description?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Frozen snapshot of the crew body at save time. */
  body: CrewBody;
}

export interface CrewDoc {
  id: ID;
  // ── Working copy (currently editable state — tracks the *viewing* version) ──
  name: string;
  description?: string;
  spec: string;
  persona?: string;
  /**
   * Ordered list of addons attached to this crew. The chain of addons
   * IS the crew's behaviour — including the Talker addon, which owns
   * the response prompt. The crew itself has no prompt of its own.
   */
  addons: AddonInstance[];
  /**
   * Field DEFINITIONS scoped to this crew. Visible only when viewing
   * this crew. Extractors in this crew (or in any crew of the agent
   * — though typically the same one) can reference these by id via
   * their `extractsFields` list.
   *
   * Agent-wide fields live on `AgentDoc.fields` instead.
   */
  fields: FieldDef[];
  // ── Versioning ──
  versions: CrewVersion[];
  /**
   * The version the agent actually runs at runtime. Server-side
   * persistence will read this as a column on the crew row. Only
   * changes when the user clicks "Set as active" — never when they
   * switch which version they're viewing/editing.
   */
  activeVersionId: ID;
  /**
   * The version currently loaded into the working copy (top-level
   * fields). The user can switch between versions to view/edit
   * different snapshots without changing what's active.
   * Defaults to the active version when a new crew is created.
   */
  viewingVersionId: ID;
}

/**
 * Editable fields of an agent — the body that gets snapshotted into
 * an `AgentVersion`. Crews are intentionally excluded: they're their
 * own versioned entities with independent histories. Crew membership
 * stays at the top of `AgentDoc`, outside the version body.
 */
export type AgentBody = Pick<
  AgentDoc,
  'name' | 'slug' | 'spec' | 'persona' | 'defaultCrewId'
  | 'fields' | 'domains' | 'parameters' | 'enums'
  | 'cortex' | 'snippets' | 'personas'
>;

export interface AgentVersion {
  id: ID;
  number: number;
  description?: string;
  createdAt: string;
  body: AgentBody;
}

export interface AgentDoc {
  id: ID;
  /** URL slug used by /:agent/builder routes. */
  slug: string;
  /** Working copy of the agent name (tracks the viewing version). */
  name: string;
  /** Free-text spec at the agent level. */
  spec: string;
  /** Persona shared across all crews. */
  persona: string;
  defaultCrewId?: ID;
  /**
   * Agent-wide field DEFINITIONS. Visible from every crew of this
   * agent. Extractors anywhere in the agent reference these by id
   * via their `extractsFields` list.
   *
   * Crew-private fields live on `CrewDoc.fields` instead.
   */
  fields: FieldDef[];
  /**
   * Declared memory domains for this agent. Lets the builder UI show
   * a domain in the picker before any field is attached to it (so the
   * user can pre-shape their schema). At runtime, a field's `domain`
   * still wins — declared domains are a UX hint, not a constraint.
   *
   * Optional for back-compat with agents stored before this field
   * shipped; readers should treat absence as `[]`. New agents start
   * with `[]`.
   */
  domains?: string[];
  /**
   * Agent-wide static parameters — values that don't change per
   * conversation (e.g. the bank's display name). Reference from any
   * prompt template via `#paramName`. See {@link ParameterDef}.
   *
   * Optional for back-compat; readers should treat absence as `[]`.
   * New agents start with `[]`.
   */
  parameters?: ParameterDef[];
  /**
   * Agent-wide enum type bible — value vocabularies + per-value
   * knowledge (umbrella prompt, free-form sections like
   * `how_to_identify`). FieldDefs with `type: 'enum'` reference one
   * via `enumType: <EnumTypeDef.id>`. Consumed by the assembler
   * automatically — no addon required. Two token families:
   * `{{enum:NAME[:SECTION]}}` (every value, aggregate) and
   * `{{dc:FIELD[:SECTION|:*]}}` (current matched value of a specific
   * field). See {@link EnumTypeDef}.
   *
   * Optional for back-compat; readers should treat absence as `[]`.
   */
  enums?: EnumTypeDef[];
  /**
   * Agent-level Cortex — a chain of addons that runs BEFORE the crew's
   * cortex on every turn, regardless of which crew is current. Same
   * `AddonInstance` shape as `CrewDoc.addons` so all plugins work
   * unchanged. The runtime concatenates `agent.cortex` then
   * `crew.addons` and walks the merged list per lane (today: blocking
   * lane only). Crew addons can read whatever agent addons wrote to
   * memory / thinking this turn.
   *
   * Restricted plugins at this scope:
   *   - Talker (no crew context — you need a crew to speak).
   *   - Transition Router (no crew transitions to route).
   *
   * Optional for back-compat; readers should treat absence as `[]`.
   */
  cortex?: AddonInstance[];
  /**
   * Agent-level reusable prompt content. Each snippet is a named,
   * optionally-gated chunk that any addon's prompt can inline via
   * `{{snippet:NAME}}`. See {@link SnippetDef} and
   * `docs/guides/BUILDER_V2_SNIPPETS.md`.
   *
   * Optional for back-compat; readers should treat absence as `[]`.
   */
  snippets?: SnippetDef[];
  /**
   * Agent-level personas — named voice/role blocks injected into addon
   * prompts via `{{persona}}` / `{{persona:NAME}}`. See {@link PersonaDef}
   * and `PersonasScreen`. Supersedes the single `persona` string for
   * multi-persona agents (which stays as a fallback).
   *
   * Optional for back-compat; readers should treat absence as `[]`.
   */
  personas?: PersonaDef[];
  /**
   * The crews that belong to this agent. NOT part of the agent
   * version body — crews are their own versioned entities and live
   * here as siblings of the version history.
   */
  crews: CrewDoc[];
  /** Snapshot history of the agent body (persona, spec, name, …). */
  versions: AgentVersion[];
  /** The version the runtime uses. Promoted explicitly via "Set as active". */
  activeVersionId: ID;
  /** The version currently loaded into the working copy. */
  viewingVersionId: ID;
}

/**
 * Shared shape for a version's metadata. Both `CrewVersion` and
 * `AgentVersion` satisfy it. Used by the generic version UI
 * components (pill + toolbar) so they can render either kind.
 */
export interface VersionMeta {
  id: ID;
  number: number;
  description?: string;
  createdAt: string;
}

export interface ProjectDoc {
  id: ID;
  name: string;
  /** Free-text spec at the project level. */
  spec: string;
  agents: AgentDoc[];
}

/** Pointer to which slice of the doc the user is currently editing. */
export interface BuilderSelection {
  level: 'project' | 'agent' | 'crew';
  agentId?: ID;
  crewId?: ID;
}
