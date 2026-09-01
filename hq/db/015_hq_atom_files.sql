-- A file dropped into HQ, kept whole.
--
-- Until now a drop became TEXT: a Notion page or a URL was read, chunked and
-- indexed, and the original was somebody else's to store. That works for
-- documents and not at all for a logo, where the thing you want back is the
-- file itself rather than a description of it.
--
-- So an atom can now own bytes. The description you type at drop time becomes
-- the atom's body, which is what makes it findable — an image carries no text
-- of its own, so search has nothing to work with unless a person supplies it.
ALTER TABLE hq_atoms
  ADD COLUMN IF NOT EXISTS file_path TEXT,
  ADD COLUMN IF NOT EXISTS file_name TEXT,
  ADD COLUMN IF NOT EXISTS file_mime TEXT,
  ADD COLUMN IF NOT EXISTS file_bytes INTEGER;

COMMENT ON COLUMN hq_atoms.file_path IS
  'GCS object holding the original file. NULL for text-only atoms.';

CREATE INDEX IF NOT EXISTS hq_atoms_with_file ON hq_atoms (id) WHERE file_path IS NOT NULL;
