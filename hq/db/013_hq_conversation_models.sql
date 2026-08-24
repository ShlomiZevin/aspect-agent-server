-- Per-conversation model overrides.
--
-- The employee's own model choices are her defaults, in `hq_workers`. These
-- three columns override them for ONE conversation, which is how people
-- actually work: you want the dear brain for the quarterly plan and the cheap
-- one for a quick question, without editing the employee each time.
--
-- NULL means "use her default" and is not the same as choosing the model that
-- happens to be her default today — if the default changes, a NULL follows it
-- and an explicit value does not.
ALTER TABLE hq_worker_conversations
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS phrasing_model TEXT;

COMMENT ON COLUMN hq_worker_conversations.model IS
  'Overrides the worker model for this conversation. NULL follows her default.';
COMMENT ON COLUMN hq_worker_conversations.phrasing_model IS
  'Overrides the phrasing model for this conversation. NULL follows her default.';
