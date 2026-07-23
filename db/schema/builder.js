/**
 * Builder V2 schema — the JSON-based agent builder.
 *
 * Five tables, prefixed `builder_*` to avoid clashing with the
 * legacy `agents` / `crews` tables (which power v1 customer-facing
 * chats). The two systems coexist.
 *
 * Identity: text primary keys. The client generates ids
 * (`crew_xxx`, `agent_xxx`, `ver_xxx`, …) and the server stores
 * them as-is. This matches the client's `uid()` helper.
 *
 * Bodies: jsonb where the shape evolves (agent_versions.body,
 * crew_versions.body — see `AgentBody` / `CrewBody` types on the
 * client). Plain columns for stable metadata.
 *
 * Versioning: each entity has a shell row holding identity +
 * pointers (active / viewing), and a sibling _versions table that
 * holds the bodies. See BUILDER_V2_RUNTIME_PLAN.md for the data
 * model rationale.
 */

const { pgTable, text, varchar, jsonb, timestamp, integer, serial, uniqueIndex, index } = require('drizzle-orm/pg-core');

// Top-level project. Just metadata; no JSON body (project-level
// fields are stable for now: name + spec).
const builderProjects = pgTable('builder_projects', {
  id:           varchar('id', { length: 64 }).primaryKey(),
  ownerUserId:  varchar('owner_user_id', { length: 64 }).notNull(),
  name:         text('name').notNull().default(''),
  spec:         text('spec').notNull().default(''),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
}, t => ({
  ownerIdx: index('builder_projects_owner_idx').on(t.ownerUserId),
}));

// Workspace — a named folder grouping agents. Global/shared for now
// (owner_user_id stored but not used to filter during the no-auth
// build phase, same as builder_projects).
const builderWorkspaces = pgTable('builder_workspaces', {
  id:           varchar('id', { length: 64 }).primaryKey(),
  ownerUserId:  varchar('owner_user_id', { length: 64 }),
  name:         text('name').notNull().default(''),
  // Self-reference for nested folders. null = top level.
  parentId:     varchar('parent_id', { length: 64 }),
  // Typed folder: 'domain' (top-level org, holds projects) or 'project'
  // (leaf folder that holds agents). Agents may still live anywhere.
  kind:         varchar('kind', { length: 20 }),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
}, t => ({
  parentIdx: index('builder_workspaces_parent_idx').on(t.parentId),
}));

// Agent shell — identity + version pointers. The body fields
// (name, slug, spec, persona, defaultCrewId) live in
// builder_agent_versions and are recovered via the viewing pointer.
//
// `workspaceId` (nullable, null = top level) groups the agent under a
// builder_workspaces folder. `archivedAt` (nullable, null = live)
// hides the agent from the live grid AND blocks it from running.
const builderAgents = pgTable('builder_agents', {
  id:               varchar('id', { length: 64 }).primaryKey(),
  projectId:        varchar('project_id', { length: 64 }).notNull(),
  slug:             varchar('slug', { length: 100 }).notNull(),
  workspaceId:      varchar('workspace_id', { length: 64 }),
  archivedAt:       timestamp('archived_at'),
  activeVersionId:  varchar('active_version_id', { length: 64 }),
  viewingVersionId: varchar('viewing_version_id', { length: 64 }),
  // Customer-facing pointer, decoupled from `activeVersionId` (the
  // builder/admin marker). The public runtime (version:'published')
  // resolves this, falling back to active→viewing when null, so
  // customers never see an unpublished draft. Moved only by an
  // explicit Publish action.
  publishedVersionId: varchar('published_version_id', { length: 64 }),
  createdAt:        timestamp('created_at').defaultNow().notNull(),
  updatedAt:        timestamp('updated_at').defaultNow().notNull(),
}, t => ({
  projectSlugUnique: uniqueIndex('builder_agents_project_slug_unique').on(t.projectId, t.slug),
  projectIdx:        index('builder_agents_project_idx').on(t.projectId),
  workspaceIdx:      index('builder_agents_workspace_idx').on(t.workspaceId),
  archivedIdx:       index('builder_agents_archived_idx').on(t.archivedAt),
}));

// Agent version body. Each row = one snapshot of the agent shell.
// body shape: AgentBody = { name, slug, spec, persona, defaultCrewId? }
const builderAgentVersions = pgTable('builder_agent_versions', {
  id:           varchar('id', { length: 64 }).primaryKey(),
  agentId:      varchar('agent_id', { length: 64 }).notNull(),
  number:       integer('number').notNull(),
  description:  text('description'),
  body:         jsonb('body').notNull(),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
}, t => ({
  agentNumberUnique: uniqueIndex('builder_agent_versions_agent_number_unique').on(t.agentId, t.number),
  agentIdx:          index('builder_agent_versions_agent_idx').on(t.agentId),
}));

// Crew shell — identity + version pointers + FK to its agent.
// Crew membership lives in the FK, NOT inside agent_versions.body.
const builderCrews = pgTable('builder_crews', {
  id:               varchar('id', { length: 64 }).primaryKey(),
  agentId:          varchar('agent_id', { length: 64 }).notNull(),
  activeVersionId:  varchar('active_version_id', { length: 64 }),
  viewingVersionId: varchar('viewing_version_id', { length: 64 }),
  // Customer-facing pointer — see builderAgents.publishedVersionId.
  // Published per-crew so a crew can stay on its live version while
  // the agent shell or a sibling crew is being iterated.
  publishedVersionId: varchar('published_version_id', { length: 64 }),
  // Author-controlled sidebar order. Nullable so existing crews sort
  // by createdAt until first dragged; hydrate uses `position NULLS
  // LAST, createdAt`. Purely visual — the starting crew is the agent's
  // defaultCrewId, and transitions drive the rest.
  position:         integer('position'),
  createdAt:        timestamp('created_at').defaultNow().notNull(),
  updatedAt:        timestamp('updated_at').defaultNow().notNull(),
}, t => ({
  agentIdx: index('builder_crews_agent_idx').on(t.agentId),
}));

// Crew version body. Each row = one snapshot of the crew shell.
// body shape: CrewBody = { name, description?, spec, persona?, addons[] }
const builderCrewVersions = pgTable('builder_crew_versions', {
  id:           varchar('id', { length: 64 }).primaryKey(),
  crewId:       varchar('crew_id', { length: 64 }).notNull(),
  number:       integer('number').notNull(),
  description:  text('description'),
  body:         jsonb('body').notNull(),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
}, t => ({
  crewNumberUnique: uniqueIndex('builder_crew_versions_crew_number_unique').on(t.crewId, t.number),
  crewIdx:          index('builder_crew_versions_crew_idx').on(t.crewId),
}));

// addon_runs — one row per addon execution. Stores the same payload
// shape as the live SSE `addon.output` event so the historical view
// can rehydrate cards identically. FK kept loose (varchar to legacy
// conversations id, plain message id) to avoid cross-table coupling
// during early iteration.
const addonRuns = pgTable('addon_runs', {
  id:               varchar('id', { length: 64 }).primaryKey(),
  conversationId:   integer('conversation_id').notNull(),
  messageId:        integer('message_id'), // assistant message this run belongs to
  instanceId:       varchar('instance_id', { length: 64 }).notNull(),
  pluginId:         varchar('plugin_id', { length: 100 }).notNull(),
  status:           varchar('status', { length: 20 }).notNull(),  // running | success | error
  startedAt:        timestamp('started_at').notNull(),
  endedAt:          timestamp('ended_at'),
  durationMs:       integer('duration_ms'),
  runData:          jsonb('run_data').notNull(), // mirrors the SSE addon.output payload
  createdAt:        timestamp('created_at').defaultNow().notNull(),
}, t => ({
  conversationIdx: index('addon_runs_conversation_idx').on(t.conversationId),
  messageIdx:      index('addon_runs_message_idx').on(t.messageId),
}));

// Repo entries — shared library of reusable prompt strings (and, in
// the future, whole addon configs). One table for both shapes so the
// future addon-repo work doesn't need a schema migration; the `kind`
// column tells consumers what's in `content`.
//
//   kind = 'prompt' → content = { "prompt": "<string>" }
//   kind = 'addon'  → content = the AddonInstance config blob (future)
//
// Built-in defaults are NOT stored here — they're synthesised on the
// client from the live `@addons/*.addon.json` imports so updating an
// addon descriptor's `defaultConfig.prompt` lands automatically with
// no DB migration. This table only holds USER-saved entries.
//
// `ownerUserId` is null for "global" entries (the current default
// behaviour — everyone in this workspace sees them). Once per-user
// scoping is needed we just start writing the value and add an OR
// filter on read.
const repoEntries = pgTable('repo_entries', {
  id:           varchar('id', { length: 64 }).primaryKey(),
  kind:         varchar('kind', { length: 20 }).notNull(),
  pluginId:     varchar('plugin_id', { length: 100 }).notNull(),
  name:         text('name').notNull(),
  content:      jsonb('content').notNull(),
  ownerUserId:  varchar('owner_user_id', { length: 64 }),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
}, t => ({
  kindPluginIdx: index('repo_entries_kind_plugin_idx').on(t.kind, t.pluginId),
}));

// kb_links — KB↔agent visibility links (many-to-many). A KB is a
// Pinecone namespace (global in the shared index); this table records
// which builder agents a namespace is "related to" so the builder only
// surfaces the relevant KBs per agent. Pure visibility — no owner, no
// shared flag; a KB is visible to an agent iff a link row exists.
// Duplicating an agent copies its link rows so the clone sees the same
// KBs without copying any vectors. See KB_V2 docs.
const kbLinks = pgTable('kb_links', {
  id:         serial('id').primaryKey(),
  indexName:  varchar('index_name', { length: 255 }).notNull(),
  namespace:  varchar('namespace', { length: 255 }).notNull(),
  agentId:    varchar('agent_id', { length: 64 }).notNull(),
  createdAt:  timestamp('created_at').defaultNow().notNull(),
}, t => ({
  unique:    uniqueIndex('kb_links_unique').on(t.indexName, t.namespace, t.agentId),
  agentIdx:  index('kb_links_agent_idx').on(t.agentId),
  nsIdx:     index('kb_links_ns_idx').on(t.indexName, t.namespace),
}));

module.exports = {
  builderProjects,
  builderWorkspaces,
  builderAgents,
  builderAgentVersions,
  builderCrews,
  builderCrewVersions,
  addonRuns,
  repoEntries,
  kbLinks,
};
