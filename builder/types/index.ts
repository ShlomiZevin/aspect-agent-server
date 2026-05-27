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
 * Persona default OFF (user opts in). Memory reads default empty
 * (user opts in). History default = `last_n: 5`.
 */
export interface AddonContext {
  history: HistoryMode;
  /** Inject the agent persona into the prompt. Default off. */
  persona: boolean;
  /**
   * List of memory domains to inject. `null` denotes "(no domain)".
   * Empty list = no `## Memory` section in the prompt.
   */
  memoryReads: Array<string | null>;
  /**
   * List of *thinking* domains to inject — the brain's current plan
   * (Thinker writes). Parallel to `memoryReads` but reads from the
   * thinking section of the brain blob instead of the memory section.
   * `null` denotes "(no domain)". Empty list = no `## Thinking` block
   * in the prompt. Optional for backward compat with existing
   * instances stored before this feature; treated as `[]` when missing.
   */
  thinkingReads?: Array<string | null>;
  /**
   * List of *triggered* domains to inject — pre-scripted guidance the
   * Triggered Context addon loaded this turn (basal ganglia / procedural
   * memory in the brain metaphor). Parallel to memoryReads/thinkingReads
   * but reads from the `triggered` section of the brain blob.
   * `null` denotes "(no domain)". Empty = no `## Triggered` block.
   * Optional — treated as `[]` when missing.
   */
  triggeredReads?: Array<string | null>;
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
 * Placeholders the runtime substitutes when assembling a step's
 * prompt. Only things that go INTO the prompt belong here.
 * Conversation history and the latest user message are runtime
 * concerns sent to the LLM as separate parameters, not interpolated.
 */
export const KNOWN_PROMPT_PLACEHOLDERS = {
  /** The user-written prompt (`config.prompt`). */
  prompt: '{{prompt}}',
  /** Agent persona text. Empty string when `context.persona` is false. */
  persona: '{{persona}}',
  /** `## Memory` block built from `context.memoryReads`. Empty if none. */
  memory: '{{memory}}',
  /**
   * `## Thinking` block built from `context.thinkingReads`. Same shape
   * as `## Memory` but pulls from the brain's thinking section — where
   * the Thinker addon's writes land. Empty if no reads selected.
   */
  thinking: '{{thinking}}',
  /**
   * `## Triggered` block built from `context.triggeredReads`. Same
   * shape as `## Memory` but pulls from the brain's triggered section
   * — where the Triggered Context addon's matched-rule texts land.
   * Empty if no reads selected.
   */
  triggered: '{{triggered}}',
  /**
   * `## Field schema` block — fields with name, type, allowed enum
   * values, source, and description. Extractor plugins only.
   */
  fields_schema: '{{fields_schema}}',
  /**
   * `## Already collected` block — JSON map of current field values
   * (nulls included). Extractor plugins only.
   */
  fields_current: '{{fields_current}}',
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
 * Triggered Context — the hard-rule alternative to KB.
 *
 * Two rule shapes covering the two use cases:
 *
 *  - `switch`: "switch on field X — text A for value A, text B for B,
 *    text C for C". The dominant pattern. The user picks the field
 *    ONCE; each case carries its own contextText.
 *
 *  - `match`: full AND-of-conditions over memory (same vocabulary as
 *    Transition Router). For combinations like `intent=complaint
 *    AND mood=stubborn`. One condition list, one contextText.
 *
 * Each rule has ONE identifier that doubles as the memory key inside
 * `triggered.<domain>`:
 *  - Switch → `field` (the source field name). Writes to
 *    `triggered.<domain>.<field>`.
 *  - Match  → `name` (free-form short identifier the user types).
 *    Writes to `triggered.<domain>.<name>`. Empty falls back to
 *    `rule_<short-id>` so the rule still fires.
 *
 * No separate "label" field — the identifier IS the name. Multiple
 * matching rules writing to the same key concatenate with `\n\n`.
 * Domain is set once per addon instance (default `'triggered'`).
 *
 * Discriminator: `kind: 'switch' | 'match'`. No legacy fallback —
 * build-phase, no data to migrate.
 */
export interface TriggeredSwitchCase {
  /** The value `field` must equal for this case's text to fire.
   *  Stored as the same scalar shape the field can hold (string for
   *  enum/string, number-as-string for int, boolean for boolean). */
  value: string;
  /** Text injected when this case matches. */
  contextText: string;
}

export interface TriggeredSwitchRule {
  id: ID;
  kind: 'switch';
  /** The field this switch reads from. Doubles as the memory key:
   *  matched case texts land at `triggered.<domain>.<field>`. */
  field: string;
  /** Per-value cases. First match wins (a value should appear only
   *  once per switch — the editor enforces this). */
  cases: TriggeredSwitchCase[];
}

export interface TriggeredMatchRule {
  id: ID;
  kind: 'match';
  /** Short, free-form identifier the user types. Doubles as the
   *  memory key this rule writes to (`triggered.<domain>.<name>`).
   *  No slugification — what's typed is what lands. Empty falls
   *  back to `rule_<short-id>` server-side. */
  name: string;
  /** AND-of-conditions. ALL must match for the rule to fire. */
  conditions: TransitionCondition[];
  /** Text injected when the conditions all match. */
  contextText: string;
}

export type TriggeredRule = TriggeredSwitchRule | TriggeredMatchRule;

export interface TriggeredContextConfig {
  /** User-editable instance name shown on the chain card. */
  name?: string;
  /**
   * Where this loader writes its output in the brain's `triggered`
   * section. Defaults to `'triggered'`. Multiple Triggered Context
   * loaders in the same crew can write to different domains.
   */
  domain: string;
  rules: TriggeredRule[];
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
  'name' | 'slug' | 'spec' | 'persona' | 'defaultCrewId' | 'fields'
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
