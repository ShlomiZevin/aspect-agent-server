-- Files a worker is GIVEN, as opposed to files a worker MAKES.
--
-- Deliberately not hq_media: that table is her output and feeds the Media
-- gallery. Brand guidelines sitting next to generated posters would make both
-- lists worse.
--
-- Two scopes, decided by conversation_id:
--   NULL  = her briefcase. In context for every message, forever.
--   set   = attached to one conversation, in context for that whole chat.
--
-- The briefcase requires a label because "here are three PDFs" is a much weaker
-- instruction than "this is the brand guide, follow it".
CREATE TABLE IF NOT EXISTS hq_worker_files (
  id                SERIAL PRIMARY KEY,
  worker_id         INTEGER NOT NULL REFERENCES hq_workers(id) ON DELETE CASCADE,
  conversation_id   INTEGER REFERENCES hq_worker_conversations(id) ON DELETE CASCADE,

  -- 'instructions' is read; 'reference' is looked at, and can be fed to
  -- Leonardo so brand colour is matched rather than approximated.
  kind              TEXT NOT NULL DEFAULT 'instructions',

  label             TEXT,
  filename          TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  bytes             INTEGER,

  -- Bytes live in GCS. The Anthropic file id is how the model sees a PDF as a
  -- real document rather than as flattened text; uploaded once, referenced by
  -- id on every turn.
  gcs_path          TEXT,
  anthropic_file_id TEXT,

  -- Extracted text serves two purposes: the token estimate shown in the UI,
  -- and the voice model, which cannot read Claude document blocks and has to be
  -- briefed in plain text.
  extracted_text    TEXT,
  token_estimate    INTEGER,

  -- Set once the image has been registered with Leonardo as a style reference.
  leonardo_ref_id   TEXT,

  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hq_worker_files_briefcase
  ON hq_worker_files (worker_id) WHERE conversation_id IS NULL;
CREATE INDEX IF NOT EXISTS hq_worker_files_conversation
  ON hq_worker_files (conversation_id);
