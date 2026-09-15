-- Otto: edit-after-publish (task follow-up, 2026-09-15).
--
-- One published snapshot per app: captured at every publish, restored by
-- "Cancel changes". Editing a published app unpublishes it (status back to
-- 'ready') while the snapshot keeps the last published state — one-level
-- undo, which is exactly what "revert to the previous last saved state"
-- needs, without inventing a version history nothing asks for.
ALTER TABLE custom_modules
  ADD COLUMN IF NOT EXISTS published_state JSONB;
