-- Migration 053: task board release flow (task #837)
-- done_at            — when the task last moved to Done (cleared when it leaves Done)
-- not_for_release    — excluded from the Release list (cleared when it leaves Done)
-- what_changed       — plain-language note by the assignee: what changed, what to check
-- whats_new_headline — one line shown in the What's New popup
-- task_assignees.seen_until — per-person What's New watermark; NULL = no popup
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS done_at TIMESTAMP;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS not_for_release BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS what_changed TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS whats_new_headline VARCHAR(255);
ALTER TABLE task_assignees ADD COLUMN IF NOT EXISTS seen_until TIMESTAMP;
