-- Migration 035: typed folders (Domain > Project). Add `kind` to
-- builder_workspaces: 'domain' (top-level org, holds projects/sub-domains)
-- or 'project' (leaf folder that holds agents). Agents may still live
-- anywhere (top / domain / project) — this only types the folders.
--
-- Backfill existing (untyped) folders non-destructively:
--   - has sub-folders          → 'domain'
--   - else has direct agents   → 'project'
--   - else (empty)             → 'domain'
-- Nothing is relocated; grandfathered "illegal" placements just stay.

ALTER TABLE builder_workspaces ADD COLUMN IF NOT EXISTS kind VARCHAR(20);

UPDATE builder_workspaces w SET kind = CASE
  WHEN EXISTS (SELECT 1 FROM builder_workspaces c WHERE c.parent_id = w.id) THEN 'domain'
  WHEN EXISTS (SELECT 1 FROM builder_agents a WHERE a.workspace_id = w.id) THEN 'project'
  ELSE 'domain'
END
WHERE kind IS NULL;
