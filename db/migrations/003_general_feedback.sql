-- Migration: allow feedback that is not attached to a specific message
-- Table: message_feedback
-- Date: 2026-08-19
--
-- WHY. message_feedback was built for reviewers annotating one assistant reply,
-- so assistant_message_id is NOT NULL and the owning agent is only reachable by
-- walking message -> conversation -> agent. "Leave feedback whenever you like"
-- has no message to hang off, and no way to say which portal it came from.
--
-- Rather than a second table, the same row shape is reused with the message
-- link made optional and the agent recorded directly. That keeps one feedback
-- inbox, one tag registry and one stats query instead of two of each.

ALTER TABLE message_feedback ALTER COLUMN assistant_message_id DROP NOT NULL;

-- Recorded directly so general feedback knows which portal it came from, and
-- so every feedback query can filter on one column instead of a three-table
-- join. Backfilled below for existing rows.
ALTER TABLE message_feedback ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id);

-- 'message' = annotation on a specific reply (everything that existed before)
-- 'general' = volunteered from the sidebar, not about one reply
ALTER TABLE message_feedback ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'message';

-- Free-text contact left by the user, so someone can follow up on a complaint.
-- Optional by design: demanding it suppresses the feedback we most want.
ALTER TABLE message_feedback ADD COLUMN IF NOT EXISTS contact VARCHAR(200);

-- The page the user was on. Cheap to capture, and the single most useful piece
-- of context when a report says "this looks wrong" with no message attached.
ALTER TABLE message_feedback ADD COLUMN IF NOT EXISTS context_url TEXT;

-- Backfill agent_id for existing message-scoped rows so the new column is
-- authoritative for every row, not just new ones.
UPDATE message_feedback mf
   SET agent_id = c.agent_id
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
 WHERE mf.assistant_message_id = m.id
   AND mf.agent_id IS NULL;

-- A row must be attributable to something: either the message it annotates or
-- the agent it was volunteered against. Without this, a bug that dropped both
-- would produce orphan feedback that no inbox ever shows.
ALTER TABLE message_feedback DROP CONSTRAINT IF EXISTS message_feedback_attributable;
ALTER TABLE message_feedback ADD CONSTRAINT message_feedback_attributable
  CHECK (assistant_message_id IS NOT NULL OR agent_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_message_feedback_agent_created
  ON message_feedback(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_feedback_source
  ON message_feedback(source);
