-- Migration 036: re-normalize folder kinds to the finalized hierarchy.
--   Top level (no parent)              → 'domain'   (top can only be a domain)
--   Direct child of a top-level folder → 'project'  (second level is a project)
--   Anything deeper (parent not top)   → 'folder'   (generic sub-folders below a project)
--
-- Fixes the earlier heuristic (e.g. a top-level folder with agents like
-- "Shlomi" was mis-typed as a project). Non-destructive: only the `kind`
-- label changes; nothing is moved or deleted.

UPDATE builder_workspaces SET kind = 'domain'
WHERE parent_id IS NULL;

UPDATE builder_workspaces SET kind = 'project'
WHERE parent_id IN (SELECT id FROM builder_workspaces WHERE parent_id IS NULL);

UPDATE builder_workspaces SET kind = 'folder'
WHERE parent_id IS NOT NULL
  AND parent_id NOT IN (SELECT id FROM builder_workspaces WHERE parent_id IS NULL);
