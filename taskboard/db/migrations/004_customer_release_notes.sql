-- 004_customer_release_notes.sql — release notes the customer sees (task #102).
--
-- A note lives ON the task, as it does on LYBI's board: a Hebrew headline and a
-- short Hebrew body. Shlomi marks which tasks are customer-relevant
-- (`customer_note`) and publishes them (`note_published_at`); the Intelligence
-- Center shows each customer user what was published since their last visit.
--
-- General only for now: a published note goes to every customer, and is written
-- without naming which customer asked for it. Per-customer targeting comes later,
-- once tasks carry which customer they belong to.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS customer_note     boolean      NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS note_headline     varchar(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS note_body         text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS note_published_at timestamptz;

-- The customer popup asks exactly this: published notes, newest first, after a
-- watermark. Partial, because almost no task is ever a published note.
CREATE INDEX IF NOT EXISTS tasks_note_published_idx ON tasks (note_published_at DESC)
  WHERE customer_note AND note_published_at IS NOT NULL;

-- One watermark per customer user: everything published after `seen_until` is
-- new for them. A user with no row has never been here — the first read creates
-- the row at "now", so a new user starts with nothing to catch up on.
-- `user_id` is the Intelligence Center's user id (anon_... or a signed-in id);
-- it lives in the platform DB, so there is no foreign key to it here.
CREATE TABLE IF NOT EXISTS customer_note_seen (
  user_id    varchar(100) PRIMARY KEY,
  seen_until timestamptz  NOT NULL,
  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT customer_note_seen_user_present CHECK (btrim(user_id) <> '')
);

DROP TRIGGER IF EXISTS customer_note_seen_touch ON customer_note_seen;
CREATE TRIGGER customer_note_seen_touch BEFORE UPDATE ON customer_note_seen
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
