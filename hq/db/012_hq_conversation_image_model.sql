-- Which image model this conversation uses.
--
-- Per conversation rather than per worker: what you want a picture to look like
-- changes with the brief, not with the employee. A quick draft chat wants the
-- cheap fast model; the chat where you are making the actual campaign wants the
-- dear one. Setting it on the worker would mean changing a global every time.
--
-- NULL means "let her choose", which is the default and is not the same as
-- picking a model — she reads the brief and decides.
ALTER TABLE hq_worker_conversations
  ADD COLUMN IF NOT EXISTS image_model TEXT;

COMMENT ON COLUMN hq_worker_conversations.image_model IS
  'Forced image model for this conversation. NULL means the worker chooses per brief.';
