-- Migration: Add is_published flag to crew_prompts
-- Description: Adds a second pointer separate from is_active so the
--              authenticated end-user chat (/<agent>/chat) can run a
--              "stable" version while admins keep iterating on isActive.
--
-- Backfill: mark the currently active version as published so nothing
-- changes for existing chats until someone explicitly publishes a
-- different version.

ALTER TABLE crew_prompts
ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false;

UPDATE crew_prompts
SET is_published = true
WHERE is_active = true;

-- Ensure at most one published version per (agent, crew_member_name).
CREATE UNIQUE INDEX IF NOT EXISTS uq_crew_prompts_one_published
ON crew_prompts (agent_id, crew_member_name)
WHERE is_published;
