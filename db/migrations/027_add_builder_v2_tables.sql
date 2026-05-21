-- Migration: Add V2 builder tables
-- Description: Creates the 5 builder_* tables that back the JSON-based
--              plugin agent builder (BUILDER_V2). Coexists with the
--              legacy `agents` / `crew_members` tables (v1 chats).
--
-- Tables:
--   builder_projects         - top-level project (owner + metadata)
--   builder_agents           - agent shell + active/viewing pointers
--   builder_agent_versions   - agent body snapshots (jsonb)
--   builder_crews            - crew shell + active/viewing pointers
--   builder_crew_versions    - crew body snapshots (jsonb)
--
-- Identity: text/varchar primary keys (client-generated ids like
-- 'crew_xxx', 'agent_xxx', 'ver_xxx').
-- Body shape: see AgentBody / CrewBody types on the client.

CREATE TABLE IF NOT EXISTS builder_projects (
  id              VARCHAR(64) PRIMARY KEY,
  owner_user_id   VARCHAR(64) NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  spec            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS builder_projects_owner_idx
  ON builder_projects (owner_user_id);

CREATE TABLE IF NOT EXISTS builder_agents (
  id                  VARCHAR(64) PRIMARY KEY,
  project_id          VARCHAR(64) NOT NULL,
  slug                VARCHAR(100) NOT NULL,
  active_version_id   VARCHAR(64),
  viewing_version_id  VARCHAR(64),
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_agents_project_slug_unique
  ON builder_agents (project_id, slug);

CREATE INDEX IF NOT EXISTS builder_agents_project_idx
  ON builder_agents (project_id);

CREATE TABLE IF NOT EXISTS builder_agent_versions (
  id            VARCHAR(64) PRIMARY KEY,
  agent_id      VARCHAR(64) NOT NULL,
  number        INTEGER NOT NULL,
  description   TEXT,
  body          JSONB NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_agent_versions_agent_number_unique
  ON builder_agent_versions (agent_id, number);

CREATE INDEX IF NOT EXISTS builder_agent_versions_agent_idx
  ON builder_agent_versions (agent_id);

CREATE TABLE IF NOT EXISTS builder_crews (
  id                  VARCHAR(64) PRIMARY KEY,
  agent_id            VARCHAR(64) NOT NULL,
  active_version_id   VARCHAR(64),
  viewing_version_id  VARCHAR(64),
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS builder_crews_agent_idx
  ON builder_crews (agent_id);

CREATE TABLE IF NOT EXISTS builder_crew_versions (
  id            VARCHAR(64) PRIMARY KEY,
  crew_id       VARCHAR(64) NOT NULL,
  number        INTEGER NOT NULL,
  description   TEXT,
  body          JSONB NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS builder_crew_versions_crew_number_unique
  ON builder_crew_versions (crew_id, number);

CREATE INDEX IF NOT EXISTS builder_crew_versions_crew_idx
  ON builder_crew_versions (crew_id);
