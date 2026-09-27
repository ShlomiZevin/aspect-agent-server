-- 056: files attached to an agent's Spec (task #870).
--
-- The Spec is guidance for whoever builds the agent — the person, Alfred,
-- an outside assistant. It is never sent to the running agent. Files hang
-- off the AGENT (not a version): uploading one must not create "unsaved
-- changes" or be copied into every version, and removing one is final.
--
-- The original lives in GCS (`gcs_path`, prefix spec-files/); the text
-- extracted from it is kept here so Alfred and the Builder's AI door can
-- read it without downloading and parsing the file each time.

CREATE TABLE IF NOT EXISTS builder_spec_files (
  id              SERIAL PRIMARY KEY,
  agent_id        VARCHAR(64)  NOT NULL,
  file_name       VARCHAR(500) NOT NULL,
  mime_type       VARCHAR(200),
  file_size       INTEGER,
  gcs_path        TEXT,
  extracted_text  TEXT,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS builder_spec_files_agent_idx ON builder_spec_files (agent_id);
