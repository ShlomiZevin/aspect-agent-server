-- Migration 032: workspaces (folders) + agent archive.
--
-- Builder home page gains:
--   1. Workspaces — named folders to group agents. Global/shared for
--      now (owner_user_id is stored but NOT used to filter — matches
--      the rest of the builder during the no-auth build phase).
--   2. Agent archive — archived agents are hidden from the live grid
--      and blocked from running until restored.
--   3. Agent → workspace membership (nullable; null = top level).
--
-- All additions are nullable / IF NOT EXISTS so existing agents stay
-- top-level + live with no backfill.

CREATE TABLE IF NOT EXISTS builder_workspaces (
  id             VARCHAR(64)  PRIMARY KEY,
  owner_user_id  VARCHAR(64),
  name           TEXT         NOT NULL DEFAULT '',
  created_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP    NOT NULL DEFAULT NOW()
);

ALTER TABLE builder_agents ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(64);
ALTER TABLE builder_agents ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMP;

CREATE INDEX IF NOT EXISTS builder_agents_workspace_idx ON builder_agents (workspace_id);
CREATE INDEX IF NOT EXISTS builder_agents_archived_idx  ON builder_agents (archived_at);
