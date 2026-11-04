-- Files attached to a task on the LYBI board (task #954).
--
-- Kept in the database, like the images pasted into descriptions, rather
-- than in cloud storage: an environment then needs nothing beyond its
-- database for the board (Lybi Staging has no storage bucket). Capped at
-- 25 MB a file in services/taskAttachments.service.js.
CREATE TABLE IF NOT EXISTS task_attachments (
  id           SERIAL PRIMARY KEY,
  task_id      INTEGER      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_name    TEXT         NOT NULL,
  mime_type    TEXT         NOT NULL DEFAULT 'application/octet-stream',
  size_bytes   INTEGER      NOT NULL,
  data         BYTEA        NOT NULL,
  uploaded_by  VARCHAR(100),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_attachments_task_idx ON task_attachments (task_id);
