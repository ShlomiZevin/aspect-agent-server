-- Migration 034: nested folders. Add a self-referential parent to
-- builder_workspaces so a workspace can live inside another workspace
-- (unlimited depth). `parent_id` NULL = top level. Existing workspaces
-- stay top-level (NULL) with no backfill.

ALTER TABLE builder_workspaces ADD COLUMN IF NOT EXISTS parent_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS builder_workspaces_parent_idx ON builder_workspaces (parent_id);
