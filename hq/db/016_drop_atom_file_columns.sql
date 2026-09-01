-- Undo 015.
--
-- I added file columns to hq_atoms before reading the code properly: dropFile
-- already existed and already stores bytes in hq_media, linking the atom by its
-- stable /media/:id/file URL. These columns were never written to and never
-- read; leaving them would imply a second, competing place a file might live.
ALTER TABLE hq_atoms
  DROP COLUMN IF EXISTS file_path,
  DROP COLUMN IF EXISTS file_name,
  DROP COLUMN IF EXISTS file_mime,
  DROP COLUMN IF EXISTS file_bytes;
