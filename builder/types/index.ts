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
  /** Free-text guidance on how to extract this field. */
  howToExtract: string;
  /** Only for `type: 'enum'`. */
  enumValues?: string[];
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
 *  - `none`   — no history.
 *  - `last_n` — last N messages (n is set in the same object).
 *  - `full`   — entire conversation transcript.
 *
 * Future addition (when a Summarizer plugin ships): `summary` mode
 * that reads from the conversation summary field in memory.
 */
export interface HistoryMode {
  mode: 'none' | 'last_n' | 'full';
  /** Only meaningful when `mode === 'last_n'`. */
  n?: number;
}

/**
 * Universal reading knobs every addon has, regardless of plugin.
 *
 * Phase B collapsed the per-section toggles (`persona`, `memoryReads`,
 * `thinkingReads`) into the `promptTemplate` itself: the user controls
 * placement of `{{memory}}` / `{{memory:domain}}` / `{{persona}}` /
 * `{{thinking}}` / `{{field:X}}` / `{{param:X}}` / `{{dynamic:X}}`
 * inline. The only universal knob left is `history`, which is runtime
 * conversation data passed to the LLM as a separate parameter — not
 * template text — so it can't be folded into promptTemplate.
 */
export interface AddonContext {
  history: HistoryMode;
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
  /** Schema block for an extractor's fields. Extractor plugins only. */
  fields_schema: '{{fields_schema}}',
  /** Currently-collected values for an extractor's fields. Extractor plugins only. */
  fields_current: '{{fields_current}}',
  /** Literal NAME of the (first) field this extractor populates. Designed
   *  for single-field extractors (Field Reasoner). Empty for non-extractor
   *  plugins or when the extractor has no fields. */
  this_field: '{{this_field}}',
  /** Comma-separated `enumValues` of the (first) extracted field. Source
   *  of truth is the FieldDef on the schema; the prompt pulls it via this
   *  token so editing the values can't drift from a prompt copy. */
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

// ─── Dynamic Context (KB-by-value-hit) ────────────────────────────

/**
 * One case in a DynamicContextDef — the field-value → text mapping.
 * The text can be many paragraphs of "how to handle this case" prose
 * (it's a deterministic alternative to similarity-search KB, where
 * KB goes by similarity and dynamic context goes by exact value hit).
 *
 * `value` is stringly-typed because enum/string/int/boolean all
 * compare cleanly as strings at runtime — the assembler does a
 * `String(memoryValue) === String(case.value)` match.
 */
export interface DynamicContextCase {
  /** The field value this case fires on (e.g. an enum option name). */
  value: string;
  /** Umbrella prompt for this case — what `{{dynamic:FIELD}}` resolves to
   *  when the live value matches. Optional: a case may declare only
   *  section texts and leave the umbrella empty, in which case
   *  `{{dynamic:FIELD}}` collapses to '' for that value. */
  text?: string;
  /** Per-case section bodies, keyed by the section name declared on
   *  the parent DC. The address space (which sections exist) lives on
   *  `DynamicContextDef.sections` — this map only holds the BODIES
   *  authored for this specific case. Missing keys resolve to empty
   *  at runtime. */
  sectionTexts?: Record<string, string>;
}

/**
 * Declaration of one section name on a Dynamic Context. The list lives
 * on `DynamicContextDef.sections` and applies to every case — adding
 * or removing a section is a field-shape change, not a per-case edit.
 * Each case fills in the text under `case.sectionTexts[name]`.
 *
 * The `name` is the token key (`{{dynamic:FIELD:NAME}}`) and stays
 * snake-case for token-safety; the editor auto-sanitises typed labels
 * to that shape but leaves the result editable.
 *
 * Kept as an object (vs. a bare string) so we can extend later
 * (description, default body, ordering hints) without another migration.
 */
export interface DynamicContextSection {
  name: string;
}

/**
 * Dynamic Context — a switch on a single field's current value.
 *
 *  - Lives at agent level (`agent.dynamicContexts`), not inside any
 *    crew or addon. Authored once, consumed everywhere via the
 *    `{{dynamic:<fieldname>}}` token.
 *  - Resolution is O(1) at prompt-assembly time — no LLM call, no
 *    chain step, no addon to add. Pure deterministic lookup against
 *    the live memory value of the referenced field.
 *  - V1 is restricted to enum fields: each enum value gets a case.
 *    The editor surfaces enumValues automatically. Other field types
 *    can be added later if a real need shows up.
 */
export interface DynamicContextDef {
  id: ID;
  /** The field this dynamic context switches on. References
   *  `agent.fields[].id`. Renames cascade via the schema panel. */
  fieldId: ID;
  /** Section NAMES declared on this DC — the address space for
   *  `{{dynamic:FIELD:SECTION}}` tokens. Shared across every case:
   *  adding a section makes it referenceable under every value, even
   *  if some cases haven't authored a body for it yet. Each case fills
   *  in its body via `case.sectionTexts[name]`. */
  sections?: DynamicContextSection[];
  /** Per-value cases. For enum fields the editor pre-seeds one case
   *  per `field.enumValues` entry; extra cases are dropped on save. */
  cases: DynamicContextCase[];
  /** Text rendered when the field is unset or no case matches. Empty
   *  string when omitted — the token resolves to "" silently. */
  fallback?: string;
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
   * What to do with the rest of THIS turn's chain after a match:
   * - 'continue' (default) — remaining addons run normally. Talker
   *   (if downstream) speaks once more from the current crew. Next
   *   user turn lands on `target`.
   * - 'break' — remaining addons are skipped. No talker response
   *   this turn. Next user turn lands on `target`.
   */
  onMatch: 'continue' | 'break';
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
  | 'fields' | 'domains' | 'parameters' | 'dynamicContexts'
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
   * Agent-wide Dynamic Context definitions — `{{dynamic:<fieldname>}}`
   * lookups that swap text based on a memory field's current value.
   * Authored at the agent level (planned in advance, not in a crew
   * chain) and consumed automatically by the assembler — no addon
   * required. See {@link DynamicContextDef}.
   *
   * Optional for back-compat; readers should treat absence as `[]`.
   */
  dynamicContexts?: DynamicContextDef[];
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
