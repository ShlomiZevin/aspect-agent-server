-- Migration: Add conversations.kind discriminator
-- Description: Adds a `kind` column to `conversations` so Alfred chats
--              (the in-builder AI helper) can share the same table as
--              user-facing chats. Default 'user' so existing rows keep
--              their semantics.
--
-- Values:
--   'user'   - regular agent conversation (legacy + builder previews)
--   'alfred' - chat with the Builder Helper (P5.1+)
--
-- See aspect-agent-server/docs/guides/BUILDER_V2_ALFRED.md.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'user';

CREATE INDEX IF NOT EXISTS conversations_kind_idx
  ON conversations (kind);
