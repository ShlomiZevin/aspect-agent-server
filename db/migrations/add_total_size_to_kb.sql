-- Add total_size column to knowledge_bases table
ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS total_size INTEGER DEFAULT 0;

-- Update existing rows to calculate total size from files
UPDATE knowledge_bases kb
SET total_size = COALESCE((
  SELECT SUM(file_size)
  FROM knowledge_base_files
  WHERE knowledge_base_id = kb.id
), 0);
