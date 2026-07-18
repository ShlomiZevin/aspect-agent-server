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

/** Where a field value comes from.
 *
 *  - 'explicit' — only when the user literally says it (collected at
 *                 runtime by an extractor).
 *  - 'inferred' — can be concluded from conversation patterns
 *                 (collected at runtime by an extractor).
 *  - 'pinned'   — pre-set at authoring time via `FieldDef.defaultValue`.
 *                 NOT collected at runtime; the runtime seeds the
 *                 field's memory slot with `defaultValue` at the start
 *                 of every turn if no value is already present.
 *                 Conversation-level overrides (the chat header swap
 *                 chip, the brain panel value picker) win because the
 *                 seed only fires when the slot is empty.
 *                 Used for organizational KB selectors (e.g. which
 *                 bank the agent is acting as). Only meaningful when
 *                 `type === 'enum'`; readers should treat a non-enum
 *                 pinned field as a no-op. */
export type FieldSource =
  | 'explicit'
  | 'inferred'
  | 'pinned';

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
  /**
   * Free-text author note. Builder-side ONLY — the runtime never
   * reads it, never injects it into a prompt, never sends it to the
   * LLM. Just a place for the user to write down what this field
   * means in their head. Useful when the field name is terse and
   * the "how to extract" is about extraction mechanics, not meaning.
   */
  definition?: string;
  /**
   * Cross-domain grouping tags. Each entry is a name in `agent.tags`.
   * A field can carry several tags; a tag can be shared across fields
   * from different domains. The `{{tag:NAME}}` family of tokens walks
   * the agent's fields filtered by tag membership.
   *
   * Lowercased, trimmed, no spaces — same validator as field name.
   * Order preserved; deduped on save.
   */
  tags?: string[];
  /**
   * Pre-set value used when `source === 'pinned'`. Read at conversation
   * start: the runtime seeds memory[domain][name] with this value if
   * the slot is empty. Conversation-level memory writes (e.g. the
   * builder chat header swap chip) override it because the seed only
   * fires when the slot is undefined.
   *
   * Only meaningful for `type === 'enum'` + `source === 'pinned'`.
   * For other combinations, readers should treat this as a no-op;
   * it's optional so the schema stays back-compat with every existing
   * FieldDef on the wire.
   */
  defaultValue?: string;
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
 *                         pairs (default 1 — every message). Counter
 *                         lives in `context_data` per (conversation,
 *                         instance).
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
  /**
   * Parallel-step marker (Blocking lane only). The blocking chain is a
   * sequence of STEPS; each step is a set of addons that run
   * concurrently, and steps run one after another with a barrier
   * between them. Storage stays the flat, ordered `addons[]` array —
   * steps are DERIVED by walking it: a maximal run of adjacent addons
   * where every addon after the first has `joinsPreviousStep === true`
   * collapses into a single step.
   *
   *   A (false) · B (false) · C (true) · D (true) · Talker (false)
   *   → step[A] · step[B, C, D] · step[Talker]
   *
   * The link between two adjacent cards is thus typed: a barrier (the
   * default `→`) when the right card is `false`/absent, or a parallel
   * join (`‖`) when it's `true`. Semantics inside a step:
   *   - execution order is meaningless (Promise.all); the UI drops the
   *     sequence arrow between members accordingly.
   *   - members read the SAME pre-step memory snapshot; they can't see
   *     each other's writes this turn (barrier is between steps, not
   *     within). Wiring an intra-step dependency is the author's
   *     responsibility to avoid.
   *
   * Normalization (enforced on load + edit): the FIRST addon of a lane
   * is always `false` (can't join nothing); a Talker is always `false`
   * (a reply sink is its own step). Absent is treated as `false`, so
   * every pre-flag crew keeps its exact sequential behavior with no
   * migration. Ignored outside the Blocking (`main`) lane.
   */
  joinsPreviousStep?: boolean;
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

/**
 * KB Retriever — adaptive RAG retrieval as a chain step. Two
 * independent axes, each Simple or LLM: Trigger (when to fire) and
 * Query (what to ask). Searches the selected KBs (Pinecone namespaces),
 * writes the formatted result (or the empty-sentinel) to a named
 * EPHEMERAL slot, injected into downstream prompts via `{{kb:NAME}}`.
 * Recomputed every turn, never persisted. See
 * `docs/guides/KB_V2_RETRIEVER.md`.
 */
export interface KbRetrieverConfig {
  /** User-editable addon label (shown on the chain card). Empty → the
   *  plugin's display name, like every other addon. */
  name: string;
  /** Where the result is written — the token to inject downstream is
   *  `{{kb:DOMAIN}}`. (Mirrors Thinker's name/domain split.) */
  domain: string;
  /** Pinecone namespaces (KBs) to search. All selected are searched. */
  kbNamespaces: string[];
  /** When to fire. */
  trigger: {
    mode: 'always' | 'llm';
    /** LLM-mode planner prompt — returns fire / skip. Full prompt. */
    prompt: string;
    model: ModelRef;
    /** LLM-mode: how much conversation the decider sees. */
    history: HistoryMode;
    /** Locked output-format contract appended to the prompt at runtime
     *  (the decider MUST answer a clear yes/no). Visible + fixed in the
     *  UI; editable only behind a danger gate — a bad contract silently
     *  breaks the yes/no parse. */
    outputContract: string;
  };
  /** What to ask. */
  query: {
    mode: 'history' | 'llm';
    /** history mode: how many trailing messages to embed (default 1). */
    n: number;
    /** LLM-mode rewrite prompt — returns the query string. Full prompt. */
    prompt: string;
    model: ModelRef;
    /** LLM-mode: how much conversation the rewriter sees. */
    history: HistoryMode;
    /** Locked output-format contract appended at runtime (the rewriter
     *  MUST return only the query text). Same danger-gated UI as the
     *  trigger contract. */
    outputContract: string;
  };
  /** Retrieval knobs (same as the admin Test panel). */
  topK: number;
  minScore: number;
  maxTokens: number;
  /** 'text' = chunk text only; 'structured' = chunks + relevance scores. */
  format: 'text' | 'structured';
  /** What `{{kb:NAME}}` renders when nothing was retrieved. */
  emptyText: string;
  /** On a turn that retrieves nothing: `clear` (write sentinel) or
   *  `keep` (leave the previous result). */
  onNoRetrieval: 'clear' | 'keep';
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
  /** Per-value master switch. When explicitly `false`, this value is
   *  invisible to prompts and to the extractor: it drops out of
   *  `{{enum:NAME}}` / `{{enum:NAME:SECTION}}` aggregates, out of the
   *  `{{enum:NAME:values}}` inline list, out of the extractor's
   *  `values=[…]` schema line, and out of `{{enum_values}}`. A `{{dc:…}}`
   *  lookup whose live memory value equals this value resolves as
   *  no-match ('').
   *
   *  The KB is NOT disabled — other values keep working. Purpose:
   *  narrow the options without deleting (phasing out, gating by
   *  business rule, or hiding a stub value that isn't ready). Missing
   *  is treated as enabled so pre-flag values stay on without a
   *  migration. */
  enabled?: boolean;
}

export interface EnumTypeDef {
  id: ID;
  /** Canonical key used in `{{enum:NAME}}` tokens and in
   *  `FieldDef.enumType` references. Unique per agent. */
  name: string;
  /**
   * Set when this enum was auto-created by the field editor's "Choice"
   * type — a quick one-field value list authored inline on the field
   * instead of on the Targeted KB page. Purely additive metadata: the
   * runtime ignores it; the UI uses it to (a) keep the values editable
   * inline on the owning field, (b) badge the entry on the Targeted KB
   * page, and (c) delete the enum together with its field (unless
   * another field has since bound to it). The enum is NOT renamed when
   * the field renames — rename it on the Targeted KB page anytime.
   */
  ownedByFieldId?: ID;
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
  /**
   * The CUSTOMER-facing version, decoupled from `activeVersionId` (the
   * builder/admin marker). The public runtime (version:'published')
   * resolves this per-crew, falling back to active→viewing when null,
   * so live users never see an unpublished draft. Moved only by an
   * explicit Publish action. `null`/undefined = not published yet.
   */
  publishedVersionId?: ID | null;
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
  | 'fields' | 'domains' | 'tags' | 'parameters' | 'enums'
  | 'cortex' | 'snippets' | 'personas' | 'liveBrain'
>;

// ─── Live Brain ────────────────────────────────────────────────────
// The customer-facing "brain" panel shown beside the chat at
// `/:agent/live`. Authored on the `/:agent/builder/live-brain` screen.
// Agent-level (applies to all crews) and part of the versioned agent
// body. See docs/guides/BUILDER_V2_LIVE_BRAIN.md.

/**
 * How a Live Brain panel draws its resolved content. Most render types
 * have a FIXED, known data shape — a `prompt` source is told to return
 * that shape. `text` and `html` are the two free-form string renders:
 * `text` renders Markdown; `html` renders sanitized HTML (styled cards,
 * custom layout — scripts stripped).
 */
export type PanelRender =
  | 'text' | 'html' | 'keyvalue' | 'goals' | 'bars' | 'donut';

/**
 * A TEXT panel — the author writes free text and drops in live values
 * with `{{...}}` tokens (`{{field:strategy}}`, `{{memory:profile}}`,
 * `{{summary:main}}`). Resolved by plain token substitution; NOT sent to
 * an LLM. Use the `text` render type with this. Markdown is supported in
 * the text (bold / lists / tables), so this is also the "rich text" path.
 */
export interface PanelTextSource {
  kind: 'text';
  text: string;
}

/**
 * A PROMPT panel — a dedicated non-blocking Live-Brain addon computes the
 * content with an LLM. Reuses the SAME authoring pieces as a regular
 * addon: prompt + model, History (how much conversation it sees), a
 * cadence trigger, and the standard run filter (cap + conditions with
 * enum-value completion). It returns the shape the chosen render type
 * expects (text, or the render's JSON — see the render library).
 */
export interface PanelPromptSource {
  kind: 'prompt';
  prompt: string;
  model: ModelRef;
  /**
   * How much conversation the addon sees. Same options as an addon's
   * History. Depth matters for a brain — default is several messages,
   * never just the last one.
   */
  history: HistoryMode;
  /** Cadence — how often it runs (non-blocking, off the reply path). */
  trigger: OfflineTrigger;
}

export type PanelSource = PanelTextSource | PanelPromptSource;

export interface BrainPanel {
  id: ID;
  /**
   * Header text shown as the panel's title in the brain. Free text — the
   * author can paste an emoji, a label, or both (there's no separate icon
   * field).
   */
  title: string;
  render: PanelRender;
  source: PanelSource;
  /**
   * Optional run/show gate — the SAME shape + UI as an addon's filter
   * (cap + conditions). Belongs to the panel, not the source: it decides
   * when the panel applies regardless of whether it's `text` or `prompt`.
   */
  filter?: AddonFilter;
}

/**
 * Agent-level Live Brain configuration. Optional for back-compat;
 * readers treat absence as `{ panels: [] }`.
 */
export interface LiveBrainDef {
  panels: BrainPanel[];
}

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
   * Declared field tags for this agent. Tags are an orthogonal
   * grouping to domain — a field keeps its single canonical domain
   * but can belong to N tags for ad-hoc reference (`{{tag:NAME}}`,
   * `{{tag:NAME:values}}`, `{{tag:NAME:names}}`). Same UX hint vs
   * constraint contract as `domains`: at runtime a field's `tags[]`
   * wins; this list is the authoring vocabulary.
   *
   * Optional for back-compat; readers should treat absence as `[]`.
   */
  tags?: string[];
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
   * Agent-level Live Brain — the customer-facing brain panel shown
   * beside the chat at `/:agent/live`. Authored on the
   * `/:agent/builder/live-brain` screen. Part of the versioned agent
   * body (so every version implies its own Live Brain setup).
   *
   * Optional for back-compat; readers should treat absence as
   * `{ panels: [] }`.
   */
  liveBrain?: LiveBrainDef;
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
  /**
   * The CUSTOMER-facing version, decoupled from `activeVersionId`. The
   * public runtime (version:'published') resolves this, falling back to
   * active→viewing when null. Moved only by an explicit Publish action.
   * `null`/undefined = not published yet.
   */
  publishedVersionId?: ID | null;
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
