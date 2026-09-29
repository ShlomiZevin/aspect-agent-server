-- 057: notes and files on a Targeted KB (task #871).
--
-- A place on each Targeted KB for the people building the agent — a
-- knowledge map: where each piece of knowledge came from, what overlaps.
-- NEVER sent to the running agent. Kept outside the versioned agent body
-- so writing a note doesn't make the agent "unsaved", isn't copied into
-- every version, and doesn't grow what Alfred re-emits on each edit.

-- Files reuse the Spec-files table (056): `scope` says what a file hangs
-- off, `ref_id` which Targeted KB (its enum id). Every existing row is a
-- Spec file.
ALTER TABLE builder_spec_files ADD COLUMN IF NOT EXISTS scope  VARCHAR(20) NOT NULL DEFAULT 'spec';
ALTER TABLE builder_spec_files ADD COLUMN IF NOT EXISTS ref_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS builder_spec_files_scope_idx ON builder_spec_files (agent_id, scope, ref_id);

CREATE TABLE IF NOT EXISTS builder_tkb_notes (
  agent_id    VARCHAR(64) NOT NULL,
  enum_id     VARCHAR(64) NOT NULL,
  notes       TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, enum_id)
);
