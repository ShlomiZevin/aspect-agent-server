-- Migration 044: conversation activity stamps, for Builder V2 Triggers.
--
-- See docs/guides/BUILDER_V2_TRIGGERS.md.
--
-- The Silence trigger asks one question across every conversation of an
-- agent: "who hasn't heard from their customer in X?". Without a stamped
-- column that means MAX(messages.created_at) per conversation on every
-- tick -- a scan of the messages table once a minute, forever. With it,
-- the same question is a single index scan that returns a handful of rows
-- out of thousands. This column is the entire schema cost of making
-- triggers cheap.
--
-- TWO columns, because they answer different questions:
--   last_user_message_at -- the CUSTOMER's last word. This is what
--     "quiet for 30 minutes" means. A proactive nudge must NOT reset it,
--     or a customer silent for three days reads as silent for thirty
--     minutes the moment we nudge them, and every downstream number
--     (the explainer, {{tokens}} in a brief) inherits the lie.
--   last_message_at -- any activity at all, ours included. Useful for
--     ordering conversation lists and for future trigger types that care
--     about "nothing has happened here", not "they went quiet".
--
-- WHY A DATABASE TRIGGER AND NOT APPLICATION CODE
--
-- Messages are inserted from several places -- the V2 builder runtime,
-- the V1 conversation service, the WhatsApp bridge -- and more will
-- appear. A derived column that one writer forgets to stamp is worse
-- than no column: the trigger silently never fires for that channel, and
-- nothing errors. A row-level trigger cannot be forgotten by a future
-- caller, which is exactly the property this column needs.
--
-- It is deliberately dumb: two greatest() assignments, no branching
-- beyond the role check, no side effects. greatest() (rather than plain
-- assignment) makes it idempotent and safe against out-of-order or
-- backdated inserts.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at      timestamp;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_user_message_at timestamp;

-- Backfill from existing history. Guarded on IS NULL so re-running the
-- migration never clobbers stamps the trigger has since written.
UPDATE conversations c
   SET last_message_at = (
         SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id
       )
 WHERE c.last_message_at IS NULL;

UPDATE conversations c
   SET last_user_message_at = (
         SELECT MAX(m.created_at) FROM messages m
          WHERE m.conversation_id = c.id AND m.role = 'user'
       )
 WHERE c.last_user_message_at IS NULL;

-- Keep the stamps current on every future insert, from any writer.
CREATE OR REPLACE FUNCTION conversations_touch_activity() RETURNS trigger AS $$
BEGIN
  UPDATE conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, NEW.created_at), NEW.created_at),
         last_user_message_at = CASE
           WHEN NEW.role = 'user'
             THEN GREATEST(COALESCE(last_user_message_at, NEW.created_at), NEW.created_at)
           ELSE last_user_message_at
         END
   WHERE id = NEW.conversation_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_touch_conversation_activity ON messages;
CREATE TRIGGER messages_touch_conversation_activity
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION conversations_touch_activity();

-- The index the tick actually rides. Agent first (every trigger query is
-- scoped to one agent), then the stamp (the range predicate).
CREATE INDEX IF NOT EXISTS conversations_agent_last_user_msg_idx
  ON conversations (agent_id, last_user_message_at);

CREATE INDEX IF NOT EXISTS conversations_agent_last_msg_idx
  ON conversations (agent_id, last_message_at);
