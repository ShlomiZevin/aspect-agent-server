-- Files a user attaches in chat (task #100): "here is a file — build me data
-- like this, by its structure". Generic: any agent, any readable format.
--
-- `digest` is what the model reads — a structural description (sheets,
-- headers, per-column formulas, sample + capped data) or extracted text; it is
-- also embedded in the user's saved message, so later turns of the same
-- conversation still see the file. `content` keeps the original bytes so a
-- spreadsheet can be filled back in its OWN structure (same headers, column
-- order and formulas) — see chat-attachments.service.fillTemplate.
CREATE TABLE IF NOT EXISTS chat_attachments (
  id                       TEXT PRIMARY KEY,          -- 'att_<random>'
  agent_name               TEXT,
  conversation_external_id TEXT,
  user_external_id         TEXT,
  filename                 TEXT NOT NULL,
  mime_type                TEXT,
  size_bytes               INTEGER NOT NULL,
  -- spreadsheet | pdf | document | text | image
  kind                     TEXT NOT NULL,
  digest                   TEXT NOT NULL,
  meta                     JSONB,                     -- structured layout (sheets, header rows, columns, formulas)
  content                  BYTEA NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_attachments_conversation_idx
  ON chat_attachments (conversation_external_id);
