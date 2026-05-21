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

const { pgTable, text, varchar, jsonb, timestamp, integer, uniqueIndex, index } = require('drizzle-orm/pg-core');

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

// Agent shell — identity + version pointers. The body fields
// (name, slug, spec, persona, defaultCrewId) live in
// builder_agent_versions and are recovered via the viewing pointer.
const builderAgents = pgTable('builder_agents', {
  id:               varchar('id', { length: 64 }).primaryKey(),
  projectId:        varchar('project_id', { length: 64 }).notNull(),
  slug:             varchar('slug', { length: 100 }).notNull(),
  activeVersionId:  varchar('active_version_id', { length: 64 }),
  viewingVersionId: varchar('viewing_version_id', { length: 64 }),
  createdAt:        timestamp('created_at').defaultNow().notNull(),
  updatedAt:        timestamp('updated_at').defaultNow().notNull(),
}, t => ({
  projectSlugUnique: uniqueIndex('builder_agents_project_slug_unique').on(t.projectId, t.slug),
  projectIdx:        index('builder_agents_project_idx').on(t.projectId),
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

module.exports = {
  builderProjects,
  builderAgents,
  builderAgentVersions,
  builderCrews,
  builderCrewVersions,
};
